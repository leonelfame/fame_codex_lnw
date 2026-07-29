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
  isTemporaryChatUrl,
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

test("smoke preserves an already-hydrated Temporary Chat page", () => {
  assert.equal(isTemporaryChatUrl("https://chatgpt.com/?temporary-chat=true"), true);
  assert.equal(isTemporaryChatUrl("https://chatgpt.com/?temporary-chat=false"), false);
  assert.equal(isTemporaryChatUrl("https://chatgpt.com/c/abc?temporary-chat=true"), false);
  assert.equal(isTemporaryChatUrl("not a url"), false);
});

test("session inspection navigates an authenticated ordinary chat surface to Temporary Chat", async () => {
  let currentUrl = "https://chatgpt.com/";
  const navigations = [];
  const fixture = {
    view: {
      webContents: {
        getURL: () => currentUrl,
        loadURL: async (url) => {
          navigations.push(url);
          currentUrl = url;
        },
      },
    },
    probeAuthentication: async () => ({ authenticated: true }),
  };

  const inspected = await BrowserHost.prototype.runSessionInspection.call(fixture, false);

  assert.deepEqual(navigations, ["https://chatgpt.com/?temporary-chat=true"]);
  assert.deepEqual(inspected, {
    authenticated: true,
    temporary: true,
    url: "https://chatgpt.com/?temporary-chat=true",
  });
});

test("browser surface reactivation preserves its last measured bounds", () => {
  const visibility = [];
  const fixture = {
    surfaceActive: true,
    boundsReady: true,
    syncViewVisibility() {
      visibility.push({ active: this.surfaceActive, boundsReady: this.boundsReady });
    },
    setState() {},
    snapshot() {
      return { surfaceActive: this.surfaceActive, boundsReady: this.boundsReady };
    },
  };

  BrowserHost.prototype.setSurfaceActive.call(fixture, false);
  BrowserHost.prototype.setSurfaceActive.call(fixture, true);

  assert.deepEqual(visibility, [
    { active: false, boundsReady: true },
    { active: true, boundsReady: true },
  ]);
  assert.equal(fixture.boundsReady, true);
});

test("manual browser operations wait for the first measured surface", async () => {
  let readinessReads = 0;
  const fixture = {
    surfaceActive: true,
    get boundsReady() {
      readinessReads += 1;
      return readinessReads >= 3;
    },
  };

  await BrowserHost.prototype.waitForSurfaceReady.call(fixture, 100, 1);

  assert.equal(readinessReads, 3);
});

