import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ChatGptBrowserWorker, ChatGptTurnDomHealthTracker, ChatGptVisibleTraceTracker, chatGptSubmissionEvidence, isChatGptTraceControl, redactChatGptUiDiagnostic } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_INTERNAL_COMPACTION_MARKER, containsChatGptCompactionMarker, stripChatGptTransportMarkers } from "../src/adapters/chatgpt-web/prompt";

test("Codex context uses the owned CDP composer transport, never the operating-system clipboard", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource).toContain('composer.fill("")');
  expect(workerSource).toContain("page.keyboard.insertText(prompt)");
  expect(workerSource).toContain("page.keyboard.insertText(` ${prompt}`)");
  expect(workerSource).not.toMatch(/\bclipboard\b|pbcopy|pbpaste/i);
});

test("completed prompts activate the scoped semantic send control", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource).toContain('.getByTestId("send-button")');
  expect(workerSource).toContain('await sendButton.press("Enter")');
  expect(workerSource).not.toContain('getByTestId("send-button").dispatchEvent("click")');
});

test("connector verification and real tool turns share one Playwright selector", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource.match(/this\.selectConnector\(page\)/g)?.length).toBe(2);
  expect(workerSource).toContain('composer.pressSequentially("@c", { delay: 25 })');
  expect(workerSource).toContain('page.locator(\'.__menu-item[tabindex="0"]\')');
  expect(workerSource).toContain('appResult.dispatchEvent("click")');
  expect(workerSource).not.toContain('composer.press("Enter")');
  expect(workerSource).toContain("this.selectedConnectorControl(selectedComposer)");
  expect(workerSource).toContain("'[data-id^=\"plugin:\"][data-keyword]'");
  expect(workerSource).toContain("const selectedComposer = await this.activeComposer(page)");
});

test("active composer resolution waits for exactly one visible editor", async () => {
  const composer = { id: "active" };
  const counts = [2, 1];
  const visibleComposers = {
    count: async () => counts.shift() ?? 1,
    first: () => composer,
  };
  const page = {
    locator: () => ({
      filter: (options: { visible: boolean }) => {
        expect(options).toEqual({ visible: true });
        return visibleComposers;
      },
    }),
  };
  const activeComposer = (ChatGptBrowserWorker.prototype as unknown as {
    activeComposer(page: unknown, timeoutMs?: number): Promise<unknown>;
  }).activeComposer;

  expect(await activeComposer.call({}, page, 500)).toBe(composer);
});

test("read-only multiline context is inserted atomically before exact verification", async () => {
  const prompt = `Act as the model backend for the Codex task encoded below.\n${"x".repeat(44_550)}`;
  const calls: Array<[string, string?]> = [];
  let asserted = "";
  const composer = {
    fill: async (value: string) => { calls.push(["fill", value]); },
    focus: async () => { calls.push(["focus"]); },
  };
  const page = {
    keyboard: {
      insertText: async (value: string) => { calls.push(["insertText", value]); },
    },
  };
  const attachPrompt = (ChatGptBrowserWorker.prototype as unknown as {
    attachPrompt(page: unknown, prompt: string, localTools: boolean): Promise<void>;
  }).attachPrompt;

  await attachPrompt.call({
    activeComposer: async () => composer,
    assertPromptAttached: async (_page: unknown, value: string) => { asserted = value; },
  }, page, prompt, false);

  expect(calls).toEqual([
    ["fill", ""],
    ["focus"],
    ["insertText", prompt],
  ]);
  expect(asserted).toBe(prompt);
});

