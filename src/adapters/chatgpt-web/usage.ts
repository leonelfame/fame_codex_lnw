import { estimateTokens } from "../../lib/token-estimate";
import { resolveChatGptWebContextLimits } from "../../chatgpt-web-models";
import type { CodexParsedRequest, CodexUsage } from "../../types";
import type { CompiledChatGptWebPrompt } from "./prompt";
import { compileChatGptWebPrompt } from "./prompt";
import { resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import type { BrokerToolRequest } from "./turn-broker";

// The real capability has the same length. Keeping it out of usage accounting would make
// estimates differ slightly between the prepared browser prompt and later Codex tool rounds.
const ESTIMATE_TURN_TOKEN = "turn_00000000000000000000000000000000";

// ChatGPT's product system prompt and the fixed Codex Native MCP schemas are not present in the
// visible composer text. Reserve them explicitly; over-counting fails safe by compacting earlier.
const CHATGPT_PLATFORM_RESERVE_TOKENS = 8_192;
const CHATGPT_IMAGE_RESERVE_TOKENS = 4_096;
const CHATGPT_ORIGINAL_IMAGE_RESERVE_TOKENS = 8_192;

// Live ChatGPT composer probes on 2026-08-04 accepted 547k inline characters and disabled Send at
// 548k. Compact before that product boundary and keep a separate fail-closed submission ceiling.
export const CHATGPT_WEB_INLINE_PROMPT_AUTO_COMPACT_CHARS = 480_000;
export const CHATGPT_WEB_INLINE_PROMPT_LIMIT_CHARS = 540_000;

export interface ChatGptWebRoundEvidence {
  answer?: string;
  reasoning?: string[];
  toolRequests?: BrokerToolRequest[];
}

function conservativeTextTokens(text: string, modelId: string): number {
  return estimateTokens(text, modelId);
}

export function estimateCompiledChatGptWebInputTokens(
  compiled: CompiledChatGptWebPrompt,
  modelId: string,
): number {
  const imageTokens = compiled.images.reduce(
    (total, image) => total + (image.detail === "original"
      ? CHATGPT_ORIGINAL_IMAGE_RESERVE_TOKENS
      : CHATGPT_IMAGE_RESERVE_TOKENS),
    0,
  );
  return CHATGPT_PLATFORM_RESERVE_TOKENS
    + conservativeTextTokens(compiled.text, modelId)
    + imageTokens;
}

export function estimateChatGptWebInputTokens(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
): number {
  const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  const compiled = compileChatGptWebPrompt(
    parsed,
    capabilities,
    mode.localTools ? ESTIMATE_TURN_TOKEN : undefined,
  );
  const modelTokens = estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId);
  const { autoCompactTokenLimit } = resolveChatGptWebContextLimits(mode.effort);
  const transportPressureTokens = Math.ceil(
    compiled.text.length * autoCompactTokenLimit / CHATGPT_WEB_INLINE_PROMPT_AUTO_COMPACT_CHARS,
  );
  return Math.max(modelTokens, transportPressureTokens);
}

function roundEvidenceText(evidence: ChatGptWebRoundEvidence): string {
  return JSON.stringify({
    reasoning: evidence.reasoning ?? [],
    ...(evidence.answer !== undefined ? { answer: evidence.answer } : {}),
    ...(evidence.toolRequests ? {
      tool_calls: evidence.toolRequests.map(request => ({
        call_id: request.callId,
        name: request.wireName,
        ...(request.freeform
          ? { input: request.input ?? "" }
          : { arguments: request.arguments ?? {} }),
      })),
    } : {}),
  });
}

export function estimateChatGptWebUsage(
  parsed: CodexParsedRequest,
  evidence: ChatGptWebRoundEvidence,
  capabilities: ChatGptWebCapabilities,
): CodexUsage {
  const inputTokens = estimateChatGptWebInputTokens(parsed, capabilities);
  const outputTokens = conservativeTextTokens(roundEvidenceText(evidence), parsed.modelId);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimated: true,
  };
}
