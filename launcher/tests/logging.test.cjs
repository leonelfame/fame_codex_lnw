const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const {
  createLogger,
  installProcessDiagnosticGuards,
  registerLoggedIpc,
  sanitize,
} = require("../electron/logging.cjs");

test("launcher logs redact tunnel ids, runtime keys, and bearer credentials", () => {
  assert.deepEqual(sanitize({
    line: "tunnel_0123456789abcdef0123456789abcdef sk-exampleRuntimeSecret123",
    authorization: "Bearer this-must-never-be-recorded",
    nested: { controlToken: "also-secret" },
  }), {
    line: "[tunnel-id] [runtime-key]",
    authorization: "[redacted]",
    nested: { controlToken: "[redacted]" },
  });
});

test("failed launcher IPC calls are written to runtime activity", async () => {
  let registered;
  const errors = [];
  const ipcMain = {
    handle(channel, handler) {
      registered = { channel, handler };
    },
  };
  registerLoggedIpc(
    ipcMain,
    { error: (event, detail) => errors.push({ event, detail }) },
    "launcher:test",
    async () => {
      throw new Error("visible failure");
    },
  );

  await assert.rejects(registered.handler({}, 1), /visible failure/);
  assert.deepEqual(errors, [{
    event: "launcher.ipc_failed",
    detail: { channel: "launcher:test", message: "visible failure" },
  }]);
});

test("launcher activity restores valid records from the previous process", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-logging-"));
  const filePath = path.join(root, "launcher.jsonl");
  try {
    fs.writeFileSync(filePath, [
      JSON.stringify({ at: "2026-07-28T00:00:00.000Z", level: "info", event: "previous", detail: {} }),
      "not-json",
      "",
    ].join("\n"));
    const logger = createLogger({ filePath });
    assert.deepEqual(logger.recent().map((record) => record.event), ["previous"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a closed Windows diagnostic pipe is recorded without becoming an uncaught process error", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-process-pipe-"));
  const filePath = path.join(root, "process-stream-errors.log");
  const stream = new PassThrough();
  try {
    installProcessDiagnosticGuards({ filePath, streams: [stream] });
    stream.emit("error", Object.assign(new Error("write EOF"), { code: "EOF" }));
    assert.match(fs.readFileSync(filePath, "utf8"), /write EOF/);
  } finally {
    stream.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