test("connector selection re-resolves the active composer after ChatGPT replaces it", async () => {
  const calls: Array<[string, string?]> = [];
  let connectorSelected = false;
  const appResult = {
    waitFor: async () => { calls.push(["waitForResult"]); },
    count: async () => 1,
    dispatchEvent: async (event: string) => {
      expect(event).toBe("click");
      connectorSelected = true;
      calls.push(["dispatchResult", event]);
    },
  };
  const selectedConnector = {
    waitFor: async () => {
      expect(connectorSelected).toBeTrue();
      calls.push(["waitForSelectedConnector"]);
    },
    count: async () => 1,
  };
  const selectedComposer = {
    locator: (selector: string) => {
      expect(selector).toBe('[data-id^="plugin:"][data-keyword]');
      return {
        filter: (options: { hasText: string; visible: boolean }) => {
          expect(options).toEqual({ hasText: "Codex Native", visible: true });
          return selectedConnector;
        },
      };
    },
  };
  const initialComposer = {
    fill: async (value: string) => { calls.push(["fill", value]); },
    focus: async () => { calls.push(["focus"]); },
    pressSequentially: async (value: string, options: { delay: number }) => {
      expect(options).toEqual({ delay: 25 });
      calls.push(["pressSequentially", value]);
    },
  };
  const page = {
    getByText: (text: string, options: { exact: boolean }) => {
      expect(text).toBe("Codex Native");
      expect(options).toEqual({ exact: true });
      return { exactConnectorLabel: true };
    },
    locator: (selector: string) => {
      if (selector.includes("__menu-item")) {
        return {
          filter: (options: { has: unknown }) => {
            expect(options).toEqual({ has: { exactConnectorLabel: true } });
            return appResult;
          },
        };
      }
      throw new Error(`Unexpected locator: ${selector}`);
    },
  };
  const selectConnector = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown): Promise<unknown>;
  }).selectConnector;

  let activeComposerCalls = 0;
  const resolved = await selectConnector.call({
    config: { appName: "Codex Native" },
    connectorIsSelected: async () => connectorSelected,
    selectedConnectorControl: () => selectedConnector,
    activeComposer: async () => {
      activeComposerCalls += 1;
      return connectorSelected ? selectedComposer : initialComposer;
    },
  }, page);

  expect(resolved).toBe(selectedComposer);
  expect(activeComposerCalls).toBe(3);
  expect(calls).toEqual([
    ["fill", ""],
    ["fill", ""],
    ["focus"],
    ["pressSequentially", "@c"],
    ["waitForResult"],
    ["dispatchResult", "click"],
    ["waitForSelectedConnector"],
  ]);
});

test("connector selection retriggers the complete mention after a fresh-page hydration miss", async () => {
  const calls: string[] = [];
  let menuAttempt = 0;
  let selected = false;
  const timeout = new Error("menu not hydrated");
  timeout.name = "TimeoutError";
  const selectedConnector = {
    waitFor: async () => {
      expect(selected).toBeTrue();
      calls.push("selected");
    },
    count: async () => 1,
  };
  const appResult = {
    waitFor: async () => {
      menuAttempt += 1;
      calls.push(`menu:${menuAttempt}`);
      if (menuAttempt === 1) throw timeout;
    },
    count: async () => 1,
    dispatchEvent: async () => {
      selected = true;
      calls.push("activate");
    },
  };
  const selectedComposer = {
    locator: () => ({ filter: () => selectedConnector }),
  };
  const initialComposer = {
    fill: async () => { calls.push("clear"); },
    focus: async () => { calls.push("focus"); },
    pressSequentially: async (value: string) => {
      expect(value).toBe("@c");
      calls.push("type");
    },
  };
  const page = {
    getByText: () => ({ exactConnectorLabel: true }),
    locator: (selector: string) => selector.includes("__menu-item")
      ? { filter: () => appResult }
      : (() => { throw new Error(`Unexpected locator: ${selector}`); })(),
  };
  const selectConnector = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown): Promise<unknown>;
  }).selectConnector;

  let activeComposerCalls = 0;
  await selectConnector.call({
    config: { appName: "Codex Native" },
    connectorIsSelected: async () => selected,
    selectedConnectorControl: () => selectedConnector,
    activeComposer: async () => {
      activeComposerCalls += 1;
      return selected ? selectedComposer : initialComposer;
    },
  }, page);

  expect(calls).toEqual([
    "clear",
    "clear", "focus", "type", "menu:1",
    "clear", "focus", "type", "menu:2",
    "activate", "selected",
  ]);
});

