import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ChatGptBrowserWorker, ChatGptTurnDomHealthTracker, ChatGptVisibleTraceTracker, isChatGptTraceControl, redactChatGptUiDiagnostic } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_INTERNAL_COMPACTION_MARKER, containsChatGptCompactionMarker, stripChatGptTransportMarkers } from "../src/adapters/chatgpt-web/prompt";

test("Codex context uses the owned CDP composer transport, never the operating-system clipboard", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource).toContain('composer.fill("")');
  expect(workerSource).toContain("page.keyboard.insertText(prompt)");
  expect(workerSource).toContain("page.keyboard.insertText(` ${prompt}`)");
  expect(workerSource).not.toMatch(/\bclipboard\b|pbcopy|pbpaste/i);
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
    locator: () => ({ last: () => composer }),
    keyboard: {
      insertText: async (value: string) => { calls.push(["insertText", value]); },
    },
  };
  const attachPrompt = (ChatGptBrowserWorker.prototype as unknown as {
    attachPrompt(page: unknown, prompt: string, localTools: boolean): Promise<void>;
  }).attachPrompt;

  await attachPrompt.call({
    assertPromptAttached: async (_page: unknown, value: string) => { asserted = value; },
  }, page, prompt, false);

  expect(calls).toEqual([
    ["fill", ""],
    ["focus"],
    ["insertText", prompt],
  ]);
  expect(asserted).toBe(prompt);
});

test("tool-capable prompts type the mention trigger and accept the exact connector before inserting context", async () => {
  const calls: Array<[string, string?]> = [];
  const appResult = {
    waitFor: async () => { calls.push(["waitForResult"]); },
    count: async () => 1,
    click: async () => { calls.push(["clickResult"]); },
  };
  const selectedPlugin = {
    waitFor: async () => { calls.push(["waitForPill"]); },
  };
  const composer = {
    fill: async (value: string) => { calls.push(["fill", value]); },
    focus: async () => { calls.push(["focus"]); },
    pressSequentially: async (value: string, options: { delay: number }) => {
      expect(options).toEqual({ delay: 25 });
      calls.push(["pressSequentially", value]);
    },
    press: async (value: string) => { calls.push(["composerPress", value]); },
    getByRole: (role: string, options: { name: string; exact: boolean }) => {
      expect(role).toBe("link");
      expect(options).toEqual({ name: "Codex Native", exact: true });
      return selectedPlugin;
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
      return { last: () => composer };
    },
    keyboard: {
      insertText: async (value: string) => { calls.push(["insertText", value]); },
      press: async (value: string) => { calls.push(["press", value]); },
    },
  };
  const attachPrompt = (ChatGptBrowserWorker.prototype as unknown as {
    attachPrompt(page: unknown, prompt: string, localTools: boolean): Promise<void>;
  }).attachPrompt;

  await attachPrompt.call({
    config: { appName: "Codex Native" },
    assertPromptAttached: async () => { calls.push(["assertPrompt"]); },
  }, page, "context", true);

  expect(calls).toEqual([
    ["fill", ""],
    ["focus"],
    ["pressSequentially", "@c"],
    ["waitForResult"],
    ["clickResult"],
    ["waitForPill"],
    ["focus"],
    ["press", "End"],
    ["insertText", " context"],
    ["assertPrompt"],
  ]);
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

test("browser send is accepted only after ChatGPT creates a new user turn", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const sessionSource = readFileSync(new URL("../src/chatgpt-session.ts", import.meta.url), "utf8");
  expect(sessionSource).toContain("CHATGPT_USER_TURN_SELECTOR");
  expect(workerSource).toContain("initialUserTurnCount");
  expect(workerSource).toContain("userTurns.nth(initialUserTurnCount).waitFor");
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
