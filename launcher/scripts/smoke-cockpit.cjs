// Build the renderer first, then run: node launcher/scripts/smoke-cockpit.cjs
// Uses a temporary browser context and fake IPC; never opens the real profile.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { createStateStore } = require("../electron/state.cjs");

const launcherRoot = path.resolve(__dirname, "..");
const artifacts = path.join(launcherRoot, "artifacts", "cockpit");
const defaults = createStateStore(path.join(artifacts, "unused-fixture-state.json")).read();

function installFixture({ defaults, language = "en", platform = "win32", statePatch = {}, browserPatch = {} }) {
  const listeners = new Map();
  const state = {
    ...defaults, language, onboardingComplete: true, coreSetupComplete: true,
    codexCatalogVerified: true, mcpSetupComplete: true, experimentalBiggerContext: true,
    ...statePatch,
  };
  const browser = {
    status: "ready", message: "", url: "https://chatgpt.com/", title: "ChatGPT",
    authenticated: true, visible: false, surfaceActive: false, loading: false,
    canGoBack: true, canGoForward: false, zoomFactor: 1, activeTabId: "primary", maxTabs: 5,
    tabs: [
      { id: "primary", title: "ChatGPT", status: "ready", loading: false, active: true, closable: false },
      { id: "task", title: "Codex workspace", status: "ready", loading: false, active: false, closable: true },
    ],
    ...browserPatch,
  };
  const logs = [{ at: "2026-09-14T10:00:00Z", level: "info", event: "browser.ready", detail: {} }];
  const snapshot = {
    state, browser, logs, version: "5.0.16", platform, profile: "production",
    profilePaths: { coreHome: "fixture", codexHome: "fixture", userData: "fixture" },
    connectorName: "Fame Codex", connectorNames: { manual: "Fame Codex", automatic: "Fame Codex" },
    mcpCredentialsConfigured: true, urls: { github: "", x: "", connectors: "", tunnels: "", keys: "" },
    packaged: false, smokePassed: true, operation: null, update: { status: "up-to-date" },
  };
  const emit = (name, value) => listeners.get(name)?.forEach(listener => listener(structuredClone(value)));
  let bounds = null;
  let nativeProbe = null;
  const drawNativeProbe = () => {
    if (!document.body) return;
    if (!nativeProbe) {
      nativeProbe = document.createElement("div");
      nativeProbe.id = "native-browser-probe";
      nativeProbe.textContent = "Simulated native Browser — test fixture";
      nativeProbe.style.cssText = "position:fixed;z-index:2147483647;background:#13151d;color:#b5bfd8;display:none;place-items:center;font:14px sans-serif";
      document.body.append(nativeProbe);
    }
    nativeProbe.style.display = browser.visible && browser.surfaceActive && bounds ? "grid" : "none";
    if (bounds) Object.assign(nativeProbe.style, {
      left: `${bounds.x}px`, top: `${bounds.y}px`, width: `${bounds.width}px`, height: `${bounds.height}px`,
    });
  };
  window.cockpitFixture = {
    snapshot, calls: [], emit,
    setBrowser(patch) { Object.assign(browser, patch); emit("onBrowserState", browser); drawNativeProbe(); },
    setState(patch) { Object.assign(state, patch); emit("onStateChanged", state); },
    log(event, level = "info") {
      const record = { at: new Date().toISOString(), level, event, detail: {} };
      logs.push(record);
      emit("onLog", record);
    },
  };
  window.codexWebLauncher = new Proxy({}, {
    get(_, name) {
      if (name.startsWith("on")) return listener => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(listener);
        return () => listeners.get(name).delete(listener);
      };
      return async (...args) => {
        window.cockpitFixture.calls.push([name, ...args]);
        switch (name) {
          case "snapshot": return structuredClone(snapshot);
          case "windowState": return { fullScreen: false, maximized: false };
          case "bridgeStatus": return { installed: true, active: true, errors: [] };
          case "setBrowserSurfaceActive": browser.surfaceActive = args[0]; drawNativeProbe(); return { ...browser };
          case "setBrowserBounds": bounds = args[0]; drawNativeProbe(); return true;
          case "showBrowser": case "hideBrowser":
            window.cockpitFixture.setBrowser({ visible: name === "showBrowser" }); return { ...browser };
          case "selectBrowserTab":
            browser.activeTabId = args[0];
            window.cockpitFixture.setBrowser({ tabs: browser.tabs.map(tab => ({ ...tab, active: tab.id === args[0] })) });
            return { ...browser };
          case "setLanguage": Object.assign(state, { language: args[0] }); return { ...state };
          case "setPreference": Object.assign(state, { [args[0]]: args[1] }); return { ...state };
          case "logs": return [...logs];
          case "exportLogs": return null;
          case "navigateBrowser": case "zoomBrowser": case "copyManualPrompt": case "confirmManualSent": return { ...browser };
          default: throw new Error(`Unexpected fixture IPC: ${name}`);
        }
      };
    },
  });
}

