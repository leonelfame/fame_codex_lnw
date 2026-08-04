import { expect, test } from "bun:test";
import { estimateChatGptWebInputTokens } from "../src/adapters/chatgpt-web/usage";
import { resolveChatGptWebContextLimits } from "../src/chatgpt-web-models";
import type { CodexParsedRequest } from "../src/types";

const capabilities = { localToolsEnabled: false, proAvailable: true };

function request(text: string): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: false,
    context: { messages: [{ role: "user", content: text, timestamp: 1 }] },
    options: { reasoning: "high" },
  };
}

test("inline transport pressure reaches Codex auto-compaction before the composer ceiling", () => {
  const { autoCompactTokenLimit } = resolveChatGptWebContextLimits(true);
  const estimated = estimateChatGptWebInputTokens(request("a".repeat(480_000)), capabilities);

  expect(estimated).toBeGreaterThanOrEqual(autoCompactTokenLimit);
});

test("ordinary context below the transport threshold keeps its tokenizer-derived usage", () => {
  const estimated = estimateChatGptWebInputTokens(
    request(`${"word ".repeat(79_999)}word`),
    capabilities,
  );

  expect(estimated).toBeLessThan(resolveChatGptWebContextLimits(true).autoCompactTokenLimit);
});
