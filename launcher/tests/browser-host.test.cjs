const test = require("node:test");
const assert = require("node:assert/strict");
const {
  browserViewVisible,
  constrainBrowserBounds,
  navigateBrowser,
  readBrowserNavigationState,
} = require("../electron/browser-state.cjs");
const {
  allowedAuthUrl,
  BrowserHost,
  CHATGPT_VIEWPORT_CSS,
} = require("../electron/browser-host.cjs");

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
  assert.equal(browserViewVisible(false, false, false), false);
  assert.equal(browserViewVisible(true, false, true), false);
  assert.equal(browserViewVisible(false, true, true), false);
  assert.equal(browserViewVisible(true, true, false), false);
  assert.equal(browserViewVisible(true, true, true), true);
});

test("browser bounds are clipped to the launcher content area", () => {
  assert.deepEqual(
    constrainBrowserBounds({ x: 260, y: 78, width: 1000, height: 900 }, { width: 1200, height: 800 }),
    { x: 260, y: 78, width: 940, height: 722 },
  );
  assert.deepEqual(
    constrainBrowserBounds({ x: -20, y: -10, width: 0, height: 0 }, { width: 1200, height: 800 }),
    { x: 0, y: 0, width: 1, height: 1 },
  );
});

test("authentication windows stay in the owned browser surface", () => {
  assert.equal(allowedAuthUrl("https://accounts.google.com/o/oauth2/v2/auth"), true);
  assert.equal(allowedAuthUrl("https://chatgpt.com/auth/login"), true);
  assert.equal(allowedAuthUrl("https://example.com/login"), false);
  const source = require("node:fs").readFileSync(require.resolve("../electron/browser-host.cjs"), "utf8");
  assert.match(source, /createWindow:\s*\(options\)\s*=>\s*this\.createAuthView\(options\)/);
  assert.doesNotMatch(source, /overrideBrowserWindowOptions/);
});

test("concurrent login requests share one authentication operation", async () => {
  let resolveLogin;
  let waits = 0;
  const fixture = {
    state: { authenticated: false },
    loginOperation: null,
    show() {},
    snapshot() { return { authenticated: false }; },
    logger: { info() {} },
    view: { webContents: { getURL: () => "https://chatgpt.com/", loadURL: async () => {} } },
    probeAuthentication: async () => {},
    waitForAuthenticated: async () => {
      waits += 1;
      return await new Promise((resolve) => { resolveLogin = resolve; });
    },
    withManualOperation: async (_name, action) => await action(),
  };
  const first = BrowserHost.prototype.openLogin.call(fixture);
  const second = BrowserHost.prototype.openLogin.call(fixture);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(waits, 1);
  resolveLogin({ authenticated: true });
  assert.deepEqual(await first, { authenticated: true });
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

test("smoke effort selection waits for the control and confirms High", async () => {
  let controlReads = 0;
  let optionReads = 0;
  let confirmationReads = 0;
  const fixture = {
    view: {
      webContents: {
        getURL: () => "https://chatgpt.com/?temporary-chat=true",
        executeJavaScript: async (source) => {
          if (source.includes("effort-control-open")) {
            controlReads += 1;
            if (controlReads === 1) {
              return {
                found: false,
                current: null,
                labels: [],
                composer: true,
                readyState: "complete",
                loading: true,
                url: "https://chatgpt.com/?temporary-chat=true",
              };
            }
            return {
              found: true,
              current: "Medium",
              labels: ["Medium"],
              composer: true,
              readyState: "complete",
              loading: false,
              url: "https://chatgpt.com/?temporary-chat=true",
              opened: true,
            };
          }
          if (source.includes("effort-option-select")) {
            optionReads += 1;
            return optionReads === 1
              ? { selected: false, choices: ["Instant", "Medium"] }
              : { selected: true, choices: ["Instant", "Medium", "High"] };
          }
          if (source.includes("effort-control-read")) {
            confirmationReads += 1;
            return {
              found: true,
              current: confirmationReads === 1 ? "Medium" : "High",
              labels: [confirmationReads === 1 ? "Medium" : "High"],
              composer: true,
              readyState: "complete",
              loading: false,
              url: "https://chatgpt.com/?temporary-chat=true",
            };
          }
          throw new Error("Unexpected browser script");
        },
      },
    },
  };

  const result = await BrowserHost.prototype.selectHighEffort.call(fixture, {
    readyTimeoutMs: 100,
    optionTimeoutMs: 100,
    confirmTimeoutMs: 100,
    pollMs: 1,
  });

  assert.deepEqual(result, { effort: "High", changed: true });
  assert.equal(controlReads, 2);
  assert.equal(optionReads, 2);
  assert.equal(confirmationReads, 2);
});

test("smoke effort selection fails closed with rendering diagnostics", async () => {
  const fixture = {
    view: {
      webContents: {
        getURL: () => "https://chatgpt.com/?temporary-chat=true",
        executeJavaScript: async () => ({
          found: false,
          current: null,
          labels: [],
          composer: true,
          readyState: "complete",
          loading: true,
          url: "https://chatgpt.com/?temporary-chat=true",
        }),
      },
    },
  };

  await assert.rejects(
    BrowserHost.prototype.selectHighEffort.call(fixture, {
      readyTimeoutMs: 2,
      optionTimeoutMs: 2,
      confirmTimeoutMs: 2,
      pollMs: 1,
    }),
    /effort control did not become ready .*composer=ready; loading=visible/,
  );
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