test("manual browser operations fail closed without measured surface bounds", async () => {
  await assert.rejects(
    BrowserHost.prototype.waitForSurfaceReady.call(
      { surfaceActive: true, boundsReady: false },
      2,
      1,
    ),
    /did not receive measured bounds/,
  );
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

test("smoke effort selection uses trusted input and semantic checked state", async () => {
  const source = require("node:fs").readFileSync(require.resolve("../electron/browser-host.cjs"), "utf8");
  const cdpSource = require("node:fs").readFileSync(require.resolve("../electron/cdp-input.cjs"), "utf8");
  assert.match(source, /\[data-testid="composer-intelligence-picker-content"\]\[role="group"\]/);
  assert.match(source, /\[role="menuitemradio"\]/);
  assert.match(cdpSource, /Input\.dispatchMouseEvent/);
  assert.match(cdpSource, /debuggerClient/);
  assert.doesNotMatch(source, /:popover-open/);
  assert.doesNotMatch(source, /data-radix-collection-item/);

  let controlReads = 0;
  let menuReads = 0;
  const clicks = [];
  const inputEvents = [];
  const fixture = {
    clickBrowserPoint: BrowserHost.prototype.clickBrowserPoint,
    pressBrowserKey: BrowserHost.prototype.pressBrowserKey,
    readEffortControl: BrowserHost.prototype.readEffortControl,
    readEffortMenu: BrowserHost.prototype.readEffortMenu,
    waitForEffortControl: BrowserHost.prototype.waitForEffortControl,
    waitForEffortMenu: BrowserHost.prototype.waitForEffortMenu,
    dispatchTrustedClick: async (input) => clicks.push(input),
    evaluatePage: async ({ expression }) => {
      if (expression.includes("effort-control-read")) {
        controlReads += 1;
        if (controlReads === 1) {
          return {
            found: false,
            composer: true,
            readyState: "complete",
            url: "https://chatgpt.com/?temporary-chat=true",
          };
        }
        return {
          found: true,
          label: "Instant",
          point: { x: 120, y: 80 },
          composer: true,
          readyState: "complete",
          url: "https://chatgpt.com/?temporary-chat=true",
        };
      }
      if (expression.includes("effort-menu-read")) {
        menuReads += 1;
        if ([1, 2, 4].includes(menuReads)) {
          return { open: false, count: 0, target: null };
        }
        return {
          open: true,
          count: 5,
          target: {
            label: "Instant 5.5",
            checked: menuReads >= 5 ? "true" : "false",
            point: { x: 160, y: 140 },
          },
        };
      }
      throw new Error("Unexpected browser script");
    },
    evaluateBrowserPage: BrowserHost.prototype.evaluateBrowserPage,
    view: {
      webContents: {
        debugger: {},
        getURL: () => "https://chatgpt.com/?temporary-chat=true",
        sendInputEvent: (event) => inputEvents.push(event),
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
  assert.equal(controlReads, 3);
  assert.equal(menuReads, 5);
  assert.deepEqual(clicks, [
    {
      debuggerClient: {},
      point: { x: 120, y: 80 },
    },
    {
      debuggerClient: {},
      point: { x: 160, y: 140 },
    },
    {
      debuggerClient: {},
      point: { x: 120, y: 80 },
    },
  ]);
  assert.deepEqual(inputEvents, [
    { type: "keyDown", keyCode: "Escape" },
    { type: "keyUp", keyCode: "Escape" },
  ]);
});

test("smoke submission waits for the semantic send control and uses trusted CDP input", async () => {
  const clicks = [];
  let reads = 0;
  const fixture = {
    readSmokeSendButton: BrowserHost.prototype.readSmokeSendButton,
    evaluateBrowserPage: BrowserHost.prototype.evaluateBrowserPage,
    evaluatePage: async ({ expression }) => {
      assert.match(expression, /smoke-send-button-read/);
      reads += 1;
      return reads < 3
        ? { ready: false, reason: "disabled" }
        : { ready: true, point: { x: 300, y: 220 } };
    },
    view: { webContents: { debugger: {} } },
  };

  const button = await BrowserHost.prototype.waitForSmokeSendButton.call(fixture, 100, 1);
  await BrowserHost.prototype.clickBrowserPoint.call({
    view: fixture.view,
    dispatchTrustedClick: async input => clicks.push(input),
  }, button.point);

  assert.equal(reads, 3);
  assert.deepEqual(clicks, [{
    debuggerClient: {},
    point: { x: 300, y: 220 },
  }]);
});

test("smoke effort selection is idempotent without comparing localized labels", async () => {
  const inputEvents = [];
  const fixture = {
    clickBrowserPoint: BrowserHost.prototype.clickBrowserPoint,
    pressBrowserKey: BrowserHost.prototype.pressBrowserKey,
    readEffortMenu: async () => ({
      open: true,
      count: 5,
      target: { label: "Instant 5.5", checked: "true", point: { x: 140, y: 130 } },
    }),
    waitForEffortControl: async () => ({
      found: true,
      label: "高",
      point: { x: 90, y: 70 },
    }),
    waitForEffortMenu: async () => ({
      open: true,
      count: 5,
      target: { label: "Instant 5.5", checked: "true", point: { x: 140, y: 130 } },
    }),
    view: {
      webContents: {
        sendInputEvent: (event) => inputEvents.push(event),
      },
    },
  };

  const result = await BrowserHost.prototype.selectHighEffort.call(fixture);

  assert.deepEqual(result, { effort: "High", changed: false });
  assert.deepEqual(inputEvents, [
    { type: "keyDown", keyCode: "Escape" },
    { type: "keyUp", keyCode: "Escape" },
  ]);
});

test("smoke effort selection fails closed with rendering diagnostics", async () => {
  const fixture = {
    clickBrowserPoint: BrowserHost.prototype.clickBrowserPoint,
    pressBrowserKey: BrowserHost.prototype.pressBrowserKey,
    readEffortControl: BrowserHost.prototype.readEffortControl,
    readEffortMenu: BrowserHost.prototype.readEffortMenu,
    waitForEffortControl: BrowserHost.prototype.waitForEffortControl,
    waitForEffortMenu: BrowserHost.prototype.waitForEffortMenu,
    evaluateBrowserPage: BrowserHost.prototype.evaluateBrowserPage,
    evaluatePage: async () => ({
      found: false,
      composer: true,
      readyState: "complete",
      url: "https://chatgpt.com/?temporary-chat=true",
    }),
    view: {
      webContents: {
        debugger: {},
        getURL: () => "https://chatgpt.com/?temporary-chat=true",
        sendInputEvent() {},
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
    /effort control did not become ready .*composer=ready/,
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
