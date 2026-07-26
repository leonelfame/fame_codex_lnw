import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig, saveConfig } from "../src/config";
import { installCodexIntegration } from "../src/codex-integration";
import { startServer } from "../src/server";

const codex = resolve(process.argv[2] ?? "/Applications/ChatGPT.app/Contents/Resources/codex");
const bundled = Bun.spawnSync([codex, "debug", "models", "--bundled"], { stdout: "pipe", stderr: "pipe" });
if (bundled.exitCode !== 0) throw new Error(`Could not read bundled Codex catalog: ${bundled.stderr.toString()}`);
const sourceCatalog = JSON.parse(bundled.stdout.toString()) as { models?: unknown[] };
if (!sourceCatalog.models?.some(model => model && typeof model === "object" && (model as { slug?: string }).slug === "gpt-5.6-sol")) {
  throw new Error("Bundled Codex catalog has no gpt-5.6-sol template");
}

const root = join(tmpdir(), `codex-chatgpt-web-codex-smoke-${process.pid}-${Date.now()}`);
process.env.CODEX_HOME = join(root, "codex");
process.env.CODEX_CHATGPT_WEB_HOME = join(root, "app");
mkdirSync(process.env.CODEX_HOME, { recursive: true });
const source = join(root, "bundled-models.json");
writeFileSync(source, `${JSON.stringify(sourceCatalog)}\n`);
const config = defaultConfig("pro-only");
config.proAvailable = true;
const port = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
config.port = port.port;
port.stop();
config.acknowledgedUnofficialAt = new Date().toISOString();
saveConfig(config);
installCodexIntegration(config, { sourceCatalogPath: source });
const server = startServer(config);
try {
  const result = Bun.spawnSync([codex, "debug", "models"], {
    env: { ...process.env, CODEX_HOME: process.env.CODEX_HOME },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`Codex rejected the generated catalog: ${result.stderr.toString()}`);
  const catalog = JSON.parse(result.stdout.toString()) as { models?: Array<{ slug?: string; supported_reasoning_levels?: unknown[] }> };
  const pro = catalog.models?.find(model => model.slug === "chatgpt-web/gpt-5.6-sol-pro");
  if (!pro) throw new Error("Codex did not expose the generated Pro model");
  if (!Array.isArray(pro.supported_reasoning_levels) || pro.supported_reasoning_levels.length !== 0) {
    throw new Error("Codex did not preserve the Pro no-effort model contract");
  }
  process.stdout.write("NATIVE_CODEX_CATALOG_SMOKE_OK\n");
} finally {
  await server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
