const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { prepareVision, assertVisionPolicy, POLICY } = require('../src/runtime/bounded-vision');
const pin = bytes => ({ bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
// Independent bit-by-bit fixture CRC, intentionally not the runtime table implementation.
function chunk(type, data) {
  const name = Buffer.isBuffer(type) ? type : Buffer.from(type);
  const body = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, body, checksum]);
}
function png({ width = 1, height = 1, color = 6, depth = 8, interlace = 0,
  raw = Buffer.from([0, 255, 0, 0, 255]), extra = [], compressed, end = true } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = depth; header[9] = color; header[12] = interlace;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    ...extra, chunk('IDAT', compressed || zlib.deflateSync(raw)), ...(end ? [chunk('IEND', Buffer.alloc(0))] : [])]);
}
test('valid PNG bytes are copied and only digest and dimensions become receipt metadata', () => {
  for (const [color, channels] of [[0, 1], [2, 3], [4, 2], [6, 4]]) {
    const image = pin(png({ color, raw: Buffer.alloc(channels + 1) }));
    const result = prepareVision(image, POLICY.model);
    assert.deepEqual(result.receipt, { sha256: image.sha256, byteLength: image.bytes.length, width: 1, height: 1 });
    assert.ok(Object.isFrozen(result.receipt));
    image.bytes.fill(0);
    assert.notEqual(result.bytes[0], 0);
  }
});
test('paths, URLs, multiple images, shared memory, excess fields and bad digests are refused', () => {
  const good = pin(png());
  for (const image of [null, 'https://example.com/image.png', '/tmp/image.png', [good],
    { ...good, path: '/tmp/image.png' }, { ...good, bytes: new Uint8Array(good.bytes) },
    { ...good, bytes: Buffer.from(new SharedArrayBuffer(good.bytes.length)) },
    { ...good, sha256: 'X'.repeat(64) }]) {
    assert.throws(() => prepareVision(image, POLICY.model), { code: 'BOUNDED_INVALID_IMAGE' });
  }
  assert.throws(() => prepareVision({ ...good, sha256: '0'.repeat(64) }, POLICY.model), { code: 'BOUNDED_IMAGE_HASH_MISMATCH' });
  for (const bytes of [Buffer.alloc(20), Buffer.alloc(POLICY.maxBytes + 1)]) {
    assert.throws(() => prepareVision(pin(bytes), POLICY.model), { code: 'BOUNDED_IMAGE_SIZE' });
  }
});
test('corrupt, oversized, animated, truncated and unsupported PNG inputs fail validation', () => {
  const corrupt = png(); corrupt[corrupt.length - 1] ^= 1;
  for (const bytes of [corrupt, png({ end: false }), Buffer.concat([png(), Buffer.from([0])]),
    png({ width: 2049 }), png({ height: 0 }), png({ depth: 16 }), png({ color: 3 }), png({ interlace: 1 }),
    png({ extra: [chunk('acTL', Buffer.alloc(8))] }),
    png({ raw: Buffer.from([5, 0, 0, 0, 0]) }), png({ raw: Buffer.alloc(4) }),
    png({ raw: Buffer.alloc(1024 * 1024) }),
    png({ compressed: Buffer.concat([zlib.deflateSync(Buffer.alloc(5)), Buffer.from([0])]) })]) {
    assert.throws(() => prepareVision(pin(bytes), POLICY.model), /BOUNDED_/);
  }
});
test('PNG chunk names must be actual ASCII letters with the reserved bit clear', () => {
  for (const type of [Buffer.from([0xf4, 0x45, 0x58, 0x74]), Buffer.from('texT')]) {
    assert.throws(() => prepareVision(pin(png({ extra: [chunk(type, Buffer.alloc(0))] })), POLICY.model),
      { code: 'BOUNDED_INVALID_PNG' });
  }
});
test('only the reviewed current model and conservative prices provide an image bound', () => {
  for (const model of ['gpt-5-mini', 'gpt-4.1-mini', 'gpt-5.4-mini-2026-03-17']) {
    assert.throws(() => assertVisionPolicy(model), { code: 'BOUNDED_IMAGE_BOUND_UNAVAILABLE' });
  }
  for (const pricing of [{ input_usd: 0.74, output_usd: 4.5 }, { input_usd: 0.75, output_usd: 4.49 }]) {
    assert.throws(() => assertVisionPolicy(POLICY.model, pricing), { code: 'BOUNDED_IMAGE_PRICE_UNVERIFIED' });
  }
  assert.equal(assertVisionPolicy(POLICY.model, { input_usd: 0.75, output_usd: 4.5 }).imageInputTokenUpperBound, 3001);
  const now = Date.now;
  try {
    Date.now = () => POLICY.expiresAt;
    assert.throws(() => prepareVision(pin(png()), POLICY.model), { code: 'BOUNDED_IMAGE_BOUND_UNAVAILABLE' });
  } finally { Date.now = now; }
});
