import { describe, expect, test } from "bun:test";
import {
  availableChatGptWebModelRoutes,
  CHATGPT_WEB_BACKEND_MODEL,
  CHATGPT_WEB_MODEL_ROUTES,
  requireChatGptWebModelRoute,
  resolveChatGptWebContextLimits,
} from "../src/chatgpt-web-models";
import { defaultConfig } from "../src/config";
import { routeChatGptWebRequest } from "../src/server";
import type { CodexParsedRequest } from "../src/types";

function parsed(modelId: string, reasoning = "medium"): CodexParsedRequest {
  return {
    modelId,
    context: { messages: [] },
    stream: false,
    options: { reasoning },
    _rawBody: { model: modelId, reasoning: { effort: reasoning } },
  };
}

describe("fixed ChatGPT Web model routes", () => {
  test("uses unique stable slugs and one explicit adapter effort per model", () => {
    expect(new Set(CHATGPT_WEB_MODEL_ROUTES.map(route => route.slug)).size).toBe(CHATGPT_WEB_MODEL_ROUTES.length);
    expect(CHATGPT_WEB_MODEL_ROUTES.map(route => [route.slug, route.codexEffort, route.adapterEffort])).toEqual([
      ["chatgpt-web/light", "low", "low"],
      ["chatgpt-web/medium", "medium", "medium"],
      ["chatgpt-web/high", "high", "high"],
      ["chatgpt-web/extra-high", "xhigh", "xhigh"],
      ["chatgpt-web/pro", "ultra", "max"],
    ]);
    expect(CHATGPT_WEB_MODEL_ROUTES[0]?.displayName).toBe("ChatGPT Web — Instant");
  });

  test("exposes only Plus-eligible routes without the Pro account capability", () => {
    expect(availableChatGptWebModelRoutes(false).map(route => route.slug)).toEqual([
      "chatgpt-web/light",
      "chatgpt-web/medium",
      "chatgpt-web/high",
    ]);
    expect(availableChatGptWebModelRoutes(true)).toEqual(CHATGPT_WEB_MODEL_ROUTES);
    expect(() => requireChatGptWebModelRoute("chatgpt-web/extra-high", false))
      .toThrow("Extra High is not available for this account");
    expect(() => requireChatGptWebModelRoute("chatgpt-web/pro", false))
      .toThrow("Pro is not available for this account");
  });

  test("uses the reduced Plus window only for Instant and Medium", () => {
    for (const effort of ["low", "medium"] as const) {
      expect(resolveChatGptWebContextLimits(effort)).toEqual({
        contextWindow: 150_000,
        autoCompactTokenLimit: 135_000,
      });
    }
    expect(resolveChatGptWebContextLimits("high")).toEqual({
      contextWindow: 185_000,
      autoCompactTokenLimit: 166_500,
    });
    expect(resolveChatGptWebContextLimits("xhigh")).toEqual({
      contextWindow: 256_000,
      autoCompactTokenLimit: 230_400,
    });
    expect(resolveChatGptWebContextLimits("max")).toEqual({
      contextWindow: 272_000,
      autoCompactTokenLimit: 244_800,
    });
  });

  test("binds the selected model authoritatively and ignores a conflicting request effort", () => {
    const request = parsed("chatgpt-web/high", "low");
    const rawSnapshot = structuredClone(request._rawBody);
    const route = routeChatGptWebRequest(request, defaultConfig("browser-only"));

    expect(route.slug).toBe("chatgpt-web/high");
    expect(request.modelId).toBe(CHATGPT_WEB_BACKEND_MODEL);
    expect(request.options.reasoning).toBe("high");
    expect(request._rawBody).toEqual(rawSnapshot);
  });

  test("binds the Pro model to the browser Pro effort and fails closed for unknown routes", () => {
    const config = defaultConfig("full");
    config.proAvailable = true;
    const request = parsed("chatgpt-web/pro", "low");
    expect(routeChatGptWebRequest(request, config).adapterEffort).toBe("max");
    expect(request.options.reasoning).toBe("max");
    expect(() => routeChatGptWebRequest(parsed("chatgpt-web/not-enabled"), config))
      .toThrow("model is not enabled");
  });
});
