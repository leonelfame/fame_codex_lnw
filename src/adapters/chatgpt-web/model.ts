export const CHATGPT_WEB_STANDARD_MODEL_ID = "gpt-5.6-sol";
export const CHATGPT_WEB_PRO_MODEL_ID = "gpt-5.6-sol-pro";

export interface ChatGptWebModelMode {
  modelId: string;
  uiModelLabel: "GPT-5.6 Sol";
  uiEffortLabel: "Medium" | "High" | "Extra High" | "Pro";
  localTools: boolean;
}

/** Resolve the Codex-facing model id to one exact ChatGPT UI mode. Unknown combinations fail closed. */
export function resolveChatGptWebModelMode(modelId: string, reasoning?: string): ChatGptWebModelMode {
  if (modelId === CHATGPT_WEB_PRO_MODEL_ID) {
    return {
      modelId,
      uiModelLabel: "GPT-5.6 Sol",
      uiEffortLabel: "Pro",
      localTools: false,
    };
  }
  if (modelId !== CHATGPT_WEB_STANDARD_MODEL_ID) {
    throw new Error(`ChatGPT web model is not supported: ${modelId}`);
  }
  switch (reasoning ?? "high") {
    case "medium":
      return { modelId, uiModelLabel: "GPT-5.6 Sol", uiEffortLabel: "Medium", localTools: true };
    case "high":
      return { modelId, uiModelLabel: "GPT-5.6 Sol", uiEffortLabel: "High", localTools: true };
    case "xhigh":
      return { modelId, uiModelLabel: "GPT-5.6 Sol", uiEffortLabel: "Extra High", localTools: true };
    default:
      throw new Error(`ChatGPT web reasoning effort is not supported for ${modelId}: ${reasoning ?? "undefined"}`);
  }
}
