import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import {
  CHATGPT_CONTEXT_FILE_NAME,
  CHATGPT_INTERNAL_COMPACTION_MARKER,
  compileChatGptWebPrompt,
} from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { CodexParsedRequest } from "../src/types";

function request(reasoning: "high" | "max"): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      systemPrompt: ["preserve-system"],
      messages: [
        { role: "developer", content: "preserve-developer", timestamp: 1 },
        { role: "user", content: "perform the task", timestamp: 2 },
      ],
    },
    stream: true,
    options: { reasoning },
  };
}

test("tool-capable prompts resume the mandatory bind contract after the complete context envelope", () => {
  const token = "turn_12345678901234567890123456789012";
  const compiled = compileChatGptWebPrompt(
    request("high"),
    { localToolsEnabled: true, proAvailable: true },
    token,
  );
  const envelopeEnd = compiled.text.indexOf("</codex_context_json>");
  const resume = compiled.text.indexOf("<codex_transport_resume>", envelopeEnd);
  const finalToken = compiled.text.lastIndexOf(token);

  expect(envelopeEnd).toBeGreaterThan(0);
  expect(resume).toBeGreaterThan(envelopeEnd);
  expect(finalToken).toBeGreaterThan(resume);
  expect(compiled.text.slice(resume)).toContain("first action now must be the actual Codex Native codex_bind_turn call");
  expect(compiled.text).toContain(CHATGPT_INTERNAL_COMPACTION_MARKER);
  expect(compiled.text).toContain("call codex_bind_turn again with the same turn_token");
});

test("read-only prompts resume without exposing a bind capability", () => {
  const compiled = compileChatGptWebPrompt(
    request("max"),
    { localToolsEnabled: true, proAvailable: true },
  );

  expect(compiled.text).toContain("The context envelope is complete. Execute the latest active user request now under the read-only transport contract above.");
  expect(compiled.text).not.toContain("codex_bind_turn");
  expect(compiled.text).not.toContain("turn_token");
  expect(compiled.text).toContain(CHATGPT_INTERNAL_COMPACTION_MARKER);
});

test("large contexts move intact into an ordered JSONL attachment", () => {
  const token = "turn_12345678901234567890123456789012";
  const largeContent = "x".repeat(600_000);
  const large = request("high");
  large.context.messages.push({
    role: "toolResult",
    toolCallId: "call_large",
    toolName: "exec_command",
    content: largeContent,
    isError: false,
    timestamp: 3,
  });
  const compiled = compileChatGptWebPrompt(
    large,
    { localToolsEnabled: true, proAvailable: true },
    token,
  );

  expect(compiled.contextFile?.name).toBe(CHATGPT_CONTEXT_FILE_NAME);
  expect(compiled.contextFile?.mimeType).toBe("application/jsonl");
  expect(compiled.text.length).toBeLessThan(10_000);
  expect(compiled.text).not.toContain("x".repeat(1_000));
  expect(compiled.text).toContain(token);
  expect(compiled.text).toContain(`<codex_context_attachment>`);
  expect(compiled.text).toContain(compiled.contextFile!.sha256);

  const records = compiled.contextFile!.content.trimEnd().split("\n").map(line => JSON.parse(line));
  expect(records).toHaveLength(compiled.contextFile!.recordCount);
  expect(records[0]).toMatchObject({
    type: "codex_context_manifest",
    version: 4,
    system_records: 1,
    message_records: 3,
  });
  expect(records[1]).toEqual({ type: "system", index: 0, content: "preserve-system" });
  expect(records.at(-1)).toMatchObject({
    type: "message",
    index: 2,
    message: { role: "tool_result", tool_call_id: "call_large" },
  });
  expect(records.at(-1).message.content).toBe(largeContent);
  expect(createHash("sha256").update(compiled.contextFile!.content).digest("hex"))
    .toBe(compiled.contextFile!.sha256);
});