test("tool-capable prompts use the shared Playwright connector selection before inserting context", async () => {
  const calls: Array<[string, string?]> = [];
  let selected = false;
  const selectedConnector = {
    waitFor: async () => {
      expect(selected).toBeTrue();
      calls.push(["selectedConnector"]);
    },
    count: async () => 1,
  };
  const appResult = {
    waitFor: async () => { calls.push(["connectorMenu"]); },
    count: async () => 1,
    dispatchEvent: async () => {
      selected = true;
      calls.push(["selectConnector"]);
    },
  };
  const selectedComposer = {
    focus: async () => { calls.push(["selectedFocus"]); },
    locator: () => ({ filter: () => selectedConnector }),
  };
  const initialComposer = {
    fill: async (value: string) => { calls.push(["fill", value]); },
    focus: async () => { calls.push(["focus"]); },
    pressSequentially: async (value: string) => { calls.push(["type", value]); },
  };
  const page = {
    getByText: () => ({ exactConnectorLabel: true }),
    locator: (selector: string) => selector.includes("__menu-item")
      ? { filter: () => appResult }
      : (() => { throw new Error(`Unexpected locator: ${selector}`); })(),
    keyboard: {
      insertText: async (value: string) => { calls.push(["insertText", value]); },
      press: async (value: string) => { calls.push(["press", value]); },
    },
  };
  const attachPrompt = (ChatGptBrowserWorker.prototype as unknown as {
    attachPrompt(page: unknown, prompt: string, localTools: boolean): Promise<void>;
  }).attachPrompt;
  const selectConnector = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown): Promise<unknown>;
  }).selectConnector;

  let activeComposerCalls = 0;
  await attachPrompt.call({
    config: { appName: "Codex Native" },
    selectConnector,
    connectorIsSelected: async () => selected,
    selectedConnectorControl: () => selectedConnector,
    activeComposer: async () => {
      activeComposerCalls += 1;
      return selected ? selectedComposer : initialComposer;
    },
    assertPromptAttached: async () => { calls.push(["assertPrompt"]); },
  }, page, "context", true);

  expect(calls).toEqual([
    ["fill", ""],
    ["fill", ""],
    ["focus"],
    ["type", "@c"],
    ["connectorMenu"],
    ["selectConnector"],
    ["selectedConnector"],
    ["selectedFocus"],
    ["press", "End"],
    ["insertText", " context"],
    ["assertPrompt"],
  ]);
});

test("image attachment readiness uses exact file tiles and not localized remove-button text", async () => {
  const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const calls: Array<[string, string?]> = [];
  const send = {
    isEnabled: async () => {
      calls.push(["sendEnabled"]);
      return true;
    },
  };
  const composerForm = {
    getByRole: (role: string, options: { name: string; exact: boolean }) => {
      expect(role).toBe("group");
      expect(options).toEqual({ name: "codex-input-image-1.png", exact: true });
      return {
        waitFor: async (state: { state: string; timeout: number }) => {
          expect(state).toEqual({ state: "visible", timeout: 60_000 });
          calls.push(["fileTile", options.name]);
        },
      };
    },
    getByTestId: (testId: string) => {
      expect(testId).toBe("send-button");
      return send;
    },
  };
  const composer = {
    locator: (selector: string) => {
      expect(selector).toBe("xpath=ancestor::form[1]");
      return composerForm;
    },
  };
  const input = {
    waitFor: async (state: { state: string; timeout: number }) => {
      expect(state).toEqual({ state: "attached", timeout: 20_000 });
      calls.push(["inputReady"]);
    },
    setInputFiles: async (files: Array<{ name: string }>) => {
      calls.push(["setFiles", files.map(file => file.name).join(",")]);
    },
  };
  const page = {
    locator: (selector: string) => {
      if (selector === 'input[data-testid="upload-photos-input"]') return input;
      if (selector === '[role="alert"]') {
        return { allInnerTexts: async () => [] };
      }
      return { last: () => composer };
    },
  };
  const attachFiles = (ChatGptBrowserWorker.prototype as unknown as {
    attachFiles(page: unknown, prompt: unknown): Promise<void>;
  }).attachFiles;

  await attachFiles.call({ activeComposer: async () => composer }, page, {
    images: [{ ref: "codex-input-image-1", imageUrl }],
  });

  expect(calls).toEqual([
    ["inputReady"],
    ["setFiles", "codex-input-image-1.png"],
    ["fileTile", "codex-input-image-1.png"],
    ["sendEnabled"],
  ]);
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource).not.toContain('aria-label^="Remove file "');
});

