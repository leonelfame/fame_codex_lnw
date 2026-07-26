import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import type { AppConfig } from "./config";
import { atomicWriteFile } from "./config";

export interface BrowserLoginResult {
  storageStatePath: string;
  accountSurfaceUrl: string;
}

export async function loginToChatGpt(
  config: AppConfig,
  options: { timeoutMs?: number } = {},
): Promise<BrowserLoginResult> {
  if (!existsSync(config.chromeExecutablePath)) {
    throw new Error(`Google Chrome was not found at ${config.chromeExecutablePath}. Pass --chrome with its executable path.`);
  }
  const browser = await chromium.launch({
    executablePath: config.chromeExecutablePath,
    headless: false,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("https://chatgpt.com/?temporary-chat=true", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    process.stdout.write("A single Chrome window is open. Sign in to ChatGPT; setup will continue automatically.\n");
    const composer = page.locator('[data-testid="prompt-textarea"], [contenteditable="true"][data-lexical-editor="true"]').first();
    try {
      await composer.waitFor({ state: "visible", timeout: options.timeoutMs ?? 10 * 60_000 });
    } catch {
      throw new Error("Timed out waiting for a signed-in ChatGPT composer");
    }
    const state = await context.storageState();
    atomicWriteFile(config.storageStatePath, `${JSON.stringify(state)}\n`);
    return { storageStatePath: config.storageStatePath, accountSurfaceUrl: page.url() };
  } finally {
    await browser.close();
  }
}

export function browserLoginStateExists(config: AppConfig): boolean {
  return existsSync(config.storageStatePath);
}

export async function checkBrowserEngine(config: AppConfig): Promise<void> {
  if (!existsSync(config.chromeExecutablePath)) throw new Error(`Google Chrome was not found at ${config.chromeExecutablePath}`);
  const browser = await chromium.launch({
    executablePath: config.chromeExecutablePath,
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    if (await page.evaluate(() => document.readyState) !== "complete") throw new Error("Browser page did not reach complete state");
  } finally {
    await browser.close();
  }
}
