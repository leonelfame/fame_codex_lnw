import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { augmentNativeModelCatalog, CHATGPT_WEB_ROUTED_MODEL } from "../src/model-catalog";

function source(): Record<string, unknown> {
  return {
    models: [
      { slug: "gpt-5.5", display_name: "5.5", priority: 1 },
      {
        slug: "gpt-5.6-sol",
        display_name: "5.6 Sol",
        description: "native",
        priority: 2,
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        base_instructions: "native harness",
        supported_reasoning_levels: [
          { effort: "low", description: "Low" },
          { effort: "medium", description: "Medium native" },
          { effort: "high", description: "High native" },
          { effort: "xhigh", description: "Extra high native" },
        ],
        tool_mode: "code_mode_only",
      },
      { slug: "gpt-5.6-terra", display_name: "5.6 Terra", priority: 3 },
    ],
  };
}

describe("native /models augmentation", () => {
  test("preserves every native model in order and appends exactly one ChatGPT Web model", () => {
    const native = source();
    const nativeSnapshot = structuredClone(native);
    const config = defaultConfig("full");
    config.proAvailable = true;
    const result = augmentNativeModelCatalog(native, config);
    const models = result.models as Array<Record<string, unknown>>;

    expect(native).toEqual(nativeSnapshot);
    expect(models.slice(0, 3)).toEqual(nativeSnapshot.models as Array<Record<string, unknown>>);
    expect(models.filter(model => model.slug === CHATGPT_WEB_ROUTED_MODEL)).toHaveLength(1);
    expect(models[3]).toMatchObject({
      slug: CHATGPT_WEB_ROUTED_MODEL,
      display_name: "ChatGPT Web",
      context_window: 256_000,
      max_context_window: 256_000,
      auto_compact_token_limit: 230_400,
      tool_mode: "code_mode_only",
    });
    expect((models[3]!.supported_reasoning_levels as Array<{ effort: string; description: string }>))
      .toEqual([
        { effort: "low", description: "Light — ChatGPT Instant 5.5" },
        { effort: "medium", description: "Medium" },
        { effort: "high", description: "High" },
        { effort: "xhigh", description: "Extra High" },
        { effort: "ultra", description: "Pro" },
      ]);
  });

  test("is idempotent and omits account-gated Pro when unavailable", () => {
    const config = defaultConfig("browser-only");
    config.proAvailable = false;
    const first = augmentNativeModelCatalog(source(), config);
    const second = augmentNativeModelCatalog(first, config);
    const models = second.models as Array<Record<string, unknown>>;
    expect(models.filter(model => model.slug === CHATGPT_WEB_ROUTED_MODEL)).toHaveLength(1);
    const web = models.find(model => model.slug === CHATGPT_WEB_ROUTED_MODEL)!;
    expect((web.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort))
      .toEqual(["low", "medium", "high", "xhigh"]);
    expect(web.tool_mode).toBeNull();
  });

  test("fails closed when the official native template is absent", () => {
    expect(() => augmentNativeModelCatalog({ models: [{ slug: "other" }] }, defaultConfig("full")))
      .toThrow("missing gpt-5.6-sol");
  });
});
