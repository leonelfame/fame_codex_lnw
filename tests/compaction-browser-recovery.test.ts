import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";

test.each([true, false])("multipart compaction recovery follows launcher ownership, not tool access (owned=%s)", async owned => {
  const diagnostics = mkdtempSync(join(tmpdir(), "compaction-observation-"));
  const finalResponse = new Error("fixture reached final response observation");
  const capabilities = { localToolsEnabled: false, solAvailable: true, proAvailable: true };
  const recoveryCallbacks: unknown[] = [];
  let stage = "";
  let released = false;
  const page = { evaluate: async () => ({}), isClosed: () => false };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { appName: "Codex Native2", browserDiagnosticsPath: diagnostics, ...(owned ? { browserHostDescriptorPath: "owned-descriptor" } : {}) },
    runStage: async (_trace: string, name: string, _timeout: number, action: (signal: AbortSignal) => Promise<unknown>) => {
      stage = name;
      return action(new AbortController().signal);
    },
    prepareTemporaryChatSurface: async () => {},
    selectModelAndEffort: async (_page: unknown, model: string, effort: string) => resolveChatGptWebModelMode(model, effort, capabilities),
    captureSubmissionBaseline: async () => ({}),
    attachPrompt: async () => {},
    attachPromptWithCompactionRetry: async () => {},
    attachFiles: async () => {},
    sendAttachedPrompt: async (...args: unknown[]) => {
      expect(args[4]).toBeUndefined(); // Compaction must not acquire MCP progress or tools.
      recoveryCallbacks.push(args[7]);
      return "user_turn";
    },
    waitForNewAssistantTurn: async (...args: unknown[]) => {
      expect(args[4]).toBeUndefined();
      recoveryCallbacks.push(args[7]);
      if (stage === "send") throw finalResponse;
      return {};
    },
    waitForMultipartAcknowledgement: async () => {},
  });
  try {
    await expect(worker.runBrowserTurn({
      traceId: "compaction_recovery_fixture",
      modelId: "gpt-5.6-sol",
      reasoning: "high",
      capabilities,
      compaction: true,
      prepare: async () => ({ text: "Summarize the context", images: [], multipart: { parts: ['{"part":1}', '{"part":2}', '{"part":3}'], commit: "Summarize" }, release: () => { released = true; } }),
    }, owned ? "owned-surface" : undefined, page)).rejects.toBe(finalResponse);
    expect(recoveryCallbacks).toHaveLength(6);
    expect(recoveryCallbacks.map(callback => typeof callback)).toEqual(Array(6).fill(owned ? "function" : "undefined"));
    expect(released).toBe(true);
  } finally {
    rmSync(diagnostics, { recursive: true, force: true });
  }
});
