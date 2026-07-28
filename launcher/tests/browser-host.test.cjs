const test = require("node:test");
const assert = require("node:assert/strict");
const {
  browserViewVisible,
  navigateBrowser,
  readBrowserNavigationState,
} = require("../electron/browser-state.cjs");
const { BrowserHost, CHATGPT_VIEWPORT_CSS } = require("../electron/browser-host.cjs");

function createContents() {
  const calls = [];
  const history = {
    canGoBack: () => true,
    canGoForward: () => false,
    goBack: () => calls.push("back"),
    goForward: () => calls.push("forward"),
  };
  const webContents = {
    navigationHistory: history,
    getURL: () => "https://chatgpt.com/?temporary-chat=true",
    getTitle: () => "ChatGPT",
    isDestroyed: () => false,
    isLoading: () => false,
    focus: () => calls.push("focus"),
    reload: () => calls.push("reload"),
  };
  return { calls, webContents };
}

test("browser surface visibility requires both requested and active state", () => {
  assert.equal(browserViewVisible(false, false), false);
  assert.equal(browserViewVisible(true, false), false);
  assert.equal(browserViewVisible(false, true), false);
  assert.equal(browserViewVisible(true, true), true);
});

test("browser chrome navigation delegates to WebContents navigation history", () => {
  const { calls, webContents } = createContents();
  navigateBrowser(webContents, "back");
  navigateBrowser(webContents, "forward");
  navigateBrowser(webContents, "reload");

  assert.deepEqual(calls, ["back", "reload"]);
  assert.throws(() => navigateBrowser(webContents, "unknown"), /Unknown browser navigation action/);
});

test("browser chrome state is read from the owned WebContents", () => {
  const { webContents } = createContents();
  const state = readBrowserNavigationState(webContents, {
    title: "Fallback",
    url: "about:blank",
    loading: true,
    canGoBack: false,
    canGoForward: true,
  });
  assert.deepEqual(state, {
    title: "ChatGPT",
    url: "https://chatgpt.com/?temporary-chat=true",
    loading: false,
    canGoBack: true,
    canGoForward: false,
  });
});

test("embedded ChatGPT is constrained to the owned horizontal viewport", () => {
  assert.match(CHATGPT_VIEWPORT_CSS, /max-width:\s*100% !important/);
  assert.match(CHATGPT_VIEWPORT_CSS, /overflow-x:\s*hidden !important/);
  assert.match(CHATGPT_VIEWPORT_CSS, /overscroll-behavior-x:\s*none !important/);
});

test("a stale helper cannot end a replacement turn with the same trace id", async () => {
  await assert.rejects(
    BrowserHost.prototype.endTurn.call(
      { activeTraceId: "trace_same_retry", activeHelperPid: 222 },
      "trace_same_retry",
      111,
      "failed",
      false,
      "stale helper exited",
    ),
    /Browser helper ownership mismatch: expected 222, received 111/,
  );
});
