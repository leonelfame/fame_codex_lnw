export const CHATGPT_WEB_MODEL_ID = "gpt-5.6-sol";

export interface ChatGptWebCapabilities {
  localToolsEnabled: boolean;
  proAvailable: boolean;
}

export interface ChatGptWebModelMode {
  modelId: string;
  effort: "light" | "medium" | "high" | "xhigh" | "pro";
  uiEffortLabel: "Instant 5.5" | "Medium" | "High" | "Extra High" | "Pro";
  localTools: boolean;
}

export function resolveChatGptWebModelMode(
  modelId: string,
  reasoning: string | undefined,
  capabilities: ChatGptWebCapabilities,
): ChatGptWebModelMode {
  if (modelId !== CHATGPT_WEB_MODEL_ID) {
    throw new Error(`ChatGPT web model is not supported: ${modelId}`);
  }
  const effort = reasoning ?? "high";
  switch (effort) {
    case "light":
      return { modelId, effort, uiEffortLabel: "Instant 5.5", localTools: capabilities.localToolsEnabled };
    case "medium":
      return { modelId, effort, uiEffortLabel: "Medium", localTools: capabilities.localToolsEnabled };
    case "high":
      return { modelId, effort, uiEffortLabel: "High", localTools: capabilities.localToolsEnabled };
    case "xhigh":
      return { modelId, effort, uiEffortLabel: "Extra High", localTools: capabilities.localToolsEnabled };
    case "pro":
      if (!capabilities.proAvailable) throw new Error("ChatGPT Pro effort is not available for this account");
      return { modelId, effort, uiEffortLabel: "Pro", localTools: false };
    default:
      throw new Error(`ChatGPT web effort is not supported: ${effort}`);
  }
}
