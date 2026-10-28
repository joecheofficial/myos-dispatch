const crypto = require('node:crypto');
const zlib = require('node:zlib');

// Reviewed against official OpenAI image/model docs on 2026-10-14. No caller overrides.
const POLICY = Object.freeze({ id: 'openai-gpt54mini-high-20261014', model: 'gpt-5.4-mini',
  detail: 'high', imageInputTokenUpperBound: 3001, inputUsdPerMillion: 0.75,
  outputUsdPerMillion: 4.5, expiresAt: Date.parse('2026-11-14T00:00:00Z'),
  maxBytes: 8 * 1024 * 1024, maxDimension: 2048 });
const fail = code => { throw Object.assign(new Error(code), { code }); };
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function assertVisionPolicy(model, pricing) {
  if (model !== POLICY.model || Date.now() >= POLICY.expiresAt) fail('BOUNDED_IMAGE_BOUND_UNAVAILABLE');
  if (pricing && (!(pricing.input_usd >= POLICY.inputUsdPerMillion) ||
      !(pricing.output_usd >= POLICY.outputUsdPerMillion))) fail('BOUNDED_IMAGE_PRICE_UNVERIFIED');
  return POLICY;
}

function inspectPng(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) fail('BOUNDED_INVALID_PNG');
  let offset = 8, width, height, channels, ended = false, idatEnded = false, chunks = 0;
  const compressed = [];
  while (offset < bytes.length) {
    if (++chunks > 1024 || offset + 12 > bytes.length) fail('BOUNDED_INVALID_PNG');
    const length = bytes.readUInt32BE(offset), end = offset + length + 12;
    if (end > bytes.length) fail('BOUNDED_INVALID_PNG');
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) {
      fail('BOUNDED_INVALID_PNG');
    }
    const data = bytes.subarray(offset + 8, end - 4);
    if (chunks === 1 && type !== 'IHDR') fail('BOUNDED_INVALID_PNG');
    if (['acTL', 'fcTL', 'fdAT'].includes(type)) fail('BOUNDED_ANIMATED_PNG');
    if (type === 'IHDR') {
      if (chunks !== 1 || length !== 13) fail('BOUNDED_INVALID_PNG');
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[data[9]];
      if (!width || !height || width > POLICY.maxDimension || height > POLICY.maxDimension) fail('BOUNDED_IMAGE_DIMENSIONS');
      if (data[8] !== 8 || !channels || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) fail('BOUNDED_PNG_FORMAT_UNSUPPORTED');
    } else if (type === 'IDAT') {
      if (idatEnded) fail('BOUNDED_INVALID_PNG');
      compressed.push(data);
    } else if (type === 'IEND') {
      if (length || !compressed.length || end !== bytes.length) fail('BOUNDED_INVALID_PNG');
      ended = true;
    } else {
      if (type[0] === type[0].toUpperCase()) fail('BOUNDED_PNG_FORMAT_UNSUPPORTED');
      if (compressed.length) idatEnded = true;
    }
    offset = end;
  }
  if (!ended) fail('BOUNDED_INVALID_PNG');
  const rowSize = width * channels + 1, expected = rowSize * height;
  try {
    const data = Buffer.concat(compressed);
    const decoded = zlib.inflateSync(data, { maxOutputLength: expected, info: true });
    if (decoded.buffer.length !== expected || decoded.engine.bytesWritten !== data.length) fail('BOUNDED_INVALID_PNG');
    for (let row = 0; row < height; row++) if (decoded.buffer[row * rowSize] > 4) fail('BOUNDED_INVALID_PNG');
  } catch { fail('BOUNDED_INVALID_PNG'); }
  return { width, height };
}

function prepareVision(image, model) {
  assertVisionPolicy(model);
  return snapshotPng(image);
}

// Byte validation is transport-independent; API pricing/model policy stays above.
function snapshotPng(image) {
  if (!image || typeof image !== 'object' || Array.isArray(image) ||
      Object.keys(image).some(key => !['bytes', 'sha256'].includes(key)) ||
      !Buffer.isBuffer(image.bytes) || image.bytes.buffer instanceof SharedArrayBuffer ||
      !/^[a-f0-9]{64}$/.test(image.sha256)) fail('BOUNDED_INVALID_IMAGE');
  if (image.bytes.length < 57 || image.bytes.length > POLICY.maxBytes) fail('BOUNDED_IMAGE_SIZE');
  const bytes = Buffer.from(image.bytes);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== image.sha256) fail('BOUNDED_IMAGE_HASH_MISMATCH');
  const size = inspectPng(bytes);
  return { bytes, receipt: Object.freeze({ sha256, byteLength: bytes.length, ...size }) };
}

module.exports = { prepareVision, snapshotPng, assertVisionPolicy, POLICY };
