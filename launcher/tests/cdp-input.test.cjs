const assert = require("node:assert/strict");
const test = require("node:test");
const { dispatchTrustedClick, evaluatePage } = require("../electron/cdp-input.cjs");

test("trusted clicks target the exact ChatGPT page over page-level CDP", async () => {
  const commands = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      queueMicrotask(() => this.emit("open", {}));
    }

    addEventListener(name, listener) {
      const listeners = this.listeners.get(name) || [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
    }

    emit(name, event) {
      for (const listener of this.listeners.get(name) || []) listener(event);
    }

    send(payload) {
      const command = JSON.parse(payload);
      commands.push(command);
      queueMicrotask(() => this.emit("message", {
        data: JSON.stringify({ id: command.id, result: {} }),
      }));
    }

    close() {
      this.emit("close", {});
    }
  }

  const pageUrl = "https://chatgpt.com/?temporary-chat=true";
  await dispatchTrustedClick({
    endpoint: "http://127.0.0.1:17842",
    pageUrl,
    point: { x: 123.5, y: 456.25 },
    fetchImpl: async (url) => {
      assert.equal(url, "http://127.0.0.1:17842/json");
      return {
        ok: true,
        json: async () => [{
          type: "page",
          url: pageUrl,
          webSocketDebuggerUrl: "ws://127.0.0.1:17842/devtools/page/chatgpt",
        }],
      };
    },
    WebSocketImpl: FakeWebSocket,
  });

  assert.deepEqual(commands, [
    {
      id: 1,
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
      id: 2,
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

test("trusted clicks fail closed when the exact ChatGPT target is ambiguous", async () => {
  const pageUrl = "https://chatgpt.com/?temporary-chat=true";
  await assert.rejects(
    dispatchTrustedClick({
      endpoint: "http://127.0.0.1:17842",
      pageUrl,
      point: { x: 10, y: 20 },
      fetchImpl: async () => ({
        ok: true,
        json: async () => [
          { type: "page", url: pageUrl, webSocketDebuggerUrl: "ws://one" },
          { type: "page", url: pageUrl, webSocketDebuggerUrl: "ws://two" },
        ],
      }),
      WebSocketImpl: class {},
    }),
    /Expected one CDP page target .* found 2/,
  );
});

test("page evaluation reads from the same exact CDP target as trusted input", async () => {
  const commands = [];
  class FakeWebSocket {
    constructor() {
      this.listeners = new Map();
      queueMicrotask(() => this.emit("open", {}));
    }

    addEventListener(name, listener) {
      const listeners = this.listeners.get(name) || [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
    }

    emit(name, event) {
      for (const listener of this.listeners.get(name) || []) listener(event);
    }

    send(payload) {
      const command = JSON.parse(payload);
      commands.push(command);
      queueMicrotask(() => this.emit("message", {
        data: JSON.stringify({
          id: command.id,
          result: {
            result: {
              type: "object",
              value: { open: true, count: 5 },
            },
          },
        }),
      }));
    }

    close() {
      this.emit("close", {});
    }
  }

  const pageUrl = "https://chatgpt.com/?temporary-chat=true";
  const result = await evaluatePage({
    endpoint: "http://127.0.0.1:17842",
    pageUrl,
    expression: "({ open: true, count: 5 })",
    fetchImpl: async () => ({
      ok: true,
      json: async () => [{
        type: "page",
        url: pageUrl,
        webSocketDebuggerUrl: "ws://127.0.0.1:17842/devtools/page/chatgpt",
      }],
    }),
    WebSocketImpl: FakeWebSocket,
  });

  assert.deepEqual(result, { open: true, count: 5 });
  assert.deepEqual(commands, [{
    id: 1,
    method: "Runtime.evaluate",
    params: {
      expression: "({ open: true, count: 5 })",
      returnByValue: true,
      awaitPromise: true,
    },
  }]);
});
