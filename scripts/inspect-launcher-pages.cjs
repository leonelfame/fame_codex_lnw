const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright-core");

const descriptorPath = path.join(
  os.homedir(),
  ".codex-chatgpt-web",
  "runtime",
  "launcher-browser.json",
);
const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
if (typeof descriptor.surfaceId !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(descriptor.surfaceId)) {
  throw new Error("Launcher descriptor does not contain a valid owned surface id");
}

void (async () => {
  const browser = await chromium.connectOverCDP(descriptor.endpoint, { timeout: 20_000 });
  try {
  const pages = browser.contexts().flatMap((context, contextIndex) => (
    context.pages().map((page, pageIndex) => ({ contextIndex, pageIndex, page }))
  ));
  let smokeResult;
  if (process.argv.includes("--smoke")) {
    const renderer = pages.find(({ page }) => page.url().startsWith("http://127.0.0.1:4178"));
    if (!renderer) throw new Error("Launcher renderer page was not found");
    smokeResult = await renderer.page.evaluate(async () => {
      if (!globalThis.codexWebLauncher) throw new Error("Launcher renderer API is unavailable");
      await globalThis.codexWebLauncher.setBrowserBounds({
        x: 170,
        y: 0,
        width: Math.max(1, innerWidth - 170),
        height: Math.max(1, innerHeight),
      });
      await globalThis.codexWebLauncher.setBrowserSurfaceActive(true);
      await globalThis.codexWebLauncher.showBrowser();
      try {
        return await globalThis.codexWebLauncher.smokeTest();
      } finally {
        await globalThis.codexWebLauncher.setBrowserSurfaceActive(false);
      }
    });
  }
  const inspected = await Promise.all(pages.map(async ({ contextIndex, pageIndex, page }) => ({
    contextIndex,
    pageIndex,
    url: page.url(),
    title: await page.title().catch(() => ""),
    state: await page.evaluate(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && rect.width > 0
          && rect.height > 0;
      };
      const menu = Array.from(document.querySelectorAll(
        '[data-testid="composer-intelligence-picker-content"][role="group"]',
      )).filter(visible).at(-1);
      const items = menu
        ? Array.from(menu.querySelectorAll('[role="menuitemradio"]')).filter(visible)
        : [];
      const control = Array.from(document.querySelectorAll(
        'button[aria-haspopup="menu"][data-tone="neutral"]',
      )).filter(visible).at(-1);
      return {
        surfaceId: globalThis.__CODEX_WEB_GPT_SURFACE_ID__,
        menuItemCount: items.length,
        controlLabel: (control?.textContent || "").replace(/\s+/g, " ").trim(),
      };
    }).catch(error => ({ error: error instanceof Error ? error.message : String(error) })),
  })));
    console.log(JSON.stringify({
      descriptorSurfaceId: descriptor.surfaceId,
      ...(process.argv.includes("--smoke") ? { smokeResult } : {}),
      pages: inspected,
    }, null, 2));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
