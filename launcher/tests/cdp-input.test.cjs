const assert = require("node:assert/strict");
const test = require("node:test");
const {
  dispatchTrustedClick,
  dispatchTrustedKey,
  evaluatePage,
} = require("../electron/cdp-input.cjs");

function createDebugger(responses = []) {
  const commands = [];
  let attached = false;
  return {
    commands,
    detached: () => !attached,
    client: {
      attach(version) {
        assert.equal(version, "1.3");
        attached = true;
      },
      isAttached: () => attached,
      detach() {
        attached = false;
      },
      async sendCommand(method, params) {
        commands.push({ method, params });
        return responses.shift() ?? {};
      },
    },
  };
}

test("page evaluation reads from the owned Electron WebContents target", async () => {
  const { client, commands, detached } = createDebugger([{
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
  assert.equal(detached(), true);
});

test("trusted Enter is dispatched through the owned Electron WebContents target", async () => {
  const { client, commands, detached } = createDebugger();
  await dispatchTrustedKey({
    debuggerClient: client,
    key: "Enter",
  });
  assert.deepEqual(commands, [
    {
      method: "Input.dispatchKeyEvent",
      params: {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        text: "\r",
        unmodifiedText: "\r",
      },
    },
    {
      method: "Input.dispatchKeyEvent",
      params: {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      },
    },
  ]);
  assert.equal(detached(), true);
});

test("trusted pointer activation is dispatched at the resolved DOM point", async () => {
  const { client, commands, detached } = createDebugger();
  await dispatchTrustedClick({
    debuggerClient: client,
    point: { x: 123.5, y: 88.25 },
  });
  assert.deepEqual(commands, [
    {
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseMoved", x: 123.5, y: 88.25, button: "none" },
    },
    {
      method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", x: 123.5, y: 88.25, button: "left", clickCount: 1 },
    },
    {
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseReleased", x: 123.5, y: 88.25, button: "left", clickCount: 1 },
    },
  ]);
  assert.equal(detached(), true);
});

test("trusted pointer activation rejects a missing DOM point", async () => {
  await assert.rejects(
    dispatchTrustedClick({ debuggerClient: createDebugger().client, point: null }),
    /CDP click point is invalid/,
  );
});

test("pre-attached WebContents debugger ownership is preserved", async () => {
  const { client, detached } = createDebugger([{
    result: { type: "number", value: 5 },
  }]);
  client.attach("1.3");
  const result = await evaluatePage({
    debuggerClient: client,
    expression: "2 + 3",
  });
  assert.equal(result, 5);
  assert.equal(detached(), false);
});

test("WebContents CDP commands fail closed without an owned debugger", async () => {
  await assert.rejects(
    dispatchTrustedKey({
      debuggerClient: null,
      key: "Enter",
    }),
    /WebContents debugger is unavailable/,
  );
});
