const fs = require("node:fs");
const path = require("node:path");
const { WebContentsView, shell } = require("electron");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { processRunning } = require("./process-tree.cjs");
const { dispatchTrustedClick } = require("./cdp-input.cjs");
const {
  browserViewVisible,
  constrainBrowserBounds,
  navigateBrowser,
  readBrowserNavigationState,
} = require("./browser-state.cjs");

const TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
const CHATGPT_ORIGIN = "https://chatgpt.com";
const IDLE_BROWSER_URL = "about:blank#codex-web-gpt-browser-host";
const SMOKE_TEXT = "Reply with exactly: CODEX WEB GPT READY";
const SMOKE_EXPECTED = "CODEX WEB GPT READY";
const MAX_BROWSER_VIEW_DIMENSION = 16_384;
const CHATGPT_PARTITION = "persist:codex-web-gpt-chatgpt";
const COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  "#prompt-textarea",
  '[contenteditable="true"][data-lexical-editor="true"]',
  '[contenteditable="true"][role="textbox"]',
  "textarea",
].join(", ");
const CHATGPT_VIEWPORT_CSS = `
  html,
  body {
    width: 100% !important;
    max-width: 100% !important;
    overflow-x: hidden !important;
    overscroll-behavior-x: none !important;
  }

  #__next {
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    overflow-x: hidden !important;
  }
`;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function visibleElementScript(selector) {
  return `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  })`;
}

function normalizeBounds(bounds) {
  const read = (value) => Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return {
    x: Math.min(MAX_BROWSER_VIEW_DIMENSION, read(bounds?.x)),
    y: Math.min(MAX_BROWSER_VIEW_DIMENSION, read(bounds?.y)),
    width: Math.min(MAX_BROWSER_VIEW_DIMENSION, Math.max(1, read(bounds?.width))),
    height: Math.min(MAX_BROWSER_VIEW_DIMENSION, Math.max(1, read(bounds?.height))),
  };
}

function allowedAuthUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && (
    parsed.hostname === "chatgpt.com"
    || parsed.hostname.endsWith(".openai.com")
    || parsed.hostname === "accounts.google.com"
    || parsed.hostname === "login.microsoftonline.com"
    || parsed.hostname.endsWith(".apple.com")
  );
}

class BrowserHost {
  constructor({ window, descriptorPath, cdpPort, control, helper, logger, publishState }) {
    this.window = window;
    this.descriptorPath = descriptorPath;
    this.cdpPort = cdpPort;
    this.control = control;
    this.helper = helper;
    this.logger = logger;
    this.publishState = publishState;
    this.dispatchTrustedClick = dispatchTrustedClick;
    this.visible = false;
    this.surfaceActive = true;
    this.activeTraceId = null;
    this.activeHelperPid = null;
    this.manualOperation = null;
    this.loginOperation = null;
    this.viewportCssKey = null;
    this.authView = null;
    this.boundsReady = false;
    this.bounds = { x: 0, y: 0, width: 1, height: 1 };
    this.state = {
      status: "idle",
      message: "No active task",
      url: "about:blank",
      title: "ChatGPT",
      authenticated: false,
      visible: false,
      surfaceActive: true,
      loading: false,
      canGoBack: false,
      canGoForward: false,
    };
    this.view = new WebContentsView({
      webPreferences: {
        partition: CHATGPT_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
        backgroundThrottling: true,
      },
    });
    window.contentView.addChildView(this.view);
    this.view.setBounds(this.bounds);
    this.view.setVisible(false);
    this.bindWebContents();
    void this.view.webContents.loadURL(IDLE_BROWSER_URL).catch((error) => {
      this.logger.error("browser.initialization_failed", { message: error instanceof Error ? error.message : String(error) });
      this.setState({ status: "error", message: "Embedded browser failed to initialize" });
    });
    this.writeDescriptor();
  }

