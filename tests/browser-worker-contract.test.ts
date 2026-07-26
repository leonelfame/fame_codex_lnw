import { expect, test } from "bun:test";
import { chatGptEffortLabelsMatch, redactChatGptUiDiagnostic } from "../src/adapters/chatgpt-web/browser-worker";

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
