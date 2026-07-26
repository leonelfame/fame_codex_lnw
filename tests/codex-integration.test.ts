import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManagedCatalog, installCodexIntegration, uninstallCodexIntegration } from "../src/codex-integration";
import { defaultConfig } from "../src/config";

const roots: string[] = [];

function fixture(): { root: string; codexHome: string; appHome: string; source: string } {
  const root = join(tmpdir(), `codex-chatgpt-web-integration-${process.pid}-${Date.now()}-${Math.random()}`);
  const codexHome = join(root, "codex");
  const appHome = join(root, "app");
  mkdirSync(codexHome, { recursive: true });
  const source = join(codexHome, "models_cache.json");
  writeFileSync(source, JSON.stringify({
    client_version: "test",
    etag: "native",
    fetched_at: "2026-01-01T00:00:00Z",
    models: [
      {
        slug: "gpt-5.6-sol",
        display_name: "GPT-5.6-Sol",
        description: "native",
        context_window: 372_000,
        max_context_window: 372_000,
        auto_compact_token_limit: 334_800,
        default_reasoning_level: "low",
        supported_reasoning_levels: [
          { effort: "low", description: "Low" },
          { effort: "medium", description: "Medium" },
          { effort: "high", description: "High" },
          { effort: "xhigh", description: "Extra high" },
        ],
        tool_mode: "code_mode_only",
        visibility: "list",
        supported_in_api: true,
      },
      { slug: "native-other", display_name: "Other" },
    ],
  }));
  roots.push(root);
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_CHATGPT_WEB_HOME = appHome;
  return { root, codexHome, appHome, source };
}

afterEach(() => {
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_CHATGPT_WEB_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex catalog and reversible config integration", () => {
  test("pro-only advertises exactly one injected model and preserves native entries", () => {
    const { source } = fixture();
    const config = defaultConfig("pro-only");
    config.proAvailable = true;
    const catalog = buildManagedCatalog(JSON.parse(readFileSync(source, "utf8")), config);
    const models = catalog.models as Array<Record<string, unknown>>;
    expect(models.map(model => model.slug)).toEqual([
      "chatgpt-web/gpt-5.6-sol-pro",
      "gpt-5.6-sol",
      "native-other",
    ]);
    expect(models[0]).toMatchObject({
      display_name: "ChatGPT Pro (web)",
      context_window: 256_000,
      auto_compact_token_limit: 230_400,
      supported_reasoning_levels: [],
      supported_in_api: false,
    });
    expect(models[0]).not.toHaveProperty("default_reasoning_level");
  });

  test("full mode injects standard reasoning efforts and the separate Pro model", () => {
    const { source } = fixture();
    const config = defaultConfig("full");
    config.proAvailable = true;
    const catalog = buildManagedCatalog(JSON.parse(readFileSync(source, "utf8")), config);
    const models = catalog.models as Array<Record<string, unknown>>;
    expect(models.slice(0, 2).map(model => model.slug)).toEqual([
      "chatgpt-web/gpt-5.6-sol",
      "chatgpt-web/gpt-5.6-sol-pro",
    ]);
    expect((models[0]!.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort))
      .toEqual(["medium", "high", "xhigh"]);
  });

  test("full mode omits Pro when the authenticated account lacks that capability", () => {
    const { source } = fixture();
    const config = defaultConfig("full");
    config.proAvailable = false;
    const catalog = buildManagedCatalog(JSON.parse(readFileSync(source, "utf8")), config);
    const models = catalog.models as Array<Record<string, unknown>>;
    expect(models.map(model => model.slug)).toEqual([
      "chatgpt-web/gpt-5.6-sol",
      "gpt-5.6-sol",
      "native-other",
    ]);
  });

  test("refuses an existing route unless replacement is explicit, then restores it exactly", () => {
    const { codexHome, source } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = `model = "gpt-5.6-sol"\nmodel_provider = "existing-provider"\nopenai_base_url = "http://127.0.0.1:9999/v1"\n\n[features]\ngoals = true\n`;
    writeFileSync(configPath, original);
    const config = defaultConfig("pro-only");
    config.proAvailable = true;
    expect(() => installCodexIntegration(config, { sourceCatalogPath: source })).toThrow("--replace-codex-route");

    const journal = installCodexIntegration(config, { sourceCatalogPath: source, replaceExistingRoute: true });
    const installed = readFileSync(configPath, "utf8");
    expect(installed).toContain('model_provider = "codex-chatgpt-web"');
    expect(installed).toContain('base_url = "http://127.0.0.1:17841/v1"');
    expect(installed).toContain("requires_openai_auth = true");
    expect(installed).toContain("supports_websockets = false");
    expect(installed).toContain('openai_base_url = "http://127.0.0.1:9999/v1"');
    expect(installed).toContain(`model_catalog_json = ${JSON.stringify(journal.catalogPath)}`);
    expect(readFileSync(journal.catalogPath, "utf8")).toContain("chatgpt-web/gpt-5.6-sol-pro");

    expect(uninstallCodexIntegration()).toEqual({ changed: true, removedCatalog: true });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(uninstallCodexIntegration()).toEqual({ changed: false, removedCatalog: false });
  });

  test("uninstall fails closed when a managed value changed after setup", () => {
    const { codexHome, source } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, "model = \"gpt-5.6-sol\"\n");
    const config = defaultConfig("pro-only");
    config.proAvailable = true;
    installCodexIntegration(config, { sourceCatalogPath: source });
    const changed = readFileSync(configPath, "utf8").replace("17841", "17842");
    writeFileSync(configPath, changed);
    expect(() => uninstallCodexIntegration()).toThrow("changed after setup");
    expect(readFileSync(configPath, "utf8")).toBe(changed);
  });
});
