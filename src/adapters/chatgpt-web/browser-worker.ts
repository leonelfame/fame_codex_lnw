import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { atomicWriteFile, expandUserPath, getConfigDir } from "../../config";
import type { CodexProviderConfig } from "../../types";
import { parseDataUrl } from "../image";
import { ChatGptMarkdownStream } from "./markdown";
import { resolveChatGptWebModelMode, type ChatGptWebCapabilities, type ChatGptWebModelMode } from "./model";
import type { CompiledChatGptWebPrompt, ChatGptWebPromptImage } from "./prompt";
import { assertChatGptWebInputWithinLimit, estimateCompiledChatGptWebInputTokens } from "./usage";
import { assertAuthenticatedChatGptPage, assertTemporaryChatPage, CHATGPT_TEMPORARY_CHAT_URL } from "../../chatgpt-session";
import { loginVerificationMarkerPath } from "../../browser-login";

const workers = new Map<string, ChatGptBrowserWorker>();

export interface BrowserTurn {
  traceId: string;
  modelId: string;
  reasoning?: string;
  capabilities: ChatGptWebCapabilities;
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

export function chatGptEffortLabelsMatch(current: string, desired: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  return normalize(current) === normalize(desired);
}

export function redactChatGptUiDiagnostic(value: string): string {
  return value
    .replace(/<codex_context_json>[\s\S]*?<\/codex_context_json>/gi, "<codex_context_json>[redacted]</codex_context_json>")
    .replace(/\b(turn|binding|call)_[A-Za-z0-9_-]{12,}\b/g, "$1_[redacted]");
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

  private discardBrowser(): void {
    const browser = this.browser;
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
    if (browser) void browser.close().catch(() => {});
  }

  private async runStage<T>(traceId: string, stage: string, timeoutMs: number, action: () => Promise<T>): Promise<T> {
    console.info(`[chatgpt-web] browser turn ${traceId} stage=${stage} started`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const timeout = new Promise<never>((_, rejectTimeout) => {
        timer = setTimeout(() => {
          timedOut = true;
          rejectTimeout(new Error(`ChatGPT browser stage timed out: ${stage}`));
        }, timeoutMs);
      });
      const value = await Promise.race([action(), timeout]);
      console.info(`[chatgpt-web] browser turn ${traceId} stage=${stage} completed`);
      return value;
    } catch (error) {
      console.error(`[chatgpt-web] browser turn ${traceId} stage=${stage} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (timedOut) this.discardBrowser();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!existsSync(this.config.storageStatePath) || !existsSync(loginVerificationMarkerPath(this.config.storageStatePath))) {
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

  private async selectModelAndEffort(
    page: Page,
    modelId: string,
    reasoning: string | undefined,
    capabilities: ChatGptWebCapabilities,
  ): Promise<ChatGptWebModelMode> {
    const mode = resolveChatGptWebModelMode(modelId, reasoning, capabilities);
    const currentEffort = page.getByRole("button", {
      name: /^(?:Instant(?:\s+5\.5)?|Medium|High|Extra High|Pro)$/,
    }).last();
    try {
      await currentEffort.waitFor({ state: "visible", timeout: 35_000 });
    } catch {
      throw new Error("ChatGPT rendered the composer but its model/effort control did not become ready");
    }
    if (chatGptEffortLabelsMatch(await currentEffort.innerText(), mode.uiEffortLabel)) return mode;
    await currentEffort.click();
    const effortChoice = page.getByRole("menuitem", { name: mode.uiEffortLabel, exact: true }).or(
      page.getByRole("menuitemradio", { name: mode.uiEffortLabel, exact: true }),
    ).last();
    try {
      await effortChoice.waitFor({ state: "visible", timeout: 10_000 });
    } catch {
      const choices = (await page.locator('[role="menuitem"], [role="menuitemradio"]').allInnerTexts().catch(() => []))
        .map(value => value.replace(/\s+/g, " ").trim())
        .filter(value => /^(?:Instant(?: 5\.5)?|Medium|High|Extra High|Pro)$/.test(value));
      throw new Error(
        `ChatGPT effort ${JSON.stringify(mode.uiEffortLabel)} is unavailable in the authenticated account UI`
        + (choices.length > 0 ? `; available: ${choices.join(", ")}` : ""),
      );
    }
    await effortChoice.click();
    try {
      await page.getByRole("button", { name: mode.uiEffortLabel, exact: true }).last()
        .waitFor({ state: "visible", timeout: 20_000 });
    } catch {
      const visible = await page.getByRole("button", {
        name: /^(?:Instant(?:\s+5\.5)?|Medium|High|Extra High|Pro)$/,
      }).allInnerTexts().catch(() => []);
      throw new Error(
        `ChatGPT did not confirm effort ${JSON.stringify(mode.uiEffortLabel)}`
        + (visible.length > 0 ? `; visible effort control: ${visible.at(-1)!.replace(/\s+/g, " ").trim()}` : ""),
      );
    }
    return mode;
  }

  private async attachedPromptText(page: Page): Promise<string> {
    const composer = page.getByRole("textbox", { name: "Chat with ChatGPT" });
    return composer.evaluate(element => {
      const clone = element.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("[data-inline-selection-pill], [data-inline-selection-pill-cursor-target]")
        .forEach(part => part.remove());
      return [...clone.children]
        .map(child => child.textContent ?? "")
        .join("\n")
        .trimStart();
    }, undefined, { timeout: 10_000 });
  }

  private async assertPromptAttached(page: Page, prompt: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    let observed = "";
    while (Date.now() < deadline) {
      observed = await this.attachedPromptText(page);
      if (observed === prompt) return;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
    }
    let commonPrefix = 0;
    while (commonPrefix < prompt.length && prompt[commonPrefix] === observed[commonPrefix]) commonPrefix += 1;
    throw new Error(
      `ChatGPT composer did not preserve the complete prompt (expectedChars=${prompt.length}, actualChars=${observed.length}, commonPrefixChars=${commonPrefix})`,
    );
  }

  private async attachPrompt(page: Page, prompt: string, localTools: boolean): Promise<void> {
    const composer = page.getByRole("textbox", { name: "Chat with ChatGPT" });
    if (!localTools) {
      await composer.fill(prompt);
      await this.assertPromptAttached(page, prompt);
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
    await this.assertPromptAttached(page, prompt);
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

  private async stalledTurnDiagnostic(page: Page): Promise<string> {
    const assistant = page.locator('[data-message-author-role="assistant"]').last();
    const assistantState = await assistant.count()
      ? await assistant.evaluate(element => {
        const root = element as HTMLElement;
        const descriptors = [...root.querySelectorAll<HTMLElement>("[role], [data-testid], button, [aria-label]")]
          .filter(candidate => {
            const style = getComputedStyle(candidate);
            return style.visibility !== "hidden" && style.display !== "none";
          })
          .slice(-80)
          .map(candidate => ({
            tag: candidate.tagName.toLowerCase(),
            role: candidate.getAttribute("role"),
            testId: candidate.getAttribute("data-testid"),
            ariaLabel: candidate.getAttribute("aria-label"),
            title: candidate.getAttribute("title"),
            text: candidate.innerText.trim().slice(0, 500),
          }));
        return {
          text: root.innerText.trim().slice(0, 2_000),
          descriptors,
        };
      })
      : { text: "", descriptors: [] };
    const overlays = await page.locator('[role="dialog"], [role="alert"], [role="status"]').evaluateAll(elements => (
      elements
        .filter(element => {
          const candidate = element as HTMLElement;
          const style = getComputedStyle(candidate);
          return style.visibility !== "hidden" && style.display !== "none";
        })
        .slice(-30)
        .map(element => {
          const candidate = element as HTMLElement;
          return {
            role: candidate.getAttribute("role"),
            testId: candidate.getAttribute("data-testid"),
            ariaLabel: candidate.getAttribute("aria-label"),
            text: candidate.innerText.trim().slice(0, 1_000),
          };
        })
    )).catch(() => [] as Array<Record<string, string | null>>);
    return redactChatGptUiDiagnostic(JSON.stringify({ assistant: assistantState, overlays }));
  }

  private async runExclusive(turn: BrowserTurn): Promise<string> {
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    const prepared = await turn.prepare();
    try {
      if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const estimatedInputTokens = estimateCompiledChatGptWebInputTokens(prepared, turn.modelId);
      assertChatGptWebInputWithinLimit(estimatedInputTokens, turn.contextWindowTokens);
      const deadline = Date.now() + this.config.turnTimeoutMs;
      const page = await this.runStage(turn.traceId, "browser_page", 30_000, () => this.pageForNewTurn());
      console.info(
        `[chatgpt-web] browser turn ${turn.traceId} opened (promptChars=${prepared.text.length}, estimatedInputTokens=${estimatedInputTokens}, images=${prepared.images.length})`,
      );
      await this.runStage(turn.traceId, "temporary_chat_navigation", 35_000, () => (
        page.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }).then(() => undefined)
      ));
      const composer = page.getByRole("textbox", { name: "Chat with ChatGPT" });
      try {
        await this.runStage(turn.traceId, "composer_ready", 20_000, () => composer.waitFor({ state: "visible", timeout: 15_000 }));
      } catch {
        throw new Error("ChatGPT web login is expired or the Temporary Chat surface is unavailable");
      }
      await this.runStage(turn.traceId, "session_verification", 20_000, async () => {
        await assertAuthenticatedChatGptPage(page);
        await assertTemporaryChatPage(page);
      });
      const mode = await this.runStage(turn.traceId, "effort_selection", 60_000, () => (
        this.selectModelAndEffort(page, turn.modelId, turn.reasoning, turn.capabilities)
      ));
      await this.runStage(turn.traceId, "prompt_attachment", 30_000, () => this.attachPrompt(page, prepared.text, mode.localTools));
      await this.runStage(turn.traceId, "image_attachment", 45_000, () => this.attachImages(page, prepared.images));
      const completionActions = page.locator('[data-testid="copy-turn-action-button"], button[aria-label="Copy response"]');
      const initialCompletionActionCount = await completionActions.count();
      const assistantMessages = page.locator('[data-message-author-role="assistant"]');
      const initialAssistant = assistantMessages.last().locator(".markdown").last();
      const initialAssistantText = await initialAssistant.count() ? (await initialAssistant.innerText()).trim() : "";
      await this.runStage(turn.traceId, "send", 10_000, () => page.getByTestId("send-button").click());

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
            const diagnostic = await this.stalledTurnDiagnostic(page).catch(error => JSON.stringify({
              diagnosticError: error instanceof Error ? error.message : String(error),
            }));
            console.warn(
              `[chatgpt-web] waiting for completed-turn evidence (running=${running}, sawRunning=${sawRunning}, textChars=${snapshot.visibleText.length}, completionActions=${completionActionCount}, initialCompletionActions=${initialCompletionActionCount}, ui=${diagnostic})`,
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