test("effort selection uses structural menu indices instead of localized labels", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const sessionSource = readFileSync(new URL("../src/chatgpt-session.ts", import.meta.url), "utf8");
  expect(workerSource).toContain("mode.uiEffortIndex");
  expect(workerSource).toContain("CHATGPT_EFFORT_MENU_SELECTOR");
  expect(workerSource).toContain("CHATGPT_EFFORT_ITEM_SELECTOR");
  expect(workerSource).toContain('timeout: 70_000');
  expect(sessionSource).toContain('[role="menu"]:has([role="menuitemradio"])');
  expect(sessionSource).toContain('[role="group"]:has([role="menuitemradio"])');
  expect(sessionSource).toContain('[role="menuitemradio"]');
  expect(sessionSource).not.toContain(":popover-open");
  expect(sessionSource).not.toContain("data-radix-collection-item");
  expect(workerSource).toContain('getAttribute("aria-checked")');
  expect(workerSource).toContain('getAttribute("aria-expanded")');
  expect(workerSource).not.toContain("currentLabel === targetLabel");
  expect(workerSource).not.toContain("chatGptEffortLabelsMatch");
  expect(workerSource).not.toMatch(/getByRole\("button", \{\s*name: "(?:Instant|Medium|High|Extra High|Pro)"/);
});

test("browser diagnostics redact context envelopes and capability values", () => {
  const diagnostic = redactChatGptUiDiagnostic(
    "<codex_context_json>private context</codex_context_json> turn_12345678901234567890 binding_12345678901234567890",
  );
  expect(diagnostic).not.toContain("private context");
  expect(diagnostic).not.toContain("12345678901234567890");
  expect(diagnostic).toContain("<codex_context_json>[redacted]</codex_context_json>");
});

test("visible DOM trace emits statuses and stable commentary but withholds the final answer", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  expect(tracker.observe([
    { kind: "status", text: "Reviewed architecture documentation" },
    { kind: "markdown", text: "The implementation has a concrete state drift." },
  ], false)).toEqual([{ kind: "reasoning", text: "Reviewed architecture documentation" }]);
  const commentaryBlocks = [
    { kind: "status", text: "Reviewed architecture documentation" },
    { kind: "markdown", text: "The implementation has a concrete state drift." },
    { kind: "status", text: "Inspecting runtime evidence" },
    { kind: "markdown", text: "Final answer still streaming" },
  ] as const;
  expect(tracker.observe([...commentaryBlocks], false, 1_000)).toEqual([
    { kind: "commentary", text: "The implementation has a concrete state drift." },
  ]);
  expect(tracker.observe([...commentaryBlocks], false, 1_100)).toEqual([
    { kind: "reasoning", text: "Inspecting runtime evidence" },
  ]);
  expect(tracker.observe([
    { kind: "markdown", text: "Final answer complete" },
  ], true)).toEqual([]);
});

test("visible DOM trace streams a growing commentary block as append-only deltas", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  const initial = [
    { kind: "markdown", text: "I’m reading" },
    { kind: "status", text: "Read context file contents" },
  ] as const;
  expect(tracker.observe([...initial], false, 1_000)).toEqual([
    { kind: "commentary", text: "I’m reading" },
  ]);
  const expanded = [
    { kind: "markdown", text: "I’m reading the repository’s mandatory architecture" },
    { kind: "status", text: "Read context file contents" },
  ] as const;
  expect(tracker.observe([...expanded], false, 1_050)).toEqual([
    { kind: "commentary", text: " the repository’s mandatory architecture", continuation: true },
  ]);
  expect(tracker.observe([...expanded], false, 1_100)).toEqual([]);
  expect(tracker.observe([...expanded], false, 1_150)).toEqual([
    { kind: "reasoning", text: "Read context file contents" },
  ]);
});

