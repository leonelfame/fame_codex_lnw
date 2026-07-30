const assert = require("node:assert/strict");
const test = require("node:test");
const {
  dispatchTrustedClick,
  dispatchTrustedKey,
  dispatchTrustedText,
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

test("trusted connector mention is typed as discrete keyboard events", async () => {
  const { client, commands, detached } = createDebugger();
  await dispatchTrustedText({
    debuggerClient: client,
    text: "@C",
  });
  assert.deepEqual(commands, [
    {
      method: "Input.dispatchKeyEvent",
      params: {
        type: "keyDown",
        key: "@",
        code: "Digit2",
        windowsVirtualKeyCode: 50,
        nativeVirtualKeyCode: 50,
        text: "@",
        unmodifiedText: "@",
      },
    },
    {
      method: "Input.dispatchKeyEvent",
      params: {
        type: "keyUp",
        key: "@",
        code: "Digit2",
        windowsVirtualKeyCode: 50,
        nativeVirtualKeyCode: 50,
      },
    },
    {
      method: "Input.dispatchKeyEvent",
      params: {
        type: "keyDown",
        key: "C",
        code: "KeyC",
        windowsVirtualKeyCode: 67,
        nativeVirtualKeyCode: 67,
        text: "C",
        unmodifiedText: "C",
      },
    },
    {
      method: "Input.dispatchKeyEvent",
      params: {
        type: "keyUp",
        key: "C",
        code: "KeyC",
        windowsVirtualKeyCode: 67,
        nativeVirtualKeyCode: 67,
      },
    },
  ]);
  assert.equal(detached(), true);
});

test("trusted connector typing focuses the current composer before every key", async () => {
  const { client, commands, detached } = createDebugger([
    { result: { type: "boolean", value: true } },
    {},
    {},
    { result: { type: "boolean", value: true } },
    {},
    {},
  ]);
  await dispatchTrustedText({
    debuggerClient: client,
    text: "@c",
    focusExpression: "focusCurrentComposer()",
  });
  assert.deepEqual(
    commands.filter(({ method }) => method === "Runtime.evaluate"),
    [
      {
        method: "Runtime.evaluate",
        params: {
          expression: "focusCurrentComposer()",
          returnByValue: true,
          awaitPromise: true,
        },
      },
      {
        method: "Runtime.evaluate",
        params: {
          expression: "focusCurrentComposer()",
          returnByValue: true,
          awaitPromise: true,
        },
      },
    ],
  );
  assert.equal(detached(), true);
});

test("trusted connector typing fails closed when the live composer cannot be focused", async () => {
  const { client, detached } = createDebugger([{
    result: { type: "boolean", value: false },
  }]);
  await assert.rejects(
    dispatchTrustedText({
      debuggerClient: client,
      text: "@c",
      focusExpression: "focusCurrentComposer()",
    }),
    /could not focus the live composer/,
  );
  assert.equal(detached(), true);
});

test("trusted connector selection clicks one exact DOM-derived point", async () => {
  const { client, commands, detached } = createDebugger();
  await dispatchTrustedClick({
    debuggerClient: client,
    point: { x: 320.5, y: 240.25 },
  });
  assert.deepEqual(commands, [
    {
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseMoved", x: 320.5, y: 240.25 },
    },
    {
      method: "Input.dispatchMouseEvent",
      params: {
        type: "mousePressed",
        x: 320.5,
        y: 240.25,
        button: "left",
        buttons: 1,
        clickCount: 1,
      },
    },
    {
      method: "Input.dispatchMouseEvent",
      params: {
        type: "mouseReleased",
        x: 320.5,
        y: 240.25,
        button: "left",
        buttons: 0,
        clickCount: 1,
      },
    },
  ]);
  assert.equal(detached(), true);
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
  await assert.rejects(
    dispatchTrustedText({
      debuggerClient: null,
      text: "@Codex Native",
    }),
    /WebContents debugger is unavailable/,
  );
});
