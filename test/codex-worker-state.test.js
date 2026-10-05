const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const stateModulePath = require.resolve("../src/background/codex-worker-state");

function withTempHome(fn) {
  const originalHome = process.env.HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-worker-state-"));
  process.env.HOME = tempHome;
  delete require.cache[stateModulePath];
  const state = require("../src/background/codex-worker-state");

  try {
    return fn(state, tempHome);
  } finally {
    process.env.HOME = originalHome;
    delete require.cache[stateModulePath];
  }
}

test("detectPauseCondition identifies usage-limit pauses and parses retry delay", () => {
  withTempHome((state) => {
    const result = state.detectPauseCondition({
      parsed: { errorMessage: "Usage limit reached. Try again in 5 hours 30 minutes." },
      stderr: "",
      stdout: "",
      fallbackError: "",
    });

    assert.equal(result.isPaused, true);
    assert.equal(result.reason, "usage_limit");
    assert.equal(result.retryDelayMs, (5 * 60 + 30) * 60 * 1000);
  });
});

test("listDuePausedSessions returns only paused sessions whose retry window has arrived", () => {
  withTempHome((state) => {
    const dueState = state.buildBaseState({ taskId: "due-task" });
    dueState.status = "paused";
    dueState.retry.next_retry_at = "2026-04-05T00:00:00.000Z";
    state.writeSessionState(dueState);

    const futureState = state.buildBaseState({ taskId: "future-task" });
    futureState.status = "paused";
    futureState.retry.next_retry_at = "2026-04-06T00:00:00.000Z";
    state.writeSessionState(futureState);

    const due = state.listDuePausedSessions(new Date("2026-04-05T12:00:00.000Z"));
    assert.equal(due.length, 1);
    assert.equal(due[0].task_id, "due-task");
  });
});

test("an interrupted checkpoint write preserves the previous recoverable state", () => {
  withTempHome((state) => {
    const previous = state.writeSessionState(state.buildBaseState({ taskId: "atomic-task" }));
    const writeFileSync = fs.writeFileSync;
    try {
      fs.writeFileSync = (target) => {
        writeFileSync(target, '{"partial":');
        throw new Error("simulated interrupted write");
      };
      assert.throws(() => state.writeSessionState({ ...previous, status: "paused" }), /interrupted write/);
    } finally {
      fs.writeFileSync = writeFileSync;
    }
    assert.deepEqual(state.readSessionState(previous.task_id), previous);
    assert.deepEqual(fs.readdirSync(state.SESSION_DIR), ["atomic-task.json"]);
  });
});

test("event append flushes its bytes before reporting success", () => {
  withTempHome((state) => {
    const fsyncSync = fs.fsyncSync;
    const synced = [];
    try {
      fs.fsyncSync = (fd) => {
        synced.push(fs.fstatSync(fd).isFile() ? "file" : "directory");
        return fsyncSync(fd);
      };
      const event = state.appendEvent({ type: "session.paused", task_id: "durable-event" });
      assert.deepEqual(JSON.parse(fs.readFileSync(state.EVENT_LOG_PATH, "utf8")), event);
      assert.deepEqual(synced, ["file", "directory"]);
    } finally {
      fs.fsyncSync = fsyncSync;
    }
  });
});

test("checkpoint promotion follows file flush and preserves state when promotion fails", () => {
  withTempHome((state) => {
    const previous = state.writeSessionState(state.buildBaseState({ taskId: "promotion-task" }));
    const fsyncSync = fs.fsyncSync;
    const renameSync = fs.renameSync;
    const steps = [];
    try {
      fs.fsyncSync = (fd) => { steps.push("flush"); return fsyncSync(fd); };
      fs.renameSync = () => { steps.push("promote"); throw new Error("promotion failed"); };
      assert.throws(() => state.writeSessionState({ ...previous, status: "paused" }), /promotion failed/);
    } finally {
      fs.fsyncSync = fsyncSync;
      fs.renameSync = renameSync;
    }
    assert.deepEqual(steps, ["flush", "promote"]);
    assert.deepEqual(state.readSessionState(previous.task_id), previous);
    assert.deepEqual(fs.readdirSync(state.SESSION_DIR), ["promotion-task.json"]);
  });
});

test("fresh process recovers paused work after an actual writer kill before promotion", () => {
  withTempHome((state) => {
    const paused = state.markPaused(state.buildBaseState({ taskId: "kill-task", sessionId: "resume-me" }), { retryDelayMs: 1 });
    const writer = spawnSync(process.execPath, ["-e", `
      const fs = require('node:fs');
      const state = require(${JSON.stringify(stateModulePath)});
      fs.renameSync = () => process.kill(process.pid, 'SIGKILL');
      state.writeSessionState({ ...state.readSessionState('kill-task'), status: 'completed' });
    `], { encoding: "utf8", env: { ...process.env } });
    assert.equal(writer.signal, "SIGKILL");
    const reader = spawnSync(process.execPath, ["-e", `
      const state = require(${JSON.stringify(stateModulePath)});
      const recovered = state.listDuePausedSessions(new Date(Date.now() + 1000));
      console.log(JSON.stringify({ recovered, events: require('node:fs').readFileSync(state.EVENT_LOG_PATH, 'utf8') }));
    `], { encoding: "utf8", env: { ...process.env } });
    assert.equal(reader.status, 0, reader.stderr);
    const result = JSON.parse(reader.stdout);
    assert.equal(result.recovered.length, 1);
    assert.equal(result.recovered[0].session_id, paused.session_id);
    assert.equal(JSON.parse(result.events).type, "session.paused");
    assert.equal(fs.statSync(path.join(state.SESSION_DIR, "kill-task.json")).mode & 0o777, 0o600);
  });
});
