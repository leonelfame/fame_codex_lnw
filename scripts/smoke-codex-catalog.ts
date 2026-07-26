import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { defaultConfig } from "../src/config";
import { augmentNativeModelCatalog } from "../src/model-catalog";

const codex = resolve(process.argv[2] ?? "/Applications/ChatGPT.app/Contents/Resources/codex");
function runCodex(args: string[], env = process.env): { stdout: string; stderr: string } {
  const result = spawnSync(codex, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
    timeout: 15_000,
  });
  if (result.status !== 0) {
    throw new Error(`Codex ${args.join(" ")} failed: ${result.error?.message || result.stderr || result.signal || `exit ${result.status}`}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

const bundled = runCodex(["debug", "models", "--bundled"]);
const sourceCatalog = JSON.parse(bundled.stdout) as { models?: unknown[] };
if (!sourceCatalog.models?.some(model => model && typeof model === "object" && (model as { slug?: string }).slug === "gpt-5.6-sol")) {
  throw new Error("Bundled Codex catalog has no gpt-5.6-sol template");
}

const root = join(tmpdir(), `codex-chatgpt-web-codex-smoke-${process.pid}-${Date.now()}`);
process.env.CODEX_HOME = join(root, "codex");
process.env.CODEX_CHATGPT_WEB_HOME = join(root, "app");
mkdirSync(process.env.CODEX_HOME, { recursive: true });
const config = defaultConfig("browser-only");
config.proAvailable = true;
const catalogPath = join(root, "augmented-models.json");
writeFileSync(catalogPath, `${JSON.stringify(augmentNativeModelCatalog(sourceCatalog, config))}\n`);
writeFileSync(join(process.env.CODEX_HOME, "config.toml"), `model_catalog_json = ${JSON.stringify(catalogPath)}\n`);
try {
  const result = runCodex(["debug", "models"], { ...process.env, CODEX_HOME: process.env.CODEX_HOME });
  const catalog = JSON.parse(result.stdout) as { models?: Array<{ slug?: string; supported_reasoning_levels?: unknown[] }> };
  const web = catalog.models?.find(model => model.slug === "chatgpt-web/gpt-5.6-sol");
  if (!web) throw new Error("Codex did not expose the generated ChatGPT Web model");
  const efforts = Array.isArray(web.supported_reasoning_levels)
    ? (web.supported_reasoning_levels as Array<{ effort?: string }>).map(level => level.effort)
    : [];
  if (JSON.stringify(efforts) !== JSON.stringify(["low", "medium", "high", "xhigh", "ultra"])) {
    throw new Error(`Codex did not preserve the ChatGPT Web effort contract: ${JSON.stringify(efforts)}`);
  }
  process.stdout.write("NATIVE_CODEX_CATALOG_SMOKE_OK\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