  bindWebContents() {
    const contents = this.view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      if (allowedAuthUrl(url)) {
        return {
          action: "allow",
          createWindow: (options) => this.createAuthView(options),
        };
      }
      let parsed;
      try { parsed = new URL(url); } catch { return { action: "deny" }; }
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        void shell.openExternal(parsed.toString());
      } else {
        this.logger.warn("browser.external_url_rejected", { protocol: parsed.protocol });
      }
      return { action: "deny" };
    });
    contents.on("did-start-navigation", (_event, url, _inPlace, mainFrame) => {
      if (!mainFrame) return;
      this.setState(this.activeTraceId || this.manualOperation
        ? { url, loading: true }
        : { status: "loading", message: "Opening ChatGPT", url, loading: true });
    });
    contents.on("did-finish-load", () => {
      this.setState({ url: contents.getURL(), loading: false });
      void this.applyViewportCss();
      void this.probeAuthentication();
    });
    contents.on("did-start-loading", () => this.setState({ loading: true }));
    contents.on("did-stop-loading", () => this.setState({ loading: false }));
    contents.on("page-title-updated", (_event, title) => {
      this.setState({ title: typeof title === "string" && title.trim() ? title.trim() : "ChatGPT" });
    });
    contents.on("did-navigate-in-page", (_event, url, mainFrame) => {
      if (mainFrame) this.setState({ url });
    });
    contents.on("did-fail-load", (_event, errorCode, errorDescription, url, mainFrame) => {
      if (!mainFrame || errorCode === -3) return;
      this.logger.error("browser.navigation_failed", { errorCode, errorDescription, url });
      this.setState({ status: "error", message: errorDescription, url });
    });
    contents.on("render-process-gone", (_event, details) => {
      this.logger.error("browser.renderer_gone", { reason: details.reason, exitCode: details.exitCode });
      this.setState({ status: "error", message: `Browser renderer stopped: ${details.reason}` });
    });
  }

  snapshot() {
    const contents = this.activeView()?.webContents;
    return readBrowserNavigationState(contents, {
      ...this.state,
      visible: this.visible,
      surfaceActive: this.surfaceActive,
    });
  }

  setState(patch) {
    this.state = {
      ...this.state,
      ...patch,
      visible: this.visible,
      surfaceActive: this.surfaceActive,
    };
    this.publishState?.(this.snapshot());
  }

  setBounds(bounds) {
    const [width, height] = this.window.getContentSize();
    this.bounds = constrainBrowserBounds(normalizeBounds(bounds), { width, height });
    this.boundsReady = true;
    this.view.setBounds(this.bounds);
    this.authView?.setBounds(this.bounds);
    this.syncViewVisibility();
    void this.view.webContents.executeJavaScript("window.dispatchEvent(new Event('resize'))", true).catch(() => {});
    if (this.authView && !this.authView.webContents.isDestroyed()) {
      void this.authView.webContents.executeJavaScript("window.dispatchEvent(new Event('resize'))", true).catch(() => {});
    }
  }

  activeView() {
    return this.authView || this.view;
  }

  syncViewVisibility() {
    const visible = browserViewVisible(this.visible, this.surfaceActive, this.boundsReady);
    this.view.setVisible(visible && !this.authView);
    this.authView?.setVisible(visible);
  }

  createAuthView(options = {}) {
    this.closeAuthView(this.authView, true);
    const authView = new WebContentsView({
      webPreferences: {
        ...(options.webPreferences || {}),
        partition: CHATGPT_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.authView = authView;
    this.window.contentView.addChildView(authView);
    authView.setBounds(this.bounds);
    authView.setVisible(false);
    const contents = authView.webContents;
    contents.on("did-start-loading", () => this.setState({ loading: true }));
    contents.on("did-stop-loading", () => this.setState({ loading: false }));
    contents.on("did-finish-load", () => {
      this.setState({ url: contents.getURL(), loading: false });
      void this.probeAuthentication();
    });
    contents.on("page-title-updated", (_event, title) => {
      this.setState({ title: typeof title === "string" && title.trim() ? title.trim() : "ChatGPT" });
    });
    contents.on("close", () => this.closeAuthView(authView, true));
    contents.on("destroyed", () => this.closeAuthView(authView, false));
    contents.on("did-fail-load", (_event, errorCode, errorDescription, url, mainFrame) => {
      if (!mainFrame || errorCode === -3) return;
      this.logger.error("browser.auth_navigation_failed", { errorCode, errorDescription, url });
      this.setState({ status: "error", message: errorDescription, url });
    });
    contents.on("render-process-gone", (_event, details) => {
      this.logger.error("browser.auth_renderer_gone", { reason: details.reason, exitCode: details.exitCode });
      this.closeAuthView(authView, false);
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (allowedAuthUrl(url)) {
        void contents.loadURL(url);
      } else {
        let parsed;
        try { parsed = new URL(url); } catch { return { action: "deny" }; }
        if (parsed.protocol === "https:" || parsed.protocol === "http:") {
          void shell.openExternal(parsed.toString());
        }
      }
      return { action: "deny" };
    });
    this.syncViewVisibility();
    this.logger.info("browser.auth_surface_opened");
    return contents;
  }

  closeAuthView(authView, closeContents) {
    if (!authView || this.authView !== authView) return;
    this.authView = null;
    try { this.window.contentView.removeChildView(authView); } catch {}
    if (closeContents && !authView.webContents.isDestroyed()) {
      authView.webContents.close();
    }
    this.syncViewVisibility();
    this.logger.info("browser.auth_surface_closed");
    if (this.manualOperation === "ChatGPT login" && !this.view.webContents.isDestroyed()) {
      void this.view.webContents.loadURL(TEMPORARY_CHAT_URL).catch((error) => {
        this.logger.error("browser.auth_refresh_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  async applyViewportCss() {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    if (this.viewportCssKey) {
      await contents.removeInsertedCSS(this.viewportCssKey).catch(() => {});
      this.viewportCssKey = null;
    }
    this.viewportCssKey = await contents.insertCSS(CHATGPT_VIEWPORT_CSS).catch(() => null);
  }

  show() {
    this.visible = true;
    this.syncViewVisibility();
    this.setState({ visible: true });
    if (this.surfaceActive && this.boundsReady) this.activeView().webContents.focus();
  }

  async reveal() {
    this.show();
    if (this.view.webContents.getURL() === IDLE_BROWSER_URL) {
      await this.view.webContents.loadURL(TEMPORARY_CHAT_URL);
      await this.probeAuthentication();
    }
    return this.snapshot();
  }

  hide() {
    this.visible = false;
    this.syncViewVisibility();
    this.setState({ visible: false });
  }

  setSurfaceActive(active) {
    this.surfaceActive = active === true;
    this.syncViewVisibility();
    this.setState({ surfaceActive: this.surfaceActive });
    return this.snapshot();
  }

  navigate(action) {
    if (this.activeTraceId) {
      throw new Error("Browser navigation is locked while ChatGPT is running a Codex turn");
    }
    if (this.manualOperation) {
      throw new Error(`Browser navigation is locked during ${this.manualOperation}`);
    }
    const contents = this.activeView().webContents;
    navigateBrowser(contents, action);
    return this.snapshot();
  }

  beginTurn(traceId, reveal, helperPid) {
    if (this.manualOperation) {
      throw new Error(`ChatGPT browser is busy with ${this.manualOperation}`);
    }
    if (this.activeTraceId) {
      const sameSerializedHelper = this.activeHelperPid === helperPid;
      const previousHelperExited = !processRunning(this.activeHelperPid);
      if (!sameSerializedHelper && !previousHelperExited) {
        throw new Error(`ChatGPT browser already owns Codex turn ${this.activeTraceId}`);
      }
      this.logger.warn("browser.stale_turn_replaced", {
        previousTraceId: this.activeTraceId,
        previousHelperPid: this.activeHelperPid,
        traceId,
        helperPid,
        evidence: sameSerializedHelper ? "same serialized helper" : "previous helper exited",
      });
    }
    this.activeTraceId = traceId;
    this.activeHelperPid = helperPid;
    this.view.webContents.setBackgroundThrottling(false);
    if (reveal) this.show();
    this.setState({ status: "running", message: "ChatGPT is working", authenticated: true });
  }

  async endTurn(traceId, helperPid, status, hideAfterTurn, message) {
    if (this.activeTraceId !== traceId) {
      throw new Error(`Browser turn ownership mismatch: expected ${this.activeTraceId || "none"}, received ${traceId}`);
    }
    if (this.activeHelperPid !== helperPid) {
      throw new Error(
        `Browser helper ownership mismatch: expected ${this.activeHelperPid || "none"}, received ${helperPid}`,
      );
    }
    this.activeTraceId = null;
    this.activeHelperPid = null;
    this.view.webContents.setBackgroundThrottling(true);
    if (hideAfterTurn) this.hide();
    if (status === "completed") {
      this.setState({ status: "ready", message: "No active task", authenticated: true });
      try {
        await this.returnToIdle();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.error("browser.idle_cleanup_failed", { message: detail });
        this.setState({ status: "error", message: `Browser cleanup failed: ${detail}`, authenticated: true });
      }
    } else {
      this.setState({ status: "error", message: message || `ChatGPT turn ${status}`, authenticated: true });
    }
  }

  async returnToIdle() {
    this.hide();
    this.view.webContents.setBackgroundThrottling(true);
    if (this.view.webContents.getURL() !== IDLE_BROWSER_URL) {
      await this.view.webContents.loadURL(IDLE_BROWSER_URL);
    }
    this.setState({
      status: this.state.authenticated ? "ready" : "signed-out",
      message: this.state.authenticated ? "No active task" : "Sign in to ChatGPT",
    });
  }

  openLogin() {
    if (this.state.authenticated) {
      this.show();
      return Promise.resolve(this.snapshot());
    }
    if (this.loginOperation) {
      this.show();
      return this.loginOperation;
    }
    const operation = this.withManualOperation("ChatGPT login", async () => {
      this.show();
      this.logger.info("browser.login_opened");
      const current = this.view.webContents.getURL();
      if (!current.startsWith(CHATGPT_ORIGIN)) {
        await this.view.webContents.loadURL(TEMPORARY_CHAT_URL);
      }
      await this.probeAuthentication();
      return await this.waitForAuthenticated();
    });
    const tracked = operation.finally(() => {
      if (this.loginOperation === tracked) this.loginOperation = null;
    });
    this.loginOperation = tracked;
    return tracked;
  }

  async probeAuthentication() {
    if (!this.view || this.view.webContents.isDestroyed()) return this.snapshot();
    const url = this.view.webContents.getURL();
    if (url === IDLE_BROWSER_URL) {
      this.setState({
        status: this.state.authenticated ? "ready" : "signed-out",
        message: this.state.authenticated ? "No active task" : "Sign in to ChatGPT",
        url,
      });
      return this.snapshot();
    }
    if (!url.startsWith(CHATGPT_ORIGIN)) {
      this.setState({ status: "signed-out", message: "Sign in to ChatGPT", authenticated: false, url });
      return this.snapshot();
    }
    const probe = (contents) => contents.executeJavaScript(`(() => {
      const composer = ${visibleElementScript(COMPOSER_SELECTOR)};
      return { composer: Boolean(composer), readyState: document.readyState };
    })()`, true).catch(() => ({ composer: false, readyState: "unknown" }));
    let result = await probe(this.view.webContents);
    if (!result.composer && this.authView && !this.authView.webContents.isDestroyed()) {
      const authResult = await probe(this.authView.webContents);
      if (authResult.composer) {
        result = authResult;
        this.closeAuthView(this.authView, true);
      }
    }
    if (result.composer) {
      const wasAuthenticated = this.state.authenticated;
      const availability = this.activeTraceId
        ? { status: "running", message: "ChatGPT is working" }
        : this.manualOperation
          ? {}
          : { status: "ready", message: "ChatGPT is ready" };
      this.setState({ ...availability, authenticated: true, url });
      if (!wasAuthenticated) this.logger.info("browser.authenticated", { url });
    } else {
      const loaded = result.readyState === "complete";
      this.setState({
        status: loaded ? "signed-out" : "loading",
        message: loaded ? "Sign in to ChatGPT" : "Waiting for ChatGPT",
        authenticated: false,
        url,
      });
    }
    return this.snapshot();
  }

  async waitForAuthenticated(timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.probeAuthentication();
      if (state.authenticated) return state;
      await sleep(750);
    }
    throw new Error("ChatGPT login was not completed before the timeout");
  }

  async smokeTest() {
    return await this.withManualOperation("browser smoke test", () => this.runSmokeTest());
  }

  async runSmokeTest() {
    this.show();
    this.setState({ status: "testing", message: "Running browser smoke test" });
    this.logger.info("smoke.started");
    await this.view.webContents.loadURL(TEMPORARY_CHAT_URL);
    await this.waitForAuthenticated(60_000);

    const effortResult = await this.selectHighEffort();
    this.logger.info("smoke.effort_selected", effortResult);
    const beforeCount = await this.assistantTurnCount();
    const focused = await this.view.webContents.executeJavaScript(`(() => {
      const composer = ${visibleElementScript(COMPOSER_SELECTOR)};
      if (!composer) return false;
      composer.focus();
      if ('value' in composer) composer.value = '';
      else composer.textContent = '';
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
      return true;
    })()`, true);
    if (!focused) throw new Error("ChatGPT composer was not available for the smoke test");
    this.view.webContents.focus();
    this.view.webContents.insertText(SMOKE_TEXT);
    await sleep(250);
    const sent = await this.view.webContents.executeJavaScript(`(() => {
      const button = ${visibleElementScript('[data-testid="send-button"]')};
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`, true);
    if (!sent) throw new Error("ChatGPT send button did not become available for the smoke test");

    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const outcome = await this.view.webContents.executeJavaScript(`(() => {
        const turns = Array.from(document.querySelectorAll('section[data-testid^="conversation-turn-"][data-turn="assistant"]'));
        const latest = turns.at(-1);
        const text = latest ? (latest.innerText || latest.textContent || '') : '';
        const stopVisible = Array.from(document.querySelectorAll('[data-testid="stop-button"]')).some((button) => {
          const rect = button.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        return { count: turns.length, text, stopVisible };
      })()`, true);
      if (outcome.count > beforeCount && outcome.text.includes(SMOKE_EXPECTED) && !outcome.stopVisible) {
        this.logger.info("smoke.completed", { responseChars: outcome.text.length });
        this.setState({ status: "ready", message: "Smoke test passed", authenticated: true });
        return { ok: true, effort: effortResult.effort, response: SMOKE_EXPECTED };
      }
      await sleep(500);
    }
    this.logger.error("smoke.timed_out");
    this.setState({ status: "error", message: "Smoke test timed out" });
    throw new Error("ChatGPT smoke test timed out before the expected answer appeared");
  }

  async clickBrowserPoint(point) {
    const contents = this.view.webContents;
    try {
      await this.dispatchTrustedClick({
        endpoint: `http://127.0.0.1:${this.cdpPort}`,
        pageUrl: contents.getURL(),
        point,
      });
    } catch (error) {
      throw new Error(
        `ChatGPT trusted browser click failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  pressBrowserKey(keyCode) {
    const contents = this.view.webContents;
    contents.sendInputEvent({ type: "keyDown", keyCode });
    contents.sendInputEvent({ type: "keyUp", keyCode });
  }

  async readEffortControl() {
    return this.view.webContents.executeJavaScript(`(() => {
      /* effort-control-read */
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const composer = ${visibleElementScript(COMPOSER_SELECTOR)};
      const form = composer?.closest('form');
      const controls = Array.from(form?.querySelectorAll(
        'button[aria-haspopup="menu"][data-tone="neutral"]'
      ) || []).filter(visible);
      const control = controls.at(-1);
      if (!control) {
        return {
          found: false,
          composer: Boolean(composer),
          form: Boolean(form),
          readyState: document.readyState,
          url: location.href,
        };
      }
      const rect = control.getBoundingClientRect();
      return {
        found: true,
        label: normalize(control.innerText || control.textContent),
        point: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
        composer: Boolean(composer),
        form: true,
        readyState: document.readyState,
        url: location.href,
      };
    })()`, true);
  }

  async waitForEffortControl(timeoutMs, pollMs) {
    const deadline = Date.now() + timeoutMs;
    let control;
    do {
      control = await this.readEffortControl();
      if (control.found) return control;
      await sleep(pollMs);
    } while (Date.now() < deadline);
    throw new Error(
      `ChatGPT effort control did not become ready`
      + ` (url=${control?.url || this.view.webContents.getURL()};`
      + ` document=${control?.readyState || "unknown"}; composer=${control?.composer ? "ready" : "missing"};`
      + ` composerForm=${control?.form ? "ready" : "missing"})`,
    );
  }

  async readEffortMenu(targetIndex) {
    return await this.view.webContents.executeJavaScript(`(() => {
        /* effort-menu-read */
        const targetIndex = ${targetIndex};
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const visible = (element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const candidates = Array.from(document.querySelectorAll(
          '[data-testid="composer-intelligence-picker-content"][role="group"]'
        )).filter(visible).map((menu) => ({
          menu,
          items: Array.from(menu.querySelectorAll('[role="menuitemradio"]')).filter(visible),
        }));
        const candidate = candidates.at(-1);
        const target = candidate?.items[targetIndex];
        if (!candidate || !target) {
          return { open: Boolean(candidate), count: candidate?.items.length || 0, target: null };
        }
        const rect = target.getBoundingClientRect();
        return {
          open: true,
          count: candidate.items.length,
          target: {
            label: normalize(target.innerText || target.textContent),
            point: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
          },
        };
      })()`, true);
  }

  async waitForEffortMenu(targetIndex, timeoutMs, pollMs) {
    const deadline = Date.now() + timeoutMs;
    let menu;
    do {
      menu = await this.readEffortMenu(targetIndex);
      if (menu.target) return menu;
      await sleep(pollMs);
    } while (Date.now() < deadline);
    throw new Error(
      `ChatGPT effort menu did not expose item index ${targetIndex}`
      + ` (open=${menu?.open === true}; itemCount=${menu?.count || 0})`,
    );
  }

  async selectHighEffort({
    readyTimeoutMs = 70_000,
    optionTimeoutMs = 20_000,
    confirmTimeoutMs = 40_000,
    pollMs = 200,
  } = {}) {
    const targetIndex = 2;
    const control = await this.waitForEffortControl(readyTimeoutMs, pollMs);
    let menu = await this.readEffortMenu(targetIndex);
    if (!menu.target) {
      await this.clickBrowserPoint(control.point);
      menu = await this.waitForEffortMenu(targetIndex, optionTimeoutMs, pollMs);
    }
    if (control.label === menu.target.label) {
      this.pressBrowserKey("Escape");
      return { effort: "High", changed: false };
    }
    await this.clickBrowserPoint(menu.target.point);

    const deadline = Date.now() + confirmTimeoutMs;
    let confirmed;
    do {
      confirmed = await this.readEffortControl();
      if (confirmed.found && confirmed.label === menu.target.label) {
        return { effort: "High", changed: true };
      }
      await sleep(pollMs);
    } while (Date.now() < deadline);
    throw new Error(
      `ChatGPT did not confirm effort item index ${targetIndex}`
      + ` (current=${JSON.stringify(confirmed?.label || null)})`,
    );
  }

  async assistantTurnCount() {
    return this.view.webContents.executeJavaScript("document.querySelectorAll('section[data-testid^=\"conversation-turn-\"][data-turn=\"assistant\"]').length", true);
  }

  async verifyConnector(appName) {
    return await this.withManualOperation("connector verification", () => this.runConnectorVerification(appName));
  }

  async runConnectorVerification(appName) {
    if (typeof appName !== "string" || !appName.trim() || appName.length > 80) throw new Error("Connector name is invalid");
    this.show();
    this.setState({ status: "testing", message: "Checking ChatGPT connector" });
    await this.view.webContents.loadURL(TEMPORARY_CHAT_URL);
    await this.waitForAuthenticated(60_000);
    await this.selectHighEffort();
    const composerReady = await this.view.webContents.executeJavaScript(`(() => {
      const composer = ${visibleElementScript(COMPOSER_SELECTOR)};
      if (!composer) return false;
      composer.focus();
      if ('value' in composer) composer.value = '';
      else composer.textContent = '';
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
      return true;
    })()`, true);
    if (!composerReady) throw new Error("ChatGPT composer was not available for the connector check");
    this.view.webContents.insertText(`@${appName.trim()}`);
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const found = await this.view.webContents.executeJavaScript(`(() => {
        const expected = ${JSON.stringify(appName.trim())};
        return Array.from(document.querySelectorAll('[role="group"], [role="option"], [role="menuitem"]')).some((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && (element.innerText || element.textContent || '').includes(expected);
        });
      })()`, true).catch(() => false);
      if (found) {
        await this.view.webContents.executeJavaScript(`(() => {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
          const composer = ${visibleElementScript(COMPOSER_SELECTOR)};
          if (composer) {
            if ('value' in composer) composer.value = '';
            else composer.textContent = '';
            composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
          }
        })()`, true).catch(() => {});
        this.logger.info("connector.verified", { appName: appName.trim() });
        this.setState({ status: "ready", message: "ChatGPT connector is available", authenticated: true });
        return { ok: true, appName: appName.trim() };
      }
      await sleep(250);
    }
    this.setState({ status: "error", message: "ChatGPT connector was not found", authenticated: true });
    throw new Error(`ChatGPT connector ${JSON.stringify(appName.trim())} was not found; attach the tunnel and use that exact name`);
  }

  async inspectSession(detectPro = false) {
    return await this.withManualOperation("session inspection", () => this.runSessionInspection(detectPro));
  }

  async runSessionInspection(detectPro = false) {
    const startedIdle = this.view.webContents.getURL() === IDLE_BROWSER_URL;
    if (startedIdle) await this.view.webContents.loadURL(TEMPORARY_CHAT_URL);
    const state = await this.probeAuthentication();
    if (!state.authenticated) {
      throw new Error("The embedded ChatGPT session is not authenticated");
    }
    const url = this.view.webContents.getURL();
    const parsed = new URL(url);
    if (parsed.origin !== CHATGPT_ORIGIN || parsed.searchParams.get("temporary-chat") !== "true") {
      throw new Error(`The embedded browser is not on Temporary Chat (${url})`);
    }
    let proAvailable;
    if (detectPro) {
      const control = await this.waitForEffortControl(30_000, 200);
      let menu = await this.readEffortMenu(0);
      if (!menu.target) {
        await this.clickBrowserPoint(control.point);
        menu = await this.waitForEffortMenu(0, 20_000, 200);
      }
      proAvailable = menu.count >= 5;
      this.pressBrowserKey("Escape");
    }
    if (startedIdle) await this.returnToIdle();
    return { authenticated: true, temporary: true, url, ...(detectPro ? { proAvailable } : {}) };
  }

  async withManualOperation(name, action) {
    if (this.activeTraceId) {
      throw new Error(`ChatGPT browser is running Codex turn ${this.activeTraceId}`);
    }
    if (this.manualOperation) {
      throw new Error(`ChatGPT browser is already busy with ${this.manualOperation}`);
    }
    this.manualOperation = name;
    try {
      return await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setState({ status: "error", message });
      throw error;
    } finally {
      this.manualOperation = null;
    }
  }

  writeDescriptor() {
    const descriptor = {
      version: 1,
      kind: "codex-web-gpt-launcher",
      pid: process.pid,
      endpoint: `http://127.0.0.1:${this.cdpPort}`,
      control: this.control,
      helper: this.helper,
      partition: "persist:codex-web-gpt-chatgpt",
      idleUrl: IDLE_BROWSER_URL,
      createdAt: new Date().toISOString(),
    };
    writePrivateFileAtomic(this.descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  }

  destroy() {
    try {
      const current = JSON.parse(fs.readFileSync(this.descriptorPath, "utf8"));
      if (current.pid === process.pid) fs.rmSync(this.descriptorPath, { force: true });
    } catch {}
    this.closeAuthView(this.authView, true);
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close();
  }
}

module.exports = {
  allowedAuthUrl,
  BrowserHost,
  CHATGPT_VIEWPORT_CSS,
  IDLE_BROWSER_URL,
  TEMPORARY_CHAT_URL,
};
