import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { readLauncherBrowserHostDescriptor } from "../src/launcher-browser-host";

const descriptorPath = join(homedir(), ".codex-chatgpt-web", "runtime", "launcher-browser.json");
const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
const browser = await chromium.connectOverCDP(descriptor.endpoint);

try {
  const pages = browser.contexts().flatMap((context, contextIndex) => (
    context.pages().map((page, pageIndex) => ({ contextIndex, pageIndex, page }))
  ));
  const inspected = await Promise.all(pages.map(async ({ contextIndex, pageIndex, page }) => ({
    contextIndex,
    pageIndex,
    url: page.url(),
    title: await page.title().catch(() => ""),
    state: await page.evaluate(() => {
      const visible = (element: Element) => {
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
        surfaceId: (globalThis as typeof globalThis & {
          __CODEX_WEB_GPT_SURFACE_ID__?: unknown;
        }).__CODEX_WEB_GPT_SURFACE_ID__,
        menuItemCount: items.length,
        controlLabel: (control?.textContent || "").replace(/\s+/g, " ").trim(),
      };
    }).catch(error => ({ error: error instanceof Error ? error.message : String(error) })),
  })));
  console.log(JSON.stringify({
    descriptorSurfaceId: descriptor.surfaceId,
    pages: inspected,
  }, null, 2));
} finally {
  await browser.close();
}
