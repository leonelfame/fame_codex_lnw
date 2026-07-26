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
  test("browser-only advertises one ChatGPT Web model with capability-gated efforts", () => {
    const { source } = fixture();
    const config = defaultConfig("browser-only");
    config.proAvailable = true;
    const catalog = buildManagedCatalog(JSON.parse(readFileSync(source, "utf8")), config);
    const models = catalog.models as Array<Record<string, unknown>>;
    expect(models.map(model => model.slug)).toEqual([
      "chatgpt-web/gpt-5.6-sol",
      "gpt-5.6-sol",
      "native-other",
    ]);
    expect(models[0]).toMatchObject({
      display_name: "ChatGPT Web",
      context_window: 256_000,
      auto_compact_token_limit: 230_400,
      default_reasoning_level: "high",
      supported_in_api: false,
    });
    expect(models[1]).toMatchObject({
      slug: "gpt-5.6-sol",
      context_window: 372_000,
      max_context_window: 372_000,
      auto_compact_token_limit: 334_800,
    });
    expect((models[0]!.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort))
      .toEqual(["light", "medium", "high", "xhigh", "pro"]);
  });

  test("full mode keeps one model and enables local tools for non-Pro efforts", () => {
    const { source } = fixture();
    const config = defaultConfig("full");
    config.proAvailable = true;
    const catalog = buildManagedCatalog(JSON.parse(readFileSync(source, "utf8")), config);
    const models = catalog.models as Array<Record<string, unknown>>;
    expect(models.slice(0, 2).map(model => model.slug)).toEqual([
      "chatgpt-web/gpt-5.6-sol",
      "gpt-5.6-sol",
    ]);
    expect((models[0]!.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort))
      .toEqual(["light", "medium", "high", "xhigh", "pro"]);
    expect(models[0]!.tool_mode).toBe("code_mode_only");
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
    const config = defaultConfig("browser-only");
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
    expect(readFileSync(journal.catalogPath, "utf8")).toContain("chatgpt-web/gpt-5.6-sol");

    expect(uninstallCodexIntegration()).toEqual({ changed: true, removedCatalog: true });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(uninstallCodexIntegration()).toEqual({ changed: false, removedCatalog: false });
  });

  test("migrates the removed legacy Pro model slug without touching native defaults", () => {
    const { codexHome, source } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "chatgpt-web/gpt-5.6-sol-pro"\n');
    const config = defaultConfig("browser-only");
    config.proAvailable = true;

    installCodexIntegration(config, { sourceCatalogPath: source });
    expect(readFileSync(configPath, "utf8")).toContain('model = "chatgpt-web/gpt-5.6-sol"');

    uninstallCodexIntegration();
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(config, { sourceCatalogPath: source });
    expect(readFileSync(configPath, "utf8")).toContain('model = "gpt-5.6-sol"');
  });

  test("updates from the preserved pre-install catalog instead of a polluted prior setup source", () => {
    const { codexHome, source } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, `model = "gpt-5.6-sol"\nmodel_catalog_json = ${JSON.stringify(source)}\n`);
    const polluted = join(codexHome, "model-catalog-700000.json");
    const pollutedCatalog = JSON.parse(readFileSync(source, "utf8")) as {
      models: Array<Record<string, unknown>>;
    };
    const native = pollutedCatalog.models.find(model => model.slug === "gpt-5.6-sol")!;
    native.context_window = 736_843;
    native.max_context_window = 736_843;
    delete native.auto_compact_token_limit;
    writeFileSync(polluted, JSON.stringify(pollutedCatalog));

    const config = defaultConfig("browser-only");
    config.proAvailable = true;
    installCodexIntegration(config, { sourceCatalogPath: polluted, replaceExistingRoute: true });
    const journal = installCodexIntegration(config);

    expect(journal.sourceCatalogPath).toBe(source);
    const managed = JSON.parse(readFileSync(journal.catalogPath, "utf8")) as {
      models: Array<Record<string, unknown>>;
    };
    expect(managed.models.find(model => model.slug === "gpt-5.6-sol")).toMatchObject({
      context_window: 372_000,
      max_context_window: 372_000,
      auto_compact_token_limit: 334_800,
    });
  });

  test("uninstall fails closed when a managed value changed after setup", () => {
    const { codexHome, source } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, "model = \"gpt-5.6-sol\"\n");
    const config = defaultConfig("browser-only");
    config.proAvailable = true;
    installCodexIntegration(config, { sourceCatalogPath: source });
    const changed = readFileSync(configPath, "utf8").replace("17841", "17842");
    writeFileSync(configPath, changed);
    expect(() => uninstallCodexIntegration()).toThrow("changed after setup");
    expect(readFileSync(configPath, "utf8")).toBe(changed);
  });
});
