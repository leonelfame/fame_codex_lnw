export const CHATGPT_WEB_MODEL_PREFIX = "chatgpt-web/";
export const CHATGPT_WEB_BACKEND_MODEL = "gpt-5.6-sol";

export type ChatGptWebCodexEffort = "low" | "medium" | "high" | "xhigh" | "ultra";
export type ChatGptWebAdapterEffort = "low" | "medium" | "high" | "xhigh" | "max";

export const CHATGPT_WEB_INSTANT_MEDIUM_CONTEXT_WINDOW = 150_000;
export const CHATGPT_WEB_HIGH_CONTEXT_WINDOW = 185_000;
export const CHATGPT_WEB_EXTRA_HIGH_CONTEXT_WINDOW = 256_000;
export const CHATGPT_WEB_PRO_CONTEXT_WINDOW = 272_000;

export interface ChatGptWebContextLimits {
  contextWindow: number;
  autoCompactTokenLimit: number;
}

/** Resolve the product limit for the selected visible ChatGPT mode. */
export function resolveChatGptWebContextLimits(
  effort: ChatGptWebAdapterEffort,
): ChatGptWebContextLimits {
  const contextWindow = effort === "max"
    ? CHATGPT_WEB_PRO_CONTEXT_WINDOW
    : effort === "xhigh"
      ? CHATGPT_WEB_EXTRA_HIGH_CONTEXT_WINDOW
      : effort === "high"
        ? CHATGPT_WEB_HIGH_CONTEXT_WINDOW
        : CHATGPT_WEB_INSTANT_MEDIUM_CONTEXT_WINDOW;
  return {
    contextWindow,
    // Leave ten percent for Codex to submit and receive the compact checkpoint before the hard cap.
    autoCompactTokenLimit: Math.floor(contextWindow * 0.9),
  };
}

export interface ChatGptWebModelRoute {
  slug: string;
  displayName: string;
  description: string;
  codexEffort: ChatGptWebCodexEffort;
  adapterEffort: ChatGptWebAdapterEffort;
  requiresPro: boolean;
}

/**
 * The selected Codex model is the authoritative ChatGPT browser mode. Codex's signed desktop UI
 * always renders an Effort row, so every routed model advertises exactly one immutable protocol
 * effort. Pro uses Codex's `ultra` protocol value but binds explicitly to ChatGPT Pro (`max`) at
 * the adapter boundary.
 */
export const CHATGPT_WEB_MODEL_ROUTES: readonly ChatGptWebModelRoute[] = [
  {
    slug: "chatgpt-web/light",
    displayName: "ChatGPT Web — Instant",
    description: "ChatGPT Web Instant through the native Codex harness.",
    codexEffort: "low",
    adapterEffort: "low",
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/medium",
    displayName: "ChatGPT Web — Medium",
    description: "ChatGPT Web Medium through the native Codex harness.",
    codexEffort: "medium",
    adapterEffort: "medium",
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/high",
    displayName: "ChatGPT Web — High",
    description: "ChatGPT Web High through the native Codex harness.",
    codexEffort: "high",
    adapterEffort: "high",
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/extra-high",
    displayName: "ChatGPT Web — Extra High",
    description: "Account-gated ChatGPT Web Extra High through the native Codex harness.",
    codexEffort: "xhigh",
    adapterEffort: "xhigh",
    requiresPro: true,
  },
  {
    slug: "chatgpt-web/pro",
    displayName: "ChatGPT Web — Pro",
    description: "Account-gated ChatGPT Pro through the native Codex harness. Local tool calls are unavailable in this mode.",
    codexEffort: "ultra",
    adapterEffort: "max",
    requiresPro: true,
  },
];

const routesBySlug = new Map(CHATGPT_WEB_MODEL_ROUTES.map(route => [route.slug, route]));

export function isChatGptWebModelSlug(modelId: string): boolean {
  return modelId.startsWith(CHATGPT_WEB_MODEL_PREFIX);
}

export function availableChatGptWebModelRoutes(proAvailable: boolean): readonly ChatGptWebModelRoute[] {
  return proAvailable
    ? CHATGPT_WEB_MODEL_ROUTES
    : CHATGPT_WEB_MODEL_ROUTES.filter(route => !route.requiresPro);
}

export function requireChatGptWebModelRoute(modelId: string, proAvailable: boolean): ChatGptWebModelRoute {
  const route = routesBySlug.get(modelId);
  if (!route) throw new Error(`ChatGPT web model is not enabled: ${modelId}`);
  if (route.requiresPro && !proAvailable) {
    throw new Error(`${route.displayName} is not available for this account`);
  }
  return route;
}
