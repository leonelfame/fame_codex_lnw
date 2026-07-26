import type { AppConfig } from "./config";

export const CHATGPT_WEB_ROUTED_MODEL = "chatgpt-web/gpt-5.6-sol";
const NATIVE_TEMPLATE_MODEL = "gpt-5.6-sol";

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

function slug(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as JsonObject).slug;
  return typeof candidate === "string" ? candidate : undefined;
}

function reasoningLevel(template: JsonObject, effort: string, description: string): JsonObject {
  const levels = Array.isArray(template.supported_reasoning_levels)
    ? template.supported_reasoning_levels.filter(level => level && typeof level === "object" && !Array.isArray(level)) as JsonObject[]
    : [];
  const source = levels.find(level => level.effort === effort);
  return { ...(source ? structuredClone(source) : {}), effort, description };
}

export function buildChatGptWebModel(templateValue: unknown, config: AppConfig): JsonObject {
  const template = object(templateValue, `native ${NATIVE_TEMPLATE_MODEL} model`);
  if (slug(template) !== NATIVE_TEMPLATE_MODEL) {
    throw new Error(`ChatGPT Web model template must be ${NATIVE_TEMPLATE_MODEL}`);
  }
  const model: JsonObject = {
    ...structuredClone(template),
    slug: CHATGPT_WEB_ROUTED_MODEL,
    display_name: "ChatGPT Web",
    description: "ChatGPT web through the native Codex harness. Effort selects Light, Medium, High, Extra High, or account-gated Pro.",
    context_window: config.contextWindow,
    max_context_window: config.contextWindow,
    auto_compact_token_limit: Math.floor(config.contextWindow * 0.9),
    input_modalities: ["text", "image"],
    visibility: "list",
    supported_in_api: false,
    tool_mode: config.mode === "full" ? template.tool_mode : null,
    upgrade: null,
    default_reasoning_level: "high",
    supported_reasoning_levels: [
      reasoningLevel(template, "low", "Light — ChatGPT Instant 5.5"),
      reasoningLevel(template, "medium", "Medium"),
      reasoningLevel(template, "high", "High"),
      reasoningLevel(template, "xhigh", "Extra High"),
      ...(config.proAvailable ? [reasoningLevel(template, "ultra", "Pro")] : []),
    ],
  };
  delete model.availability_nux;
  return model;
}

export function augmentNativeModelCatalog(value: unknown, config: AppConfig): JsonObject {
  const catalog = object(value, "native Codex models response");
  if (!Array.isArray(catalog.models)) {
    throw new Error("Native Codex models response is missing a models array");
  }
  const template = catalog.models.find(model => slug(model) === NATIVE_TEMPLATE_MODEL);
  if (!template) {
    throw new Error(`Native Codex models response is missing ${NATIVE_TEMPLATE_MODEL}`);
  }
  const nativeModels = catalog.models.filter(model => slug(model) !== CHATGPT_WEB_ROUTED_MODEL);
  return {
    ...structuredClone(catalog),
    models: [...structuredClone(nativeModels), buildChatGptWebModel(template, config)],
  };
}