async function assertBounds(page) {
  await page.waitForFunction(() => {
    const slot = document.querySelector(".browser-viewport");
    const last = window.cockpitFixture.calls.filter(call => call[0] === "setBrowserBounds").at(-1)?.[1];
    if (!slot || !last || !window.cockpitFixture.snapshot.browser.surfaceActive) return false;
    const rect = slot.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && ["x", "y", "width", "height"].every(key => Math.abs(rect[key] - last[key]) < 1);
  });
  const overlap = await page.evaluate(() => {
    const slot = document.querySelector(".browser-viewport").getBoundingClientRect();
    return [".cockpit-header", ".cockpit-dock", ".cockpit-settings", ".cockpit-activity"].filter(selector => {
      const el = document.querySelector(selector);
      if (!el || !el.checkVisibility()) return false;
      const rect = el.getBoundingClientRect();
      return Math.min(slot.right, rect.right) - Math.max(slot.left, rect.left) > 1
        && Math.min(slot.bottom, rect.bottom) - Math.max(slot.top, rect.top) > 1;
    });
  });
  assert.deepEqual(overlap, [], "native browser must not cover cockpit controls");
}

async function assertWindowControlsClear(page, platform) {
  const conflicts = await page.evaluate(platform => {
    const left = platform === "darwin" ? 0 : innerWidth - 140;
    const right = platform === "darwin" ? 80 : innerWidth;
    return [...document.querySelectorAll(".cockpit-header button")].filter(el => {
      if (!el.checkVisibility()) return false;
      const rect = el.getBoundingClientRect();
      return rect.top < 46 && rect.bottom > 0 && rect.right > left && rect.left < right;
    }).map(el => el.textContent.trim());
  }, platform);
  assert.deepEqual(conflicts, [], `${platform} native window controls remain clear`);
}

