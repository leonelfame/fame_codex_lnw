import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { atomicWriteFile, expandUserPath, getConfigDir } from "../../config";
import type { CodexProviderConfig } from "../../types";
import { parseDataUrl } from "../image";
import { ChatGptMarkdownStream } from "./markdown";
import { resolveChatGptWebModelMode, type ChatGptWebModelMode } from "./model";
import type { CompiledChatGptWebPrompt, ChatGptWebPromptImage } from "./prompt";
import { assertChatGptWebInputWithinLimit, estimateCompiledChatGptWebInputTokens } from "./usage";

const workers = new Map<string, ChatGptBrowserWorker>();

export interface BrowserTurn {
  traceId: string;
  modelId: string;
  reasoning?: string;
  contextWindowTokens?: number;
  prepare: () => Promise<CompiledChatGptWebPrompt & { release: () => void }>;
  abortSignal?: AbortSignal;
  onHeartbeat?: () => void;
  /** Visible ChatGPT reasoning-summary step titles only; never hidden chain-of-thought. */
  onReasoningSummary?: (text: string) => void;
  /** Append-only, structurally stable Markdown chunks. */
  onTextDelta: (delta: string) => void;
}

interface ResolvedBrowserConfig {
  appName: string;
  storageStatePath: string;
  chromeExecutablePath: string;
  turnTimeoutMs: number;
  headed: boolean;
  autoApproveToolCalls: boolean;
}

export function chatGptTurnIsComplete(state: {
  running: boolean;
  currentText: string;
  initialText: string;
  completionActionVisible: boolean;
  completionActionCount: number;
  initialCompletionActionCount: number;
  sawRunning: boolean;
}): boolean {
  return !state.running
    && state.currentText.length > 0
    && state.completionActionVisible
    && (state.completionActionCount > state.initialCompletionActionCount
      || (state.sawRunning && state.currentText !== state.initialText));
}

export class ChatGptCompletionTracker {
  private candidate?: { signature: string; since: number };

  constructor(private readonly stableMs = 750) {}

  update(state: Parameters<typeof chatGptTurnIsComplete>[0], now = Date.now()): boolean {
    if (!chatGptTurnIsComplete(state)) {
      this.candidate = undefined;
      return false;
    }
    const signature = `${state.completionActionCount}\0${state.currentText}`;
    if (this.candidate?.signature !== signature) {
      this.candidate = { signature, since: now };
      return false;
    }
    return now - this.candidate.since >= this.stableMs;
  }
}

