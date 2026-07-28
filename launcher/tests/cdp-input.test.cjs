const assert = require("node:assert/strict");
const test = require("node:test");
const {
  dispatchTrustedClick,
  evaluatePage,
} = require("../electron/cdp-input.cjs");

function createDebugger(responses = []) {
  const commands = [];
  let attached = false;
  return {
    commands,
    client: {
      attach(version) {
        assert.equal(version, "1.3");
        attached = true;
      },
      isAttached: () => attached,
      async sendCommand(method, params) {
        commands.push({ method, params });
        return responses.shift() ?? {};
      },
    },
  };
}

test("trusted clicks are dispatched through the owned Electron WebContents target", async () => {
  const { client, commands } = createDebugger();
  await dispatchTrustedClick({
    debuggerClient: client,
    point: { x: 123.5, y: 456.25 },
  });
  assert.deepEqual(commands, [
    {
      method: "Input.dispatchMouseEvent",
      params: {
        type: "mousePressed",
        x: 123.5,
        y: 456.25,
        button: "left",
        clickCount: 1,
      },
    },
    {
      method: "Input.dispatchMouseEvent",
      params: {
        type: "mouseReleased",
        x: 123.5,
        y: 456.25,
        button: "left",
        clickCount: 1,
      },
    },
  ]);
});

test("page evaluation reads from the owned Electron WebContents target", async () => {
  const { client, commands } = createDebugger([{
    result: {
      type: "object",
      value: { open: true, count: 5 },
    },
  }]);
  const result = await evaluatePage({
    debuggerClient: client,
    expression: "({ open: true, count: 5 })",
  });
  assert.deepEqual(result, { open: true, count: 5 });
  assert.deepEqual(commands, [{
    method: "Runtime.evaluate",
    params: {
      expression: "({ open: true, count: 5 })",
      returnByValue: true,
      awaitPromise: true,
    },
  }]);
});

test("WebContents CDP commands fail closed without an owned debugger", async () => {
  await assert.rejects(
    dispatchTrustedClick({
      debuggerClient: null,
      point: { x: 10, y: 20 },
    }),
    /WebContents debugger is unavailable/,
  );
});
