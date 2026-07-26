import { expect, test } from "bun:test";
import { ChatGptVisibleTraceTracker, chatGptEffortLabelsMatch, redactChatGptUiDiagnostic } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_INTERNAL_COMPACTION_MARKER, stripChatGptTransportMarkers } from "../src/adapters/chatgpt-web/prompt";

test("effort selection is idempotent across rendered whitespace", () => {
  expect(chatGptEffortLabelsMatch("High", "High")).toBe(true);
  expect(chatGptEffortLabelsMatch("Instant\n5.5", "Instant 5.5")).toBe(true);
  expect(chatGptEffortLabelsMatch("High", "Extra High")).toBe(false);
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
  const tracker = new ChatGptVisibleTraceTracker();
  expect(tracker.observe([
    { kind: "status", text: "Reviewed architecture documentation" },
    { kind: "markdown", text: "The implementation has a concrete state drift." },
  ], false)).toEqual([{ kind: "reasoning", text: "Reviewed architecture documentation" }]);
  expect(tracker.observe([
    { kind: "status", text: "Reviewed architecture documentation" },
    { kind: "markdown", text: "The implementation has a concrete state drift." },
    { kind: "status", text: "Inspecting runtime evidence" },
    { kind: "markdown", text: "Final answer still streaming" },
  ], false)).toEqual([
    { kind: "commentary", text: "The implementation has a concrete state drift." },
    { kind: "reasoning", text: "Inspecting runtime evidence" },
  ]);
  expect(tracker.observe([
    { kind: "markdown", text: "Final answer complete" },
  ], true)).toEqual([]);
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
});