test("visible DOM trace translates the explicit ChatGPT compaction marker once", () => {
  const tracker = new ChatGptVisibleTraceTracker();
  expect(tracker.observe([
    { kind: "markdown", text: CHATGPT_INTERNAL_COMPACTION_MARKER },
  ], false)).toEqual([{ kind: "reasoning", text: "Context automatically compacted" }]);
  expect(tracker.observe([
    { kind: "status", text: CHATGPT_INTERNAL_COMPACTION_MARKER },
  ], false)).toEqual([]);
  expect(stripChatGptTransportMarkers(
    `Before\n\n${CHATGPT_INTERNAL_COMPACTION_MARKER}\n\nAfter`,
  )).toBe("Before\n\nAfter");
  const partial = "[[CODEX_INTERNAL_CONTEXT_COMPACT";
  expect(containsChatGptCompactionMarker(partial)).toBe(true);
  expect(stripChatGptTransportMarkers(partial)).toBe("");
  expect(new ChatGptVisibleTraceTracker().observe([
    { kind: "markdown", text: partial },
  ], false)).toEqual([{ kind: "reasoning", text: "Context automatically compacted" }]);
});

test("trace parsing excludes the Answer now UI control", () => {
  expect(isChatGptTraceControl({ kind: "status", text: "Answer now" })).toBe(true);
  expect(isChatGptTraceControl({ kind: "status", text: "Reviewing repository invariants" })).toBe(false);
  expect(isChatGptTraceControl({ kind: "markdown", text: "Answer now" })).toBe(false);
});

test("browser DOM health fails closed on a vanished or empty ChatGPT response", () => {
  const missing = new ChatGptTurnDomHealthTracker(1_000, 500);
  const absent = {
    responsePresent: false,
    running: true,
    currentText: "",
    completionActionVisible: false,
  };
  expect(missing.update(absent, 1_000)).toBeUndefined();
  expect(missing.update(absent, 2_000)).toContain("did not create a response DOM");

  const empty = new ChatGptTurnDomHealthTracker(1_000, 500);
  const terminal = {
    ...absent,
    responsePresent: true,
    running: false,
    completionActionVisible: true,
  };
  expect(empty.update(terminal, 1_000)).toBeUndefined();
  expect(empty.update(terminal, 1_500)).toContain("completed without a final answer");
});

test("browser completion requires ChatGPT's response-scoped copy action", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const sessionSource = readFileSync(new URL("../src/chatgpt-session.ts", import.meta.url), "utf8");
  expect(sessionSource).toContain('button[data-testid="copy-turn-action-button"]');
  expect(workerSource).toContain("CHATGPT_COMPLETION_ACTION_SELECTOR");
  expect(workerSource).not.toContain('root.querySelectorAll<HTMLElement>("button")');
});

test("browser send accepts only conclusive ChatGPT submission evidence", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const idle = {
    initialUserTurnCount: 1,
    userTurnCount: 1,
    initialAssistantTurnCount: 2,
    assistantTurnCount: 2,
    generationRunning: false,
  };
  expect(chatGptSubmissionEvidence(idle)).toBeUndefined();
  expect(chatGptSubmissionEvidence({ ...idle, userTurnCount: 2 })).toBe("user_turn");
  expect(chatGptSubmissionEvidence({ ...idle, assistantTurnCount: 3 })).toBe("assistant_turn");
  expect(chatGptSubmissionEvidence({ ...idle, generationRunning: true })).toBe("generation_running");
  expect(workerSource).toContain("waitForSubmissionAccepted");
  expect(workerSource).not.toContain("userTurns.nth(initialUserTurnCount).waitFor");
});

test("visible reasoning keeps the browser turn healthy before final assistant markdown exists", () => {
  const health = new ChatGptTurnDomHealthTracker(1_000, 500);
  const reasoning = {
    responsePresent: true,
    running: false,
    currentText: "",
    completionActionVisible: false,
  };
  expect(health.update(reasoning, 1_000)).toBeUndefined();
  expect(health.update(reasoning, 10_000)).toBeUndefined();
});