async function main() {
  fs.mkdirSync(artifacts, { recursive: true });
  const { preview } = await import("vite");
  const server = await preview({ root: launcherRoot, configFile: false, preview: { host: "127.0.0.1", port: 4186, strictPort: true } });
  let browser;
  let activePage;
  try {
    const executablePath = process.env.COCKPIT_BROWSER_PATH;
    browser = await chromium.launch(executablePath ? { executablePath, headless: true } : { channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    activePage = page;
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(installFixture, { defaults });
    await page.goto("http://127.0.0.1:4186");
    await page.locator(".cockpit-dock").waitFor();
    assert.equal(await page.locator(".app-sidebar").count(), 0, "legacy sidebar is removed");
    await assertBounds(page);
    await assertWindowControlsClear(page, "win32");
    await page.screenshot({ path: path.join(artifacts, "workspace.png") });
    await page.evaluate(() => { window.originalBrowserSlot = document.querySelector(".browser-viewport"); });
    const dock = page.locator(".cockpit-dock");
    const settings = page.locator(".cockpit-header").getByRole("button", { name: "Settings", exact: true });
    await page.evaluate(() => window.cockpitFixture.setBrowser({ visible: true, status: "running" }));
    await settings.click();
    await page.locator(".cockpit-settings").waitFor();
    await assertBounds(page);
    const keepRunning = page.locator(".cockpit-settings .setting-row").filter({ hasText: "Keep server running when window closes" }).getByRole("switch");
    assert.equal(await keepRunning.getAttribute("aria-checked"), "true");
    await keepRunning.click();
    assert.equal(await keepRunning.getAttribute("aria-checked"), "false");
    await page.locator(".cockpit-settings").getByRole("button", { name: "English", exact: true }).click();
    await page.getByRole("listbox").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("listbox").waitFor({ state: "hidden" });
    assert.equal(await page.locator(".cockpit-settings").isVisible(), true, "nested Escape keeps Settings open");
    await page.screenshot({ path: path.join(artifacts, "settings.png") });
    await page.keyboard.press("Escape");
    await page.locator(".cockpit-settings").waitFor({ state: "hidden" });
    assert.equal(await settings.evaluate(el => el === document.activeElement), true, "Escape returns focus");
    await assertBounds(page);
    await settings.click();
    assert.equal(await keepRunning.getAttribute("aria-checked"), "false", "saved setting survives panel reopen");
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("button", { name: "Back", exact: true }).isDisabled(), true);

    await dock.getByRole("button", { name: "Activity", exact: true }).click();
    await page.locator(".cockpit-activity").waitFor();
    await assertBounds(page);
    await page.getByRole("button", { name: "Export safe log", exact: true }).click();
    assert.ok(await page.evaluate(() => window.cockpitFixture.calls.some(call => call[0] === "exportLogs")));
    await page.evaluate(() => { for (let i = 0; i < 305; i++) window.cockpitFixture.log(`event.${i}`); });
    await page.waitForFunction(() => document.querySelectorAll(".activity-row").length === 300);
    assert.match(await page.locator(".activity-row").first().innerText(), /304/);
    await page.screenshot({ path: path.join(artifacts, "activity.png") });
    await page.locator(".cockpit-activity").getByRole("button", { name: /expand/i }).click();
    await page.waitForFunction(() => !window.cockpitFixture.snapshot.browser.surfaceActive);
    await page.screenshot({ path: path.join(artifacts, "activity-expanded.png") });
    await page.locator(".cockpit-activity").getByRole("button", { name: /collapse/i }).click();
    await assertBounds(page);
    await dock.getByRole("button", { name: "Activity", exact: true }).click();
    await page.locator(".cockpit-activity").waitFor({ state: "hidden" });
    await page.evaluate(() => window.cockpitFixture.log("while.closed"));

    await dock.getByRole("button", { name: "Connections", exact: true }).click();
    await page.waitForFunction(() => !window.cockpitFixture.snapshot.browser.surfaceActive);
    await page.getByRole("button", { name: "MCP", exact: true }).click();
    await page.screenshot({ path: path.join(artifacts, "connections-mcp.png") });
    await page.getByRole("button", { name: "Setup", exact: true }).click();
    await page.screenshot({ path: path.join(artifacts, "connections-setup.png") });
    await dock.getByRole("button", { name: "Activity", exact: true }).click();
    await page.locator(".cockpit-activity").getByRole("button", { name: /expand/i }).click();
    assert.equal(await page.locator(".cockpit-connections").isVisible(), false, "expanded Activity replaces Connections");
    await page.locator(".cockpit-activity").getByRole("button", { name: /collapse/i }).click();
    assert.equal(await page.locator(".cockpit-connections").isVisible(), true, "collapsing restores Connections");
    await dock.getByRole("button", { name: "Activity", exact: true }).click();
    await dock.getByRole("button", { name: "Workspace", exact: true }).click();
    await assertBounds(page);
    assert.equal(await page.evaluate(() => window.originalBrowserSlot === document.querySelector(".browser-viewport")), true, "native slot survives navigation");
    await dock.getByRole("button", { name: "Activity", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".activity-row")?.textContent.includes("while"));
    await dock.getByRole("button", { name: "Activity", exact: true }).click();
    await settings.click();
    await page.evaluate(() => window.cockpitFixture.setBrowser({
      status: "ready", tabs: [{ id: "manual", title: "Manual turn", active: true, closable: true,
        status: "ready", loading: false, interactionMode: "manual", manualState: "awaiting-user",
        manualDeadlineAt: new Date(Date.now() + 30000).toISOString(), canCopyPrompt: true, canConfirmSent: true }],
    }));
    await page.locator(".manual-turn-guide").waitFor();
    await page.locator(".cockpit-settings").waitFor({ state: "hidden" });
    await assertBounds(page);
    await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
    assert.ok(await page.evaluate(() => window.cockpitFixture.calls.some(call => call[0] === "copyManualPrompt" && call[1] === "manual")));
    const destructive = await page.evaluate(() => window.cockpitFixture.calls.filter(call => ["hideBrowser", "closeBrowserTab", "cancelTurns", "logoutChatGpt", "uninstallIntegration"].includes(call[0])));
    assert.deepEqual(destructive, [], "navigation does not cancel work or alter authentication");

    await page.evaluate(() => window.cockpitFixture.setBrowser({ tabs: [], status: "ready", visible: false }));
    await page.setViewportSize({ width: 760, height: 700 });
    await settings.click();
    await page.waitForFunction(() => !window.cockpitFixture.snapshot.browser.surfaceActive);
    await page.screenshot({ path: path.join(artifacts, "compact-settings.png") });
    await page.keyboard.press("Escape");
    await assertBounds(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => window.cockpitFixture.setState({ language: "th" }));
    await page.waitForFunction(() => document.documentElement.lang === "th");
    for (const width of [1280, 760, 375]) {
      await page.setViewportSize({ width, height: 800 });
      await assertBounds(page);
      await assertWindowControlsClear(page, "win32");
      const overflow = await page.evaluate(() => [".cockpit-header", ".cockpit-dock", ".browser-toolbar"].filter(selector => {
        const el = document.querySelector(selector); return el && el.scrollWidth > el.clientWidth + 1;
      }));
      assert.deepEqual(overflow, [], `Thai layout fits ${width}px`);
      await page.screenshot({ path: path.join(artifacts, `thai-${width}.png`) });
    }
    const { copyFor } = await import("../src/i18n.ts");
    for (const mode of ["automatic", "manual"]) {
      const firstRun = await browser.newPage({ viewport: { width: 1000, height: 800 } });
      firstRun.setDefaultTimeout(7000);
      firstRun.on("pageerror", error => errors.push(error.message));
      await firstRun.addInitScript(installFixture, { defaults,
        statePatch: { browserInteractionMode: mode, coreSetupComplete: false, codexCatalogVerified: false, mcpSetupComplete: false },
        browserPatch: { authenticated: false, status: "signed-out" },
      });
      await firstRun.goto("http://127.0.0.1:4186");
      await firstRun.locator(".cockpit-dock").waitFor();
      await firstRun.getByRole("heading", { name: mode === "manual" ? "MCP" : copyFor("en").setupTitle, exact: true }).waitFor();
      assert.equal(await firstRun.evaluate(() => window.cockpitFixture.snapshot.browser.surfaceActive), false);
      await firstRun.screenshot({ path: path.join(artifacts, `first-run-${mode}.png`) });
      await firstRun.close();
    }
    const mac = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    mac.on("pageerror", error => errors.push(error.message));
    await mac.addInitScript(installFixture, { defaults, platform: "darwin" });
    await mac.goto("http://127.0.0.1:4186");
    await mac.locator(".cockpit-dock").waitFor();
    await assertBounds(mac);
    await assertWindowControlsClear(mac, "darwin");
    await mac.screenshot({ path: path.join(artifacts, "mac-chrome-layout.png") });
    await mac.close();
    assert.deepEqual(errors, [], "no renderer exceptions");
    console.log("Cockpit smoke passed: stable Browser slot, native bounds, panel/dock navigation, running/manual flows, logs, keyboard, Thai and responsive layouts.");
    console.log(`Screenshots: ${artifacts}`);
  } catch (error) {
    await activePage?.screenshot({ path: path.join(artifacts, "failure.png") }).catch(() => {});
    throw error;
  } finally {
    await browser?.close();
    await new Promise(resolve => server.httpServer.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