function resolveBrowserConfig(provider: CodexProviderConfig): ResolvedBrowserConfig {
  const configured = provider.chatgptWeb ?? {};
  return {
    appName: configured.appName?.trim() || "Codex Native",
    storageStatePath: resolve(expandUserPath(configured.storageStatePath?.trim() || join(getConfigDir(), "browser", "storage-state.json"))),
    chromeExecutablePath: resolve(expandUserPath(configured.chromeExecutablePath?.trim() || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")),
    turnTimeoutMs: configured.turnTimeoutMs ?? 20 * 60_000,
    headed: configured.headed !== false,
    autoApproveToolCalls: configured.autoApproveToolCalls === true,
  };
}

const imageExtensions = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

export function chatGptImageFilePayloads(images: ChatGptWebPromptImage[]): Array<{ name: string; mimeType: string; buffer: Buffer }> {
  if (images.length > 10) throw new Error("ChatGPT web accepts at most 10 input images per Codex turn");
  let totalBytes = 0;
  return images.map(image => {
    const parsed = parseDataUrl(image.imageUrl);
    if (!parsed) throw new Error(`ChatGPT web input image ${image.ref} must be an inline base64 data URL`);
    const extension = imageExtensions.get(parsed.mediaType.toLowerCase());
    if (!extension) throw new Error(`ChatGPT web input image ${image.ref} has unsupported media type: ${parsed.mediaType}`);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(parsed.base64) || parsed.base64.length % 4 !== 0) {
      throw new Error(`ChatGPT web input image ${image.ref} contains invalid base64 data`);
    }
    const buffer = Buffer.from(parsed.base64, "base64");
    if (buffer.length === 0) throw new Error(`ChatGPT web input image ${image.ref} is empty`);
    if (buffer.length > 20_000_000) throw new Error(`ChatGPT web input image ${image.ref} exceeds 20 MB`);
    totalBytes += buffer.length;
    if (totalBytes > 50_000_000) throw new Error("ChatGPT web input images exceed the 50 MB per-turn limit");
    return { name: `${image.ref}.${extension}`, mimeType: parsed.mediaType.toLowerCase(), buffer };
  });
}

export class ChatGptBrowserWorker {
  static forProvider(provider: CodexProviderConfig): ChatGptBrowserWorker {
    const config = resolveBrowserConfig(provider);
    const key = JSON.stringify(config);
    let worker = workers.get(key);
    if (!worker) {
      worker = new ChatGptBrowserWorker(config);
      workers.set(key, worker);
    }
    return worker;
  }

  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private tail: Promise<void> = Promise.resolve();

  private constructor(private readonly config: ResolvedBrowserConfig) {}

  run(turn: BrowserTurn): Promise<string> {
    const run = this.tail.then(() => this.runExclusive(turn));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async close(): Promise<void> {
    await this.tail;
    const browser = this.browser;
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
    if (browser) await browser.close();
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!existsSync(this.config.storageStatePath)) {
      throw new Error(`ChatGPT web login state is missing: ${this.config.storageStatePath}`);
    }
    if (!existsSync(this.config.chromeExecutablePath)) {
      throw new Error(`Configured Chrome executable does not exist: ${this.config.chromeExecutablePath}`);
    }
    this.browser = await chromium.launch({
      executablePath: this.config.chromeExecutablePath,
      headless: !this.config.headed,
    });
    this.context = await this.browser.newContext({ storageState: this.config.storageStatePath });
    this.page = await this.context.newPage();
    return this.page;
  }

  /**
   * A Codex turn owns one isolated Temporary Chat document. Reusing the same
   * ChatGPT SPA page can retain the previous transcript and autocomplete DOM,
   * so an @app lookup may select stale UI from the preceding turn.
   */
  private async pageForNewTurn(): Promise<Page> {
    const previous = await this.ensurePage();
    if (previous.url() === "about:blank") return previous;
    const context = this.context;
    if (!context) throw new Error("ChatGPT web browser context is unavailable");
    const page = await context.newPage();
    this.page = page;
    await previous.close().catch(() => {});
    return page;
  }

  private async selectModelAndEffort(page: Page, modelId: string, reasoning: string | undefined): Promise<ChatGptWebModelMode> {
    const mode = resolveChatGptWebModelMode(modelId, reasoning);
    const pill = page.locator("main button.__composer-pill");
    await pill.waitFor({ state: "visible", timeout: 15_000 });
    await pill.click();
    const modelMenu = page.getByRole("menuitem", { name: mode.uiModelLabel, exact: true });
    await modelMenu.waitFor({ state: "visible", timeout: 5_000 });
    await modelMenu.click();
    const modelChoice = page.getByRole("menuitemradio", { name: mode.uiModelLabel, exact: true }).last();
    await modelChoice.waitFor({ state: "visible", timeout: 5_000 });
    await modelChoice.click();

    await pill.click();
    await page.getByRole("menuitemradio", { name: mode.uiEffortLabel, exact: true }).click();
    const selected = (await pill.textContent())?.trim();
    if (selected !== mode.uiEffortLabel) throw new Error(`ChatGPT web failed to select reasoning effort ${mode.uiEffortLabel}`);
    return mode;
  }

  private async attachPrompt(page: Page, prompt: string, localTools: boolean): Promise<void> {
    const composer = page.getByRole("textbox", { name: "Chat with ChatGPT" });
    if (!localTools) {
      await composer.fill(prompt);
      return;
    }
    await composer.fill(`@${this.config.appName}`);
    const appResult = page.getByRole("group").filter({ hasText: this.config.appName }).last();
    await appResult.waitFor({ state: "visible", timeout: 10_000 });
    await appResult.click();
    const selectedPlugin = composer.getByRole("link", { name: this.config.appName, exact: true });
    await selectedPlugin.waitFor({ state: "visible", timeout: 5_000 });
    await composer.focus();
    await page.keyboard.press("End");
    await page.keyboard.insertText(` ${prompt}`);
  }

  private async attachImages(page: Page, images: ChatGptWebPromptImage[]): Promise<void> {
    if (images.length === 0) return;
    const files = chatGptImageFilePayloads(images);
    const removeButtons = page.locator('button[aria-label^="Remove file "]');
    const existing = await removeButtons.count();
    const input = page.locator('input[data-testid="upload-photos-input"]');
    await input.waitFor({ state: "attached", timeout: 10_000 });
    await input.setInputFiles(files);
    await removeButtons.nth(existing + files.length - 1).waitFor({ state: "visible", timeout: 30_000 });
  }

  private async handleToolConfirmation(page: Page): Promise<boolean> {
    const heading = page.getByText(`Allow ChatGPT to use ${this.config.appName}?`, { exact: true }).last();
    if (!await heading.isVisible().catch(() => false)) return false;
    if (!this.config.autoApproveToolCalls) {
      throw new Error(
        `ChatGPT is waiting for confirmation to use ${this.config.appName}; set chatgptWeb.autoApproveToolCalls=true to authorize per-call "Allow once" clicks`,
      );
    }
    const allowOnce = page.getByRole("button", { name: "Allow once", exact: true }).last();
    await allowOnce.waitFor({ state: "visible", timeout: 5_000 });
    await allowOnce.click();
    return true;
  }

  private async runExclusive(turn: BrowserTurn): Promise<string> {
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    const prepared = await turn.prepare();
    try {
      if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      assertChatGptWebInputWithinLimit(
        estimateCompiledChatGptWebInputTokens(prepared, turn.modelId),
        turn.contextWindowTokens,
      );
      const deadline = Date.now() + this.config.turnTimeoutMs;
      const page = await this.pageForNewTurn();
      console.info(`[chatgpt-web] browser turn ${turn.traceId} opened`);
      await page.goto("https://chatgpt.com/?temporary-chat=true", { waitUntil: "domcontentloaded", timeout: 30_000 });
      const composer = page.getByRole("textbox", { name: "Chat with ChatGPT" });
      try {
        await composer.waitFor({ state: "visible", timeout: 15_000 });
      } catch {
        throw new Error("ChatGPT web login is expired or the Temporary Chat surface is unavailable");
      }
      await page.getByRole("button", { name: "Turn off temporary chat" }).waitFor({ state: "visible", timeout: 5_000 });
      const mode = await this.selectModelAndEffort(page, turn.modelId, turn.reasoning);
      await this.attachPrompt(page, prepared.text, mode.localTools);
      await this.attachImages(page, prepared.images);
      const completionActions = page.locator('[data-testid="copy-turn-action-button"], button[aria-label="Copy response"]');
      const initialCompletionActionCount = await completionActions.count();
      const assistantMessages = page.locator('[data-message-author-role="assistant"]');
      const initialAssistant = assistantMessages.last().locator(".markdown").last();
      const initialAssistantText = await initialAssistant.count() ? (await initialAssistant.innerText()).trim() : "";
      await page.getByTestId("send-button").click();

      let lastHeartbeat = 0;
      let finalText = "";
      let sawRunning = false;
      let loggedCompletionWait = false;
      const sentAt = Date.now();
      const seenReasoningSummaries = new Set<string>();
      const markdownStream = new ChatGptMarkdownStream();
      const completionTracker = new ChatGptCompletionTracker();
      for (;;) {
        if (turn.abortSignal?.aborted) {
          const stop = page.getByRole("button", { name: "Stop answering" });
          if (await stop.isVisible().catch(() => false)) await stop.click().catch(() => {});
          throw new DOMException("ChatGPT web turn aborted", "AbortError");
        }
        if (Date.now() >= deadline) throw new Error("ChatGPT web turn timed out");
        if (Date.now() - lastHeartbeat >= 10_000) {
          turn.onHeartbeat?.();
          lastHeartbeat = Date.now();
        }

        if (mode.localTools && await this.handleToolConfirmation(page)) {
          await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
          continue;
        }

        const reasoningSteps = page.locator('main button:has([data-testid="cot-v5-tool-icon-pile"])');
        const stepTexts = await reasoningSteps.allInnerTexts().catch(() => [] as string[]);
        for (const rawText of stepTexts) {
          const text = rawText.trim();
          if (!text || seenReasoningSummaries.has(text)) continue;
          seenReasoningSummaries.add(text);
          turn.onReasoningSummary?.(text);
        }

        const assistant = assistantMessages.last();
        if (await assistant.count()) {
          const rendered = assistant.locator(".markdown").last();
          const snapshot = await rendered.count()
            ? await rendered.evaluate(element => {
              const root = element as HTMLElement;
              const children = [...root.children];
              return {
                visibleText: root.innerText.trim(),
                fullHtml: root.innerHTML,
                stableHtml: children.slice(0, -1).map(child => child.outerHTML).join(""),
              };
            })
            : { visibleText: "", fullHtml: "", stableHtml: "" };
          const stop = page.getByRole("button", { name: "Stop answering" });
          const running = await stop.isVisible().catch(() => false);
          if (running) sawRunning = true;
          const completionActionCount = await completionActions.count();
          const completionActionVisible = completionActionCount > 0
            && await completionActions.last().isVisible().catch(() => false);
          // ChatGPT can render visible commentary Markdown between tool-status rows. Only a
          // Markdown root accompanied by the response action belongs to the final answer stream.
          if (completionActionVisible) {
            const stableDelta = markdownStream.observeStableHtml(snapshot.stableHtml);
            if (stableDelta) turn.onTextDelta(stableDelta);
          }
          if (completionTracker.update({
            running,
            currentText: snapshot.visibleText,
            initialText: initialAssistantText,
            completionActionVisible,
            completionActionCount,
            initialCompletionActionCount,
            sawRunning,
          })) {
            if (snapshot.visibleText === "api_tool unavailable") {
              throw new Error("ChatGPT selected mode rejected the Codex Native MCP tool (api_tool unavailable)");
            }
            const final = markdownStream.finish(snapshot.fullHtml);
            if (!final.markdown && snapshot.visibleText) {
              throw new Error("ChatGPT completed with visible text that could not be serialized as Markdown");
            }
            if (final.delta) turn.onTextDelta(final.delta);
            finalText = final.markdown;
            break;
          }
          if (!loggedCompletionWait && Date.now() - sentAt >= 30_000) {
            loggedCompletionWait = true;
            console.warn(
              `[chatgpt-web] waiting for completed-turn evidence (running=${running}, sawRunning=${sawRunning}, textChars=${snapshot.visibleText.length}, completionActions=${completionActionCount}, initialCompletionActions=${initialCompletionActionCount})`,
            );
          }
        }
        await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
      }

      if (this.context) {
        const state = await this.context.storageState();
        atomicWriteFile(this.config.storageStatePath, `${JSON.stringify(state)}\n`);
      }
      console.info(`[chatgpt-web] browser turn ${turn.traceId} completed (markdownChars=${finalText.length})`);
      return finalText;
    } finally {
      prepared.release();
    }
  }
}
