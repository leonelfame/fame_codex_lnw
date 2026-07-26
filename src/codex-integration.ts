import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AppConfig } from "./config";
import { atomicWriteFile, getConfigDir } from "./config";

const STANDARD_MODEL = "chatgpt-web/gpt-5.6-sol";
const PRO_MODEL = "chatgpt-web/gpt-5.6-sol-pro";
const MANAGED_COMMENT = "# Managed by codex-chatgpt-web; `codex-chatgpt-web uninstall` restores prior values.";

type JsonObject = Record<string, unknown>;

interface PreviousAssignment {
  present: boolean;
  rawLine?: string;
  value?: string;
}

export interface CodexIntegrationJournal {
  version: 1;
  configPath: string;
  catalogPath: string;
  sourceCatalogPath: string;
  catalogSha256: string;
  installed: {
    openai_base_url: string;
    model_catalog_json: string;
  };
  previous: {
    openai_base_url: PreviousAssignment;
    model_catalog_json: PreviousAssignment;
  };
}

export interface InstallCodexIntegrationOptions {
  replaceExistingRoute?: boolean;
  sourceCatalogPath?: string;
}

export interface UninstallCodexIntegrationResult {
  changed: boolean;
  removedCatalog: boolean;
}

export function getCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return resolve(configured || join(homedir(), ".codex"));
}

export function getCodexConfigPath(): string {
  return join(getCodexHome(), "config.toml");
}

export function getManagedCatalogPath(): string {
  return join(getConfigDir(), "codex", "model-catalog.json");
}

export function getCodexJournalPath(): string {
  return join(getConfigDir(), "codex", "integration-journal.json");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as JsonObject;
}

function modelSlug(value: unknown): string | undefined {
  const model = value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
  return typeof model?.slug === "string" ? model.slug : undefined;
}

function cloneObject(value: JsonObject): JsonObject {
  return structuredClone(value);
}

function reasoningLevel(template: JsonObject, effort: string, fallbackDescription: string): JsonObject {
  const levels = Array.isArray(template.supported_reasoning_levels)
    ? template.supported_reasoning_levels.filter(level => level && typeof level === "object") as JsonObject[]
    : [];
  const source = levels.find(level => level.effort === effort);
  return source ? cloneObject(source) : { effort, description: fallbackDescription };
}

export function buildManagedCatalog(source: unknown, config: AppConfig): JsonObject {
  const catalog = cloneObject(asObject(source, "Codex model catalog"));
  if (!Array.isArray(catalog.models)) throw new Error("Codex model catalog is missing a models array");
  const models = catalog.models.filter(model => modelSlug(model) !== STANDARD_MODEL && modelSlug(model) !== PRO_MODEL);
  const template = models.find(model => modelSlug(model) === "gpt-5.6-sol");
  if (!template || typeof template !== "object" || Array.isArray(template)) {
    throw new Error("The native gpt-5.6-sol catalog entry is missing. Update Codex, then rerun setup.");
  }
  const native = template as JsonObject;
  const compactLimit = Math.floor(config.contextWindow * 0.9);
  const common: JsonObject = {
    ...cloneObject(native),
    context_window: config.contextWindow,
    max_context_window: config.contextWindow,
    auto_compact_token_limit: compactLimit,
    input_modalities: ["text", "image"],
    visibility: "list",
    supported_in_api: false,
    tool_mode: null,
    upgrade: null,
  };
  const pro: JsonObject = {
    ...cloneObject(common),
    slug: PRO_MODEL,
    display_name: "ChatGPT Pro (web)",
    description: "ChatGPT Pro through a private browser turn. Full Codex context and images; local tools are unavailable.",
    supported_reasoning_levels: [],
  };
  delete pro.default_reasoning_level;
  delete pro.availability_nux;

  const injected: JsonObject[] = [];
  if (config.mode === "full") {
    injected.push({
      ...cloneObject(common),
      slug: STANDARD_MODEL,
      display_name: "ChatGPT 5.6 (web + Codex tools)",
      description: "ChatGPT web reasoning with the native Codex tool harness through a turn-bound MCP connector.",
      default_reasoning_level: "high",
      supported_reasoning_levels: [
        reasoningLevel(native, "medium", "Balances speed and reasoning depth"),
        reasoningLevel(native, "high", "Greater reasoning depth for complex tasks"),
        reasoningLevel(native, "xhigh", "Extra high reasoning depth for complex tasks"),
      ],
    });
  }
  injected.push(pro);
  catalog.models = [...injected, ...models];
  catalog.etag = null;
  catalog.fetched_at = new Date().toISOString();
  return catalog;
}

function firstTableIndex(lines: string[]): number {
  const index = lines.findIndex(line => /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(line));
  return index < 0 ? lines.length : index;
}

function assignmentRegex(key: string): RegExp {
  return new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*=\\s*(.+?)\\s*$`);
}

function stripTomlComment(value: string): string {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") return value.slice(0, index).trimEnd();
  }
  return value.trimEnd();
}

function decodeTomlString(raw: string, key: string): string {
  const value = stripTomlComment(raw).trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) as string; }
    catch { throw new Error(`Could not parse ${key} in Codex config`); }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  throw new Error(`${key} in Codex config must be a quoted string`);
}

interface AssignmentLocation extends PreviousAssignment {
  index?: number;
}

function findTopLevelAssignment(lines: string[], key: string): AssignmentLocation {
  const limit = firstTableIndex(lines);
  const regex = assignmentRegex(key);
  const matches: Array<{ index: number; rawLine: string; value: string }> = [];
  for (let index = 0; index < limit; index += 1) {
    const line = lines[index]!;
    if (/^\s*#/.test(line)) continue;
    const match = regex.exec(line);
    if (match) matches.push({ index, rawLine: line, value: decodeTomlString(match[1]!, key) });
  }
  if (matches.length > 1) throw new Error(`Codex config contains duplicate top-level ${key} assignments`);
  const match = matches[0];
  return match ? { present: true, ...match } : { present: false };
}

function setTopLevelAssignments(
  text: string,
  values: Record<"openai_base_url" | "model_catalog_json", string>,
): { text: string; previous: CodexIntegrationJournal["previous"] } {
  const hadTrailingNewline = text.endsWith("\n");
  const lines = text.length > 0 ? text.replace(/\n$/, "").split("\n") : [];
  const openai = findTopLevelAssignment(lines, "openai_base_url");
  const catalog = findTopLevelAssignment(lines, "model_catalog_json");
  const updates = [
    { key: "openai_base_url" as const, value: values.openai_base_url, location: openai },
    { key: "model_catalog_json" as const, value: values.model_catalog_json, location: catalog },
  ];
  for (const update of updates.filter(update => update.location.index !== undefined)) {
    lines[update.location.index!] = `${update.key} = ${JSON.stringify(update.value)}`;
  }
  const missing = updates.filter(update => update.location.index === undefined);
  if (missing.length > 0) {
    const insertAt = firstTableIndex(lines);
    const block = [
      ...(insertAt > 0 && lines[insertAt - 1]?.trim() !== "" ? [""] : []),
      MANAGED_COMMENT,
      ...missing.map(update => `${update.key} = ${JSON.stringify(update.value)}`),
      ...(insertAt < lines.length && lines[insertAt]?.trim() !== "" ? [""] : []),
    ];
    lines.splice(insertAt, 0, ...block);
  }
  return {
    text: `${lines.join("\n")}${hadTrailingNewline || lines.length > 0 ? "\n" : ""}`,
    previous: {
      openai_base_url: { present: openai.present, ...(openai.rawLine ? { rawLine: openai.rawLine, value: openai.value } : {}) },
      model_catalog_json: { present: catalog.present, ...(catalog.rawLine ? { rawLine: catalog.rawLine, value: catalog.value } : {}) },
    },
  };
}

function restoreTopLevelAssignments(text: string, journal: CodexIntegrationJournal): string {
  const hadTrailingNewline = text.endsWith("\n");
  const lines = text.length > 0 ? text.replace(/\n$/, "").split("\n") : [];
  const keys = ["openai_base_url", "model_catalog_json"] as const;
  for (const key of keys) {
    const current = findTopLevelAssignment(lines, key);
    if (!current.present || current.value !== journal.installed[key] || current.index === undefined) {
      throw new Error(`Refusing to uninstall: Codex ${key} changed after setup. Restore ${JSON.stringify(journal.installed[key])} first.`);
    }
    const previous = journal.previous[key];
    if (previous.present) {
      if (!previous.rawLine) throw new Error(`Codex integration journal is missing the prior ${key} line`);
      lines[current.index] = previous.rawLine;
    } else {
      lines.splice(current.index, 1);
    }
  }
  const marker = lines.indexOf(MANAGED_COMMENT);
  if (marker >= 0) {
    lines.splice(marker, 1);
    if (lines[marker]?.trim() === "" && (marker === 0 || lines[marker - 1]?.trim() === "")) lines.splice(marker, 1);
  }
  return `${lines.join("\n").replace(/^\n+|\n+$/g, "")}${hadTrailingNewline || lines.length > 0 ? "\n" : ""}`;
}

function readJournal(): CodexIntegrationJournal | undefined {
  const path = getCodexJournalPath();
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<CodexIntegrationJournal>;
  if (value.version !== 1 || !value.installed || !value.previous) throw new Error(`Invalid Codex integration journal: ${path}`);
  return value as CodexIntegrationJournal;
}

function sourceCatalogFrom(configText: string, explicit?: string): string {
  if (explicit) return resolve(explicit);
  const lines = configText.length > 0 ? configText.replace(/\n$/, "").split("\n") : [];
  const configured = findTopLevelAssignment(lines, "model_catalog_json");
  if (configured.value && resolve(configured.value) !== getManagedCatalogPath()) return resolve(configured.value);
  return join(getCodexHome(), "models_cache.json");
}

export function installCodexIntegration(
  config: AppConfig,
  options: InstallCodexIntegrationOptions = {},
): CodexIntegrationJournal {
  const configPath = getCodexConfigPath();
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const configText = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const existingJournal = readJournal();
  if (existingJournal) {
    const lines = configText.length > 0 ? configText.replace(/\n$/, "").split("\n") : [];
    for (const key of ["openai_base_url", "model_catalog_json"] as const) {
      const current = findTopLevelAssignment(lines, key);
      if (current.value !== existingJournal.installed[key]) {
        throw new Error(`Codex ${key} changed after setup; refusing to overwrite the user's newer value`);
      }
    }
  }

  const sourceCatalogPath = resolve(options.sourceCatalogPath || existingJournal?.sourceCatalogPath || sourceCatalogFrom(configText));
  if (!existsSync(sourceCatalogPath)) throw new Error(`Codex source model catalog does not exist: ${sourceCatalogPath}`);
  const source = JSON.parse(readFileSync(sourceCatalogPath, "utf8")) as unknown;
  const managed = `${JSON.stringify(buildManagedCatalog(source, config), null, 2)}\n`;
  const catalogPath = getManagedCatalogPath();
  const installed = {
    openai_base_url: `http://${config.host}:${config.port}/v1`,
    model_catalog_json: catalogPath,
  };

  const currentOpenAi = findTopLevelAssignment(configText.length > 0 ? configText.replace(/\n$/, "").split("\n") : [], "openai_base_url");
  if (!existingJournal && currentOpenAi.value && currentOpenAi.value !== installed.openai_base_url && !options.replaceExistingRoute) {
    throw new Error(
      `Codex already uses openai_base_url=${JSON.stringify(currentOpenAi.value)}. `
      + "Rerun with --replace-codex-route to replace it reversibly.",
    );
  }

  const patched = setTopLevelAssignments(configText, installed);
  const journal: CodexIntegrationJournal = {
    version: 1,
    configPath,
    catalogPath,
    sourceCatalogPath,
    catalogSha256: sha256(managed),
    installed,
    previous: existingJournal?.previous ?? patched.previous,
  };
  atomicWriteFile(catalogPath, managed);
  atomicWriteFile(configPath, patched.text);
  atomicWriteFile(getCodexJournalPath(), `${JSON.stringify(journal, null, 2)}\n`);
  return journal;
}

export function uninstallCodexIntegration(): UninstallCodexIntegrationResult {
  const journal = readJournal();
  if (!journal) return { changed: false, removedCatalog: false };
  if (!existsSync(journal.configPath)) throw new Error(`Codex config is missing: ${journal.configPath}`);
  if (existsSync(journal.catalogPath) && sha256(readFileSync(journal.catalogPath)) !== journal.catalogSha256) {
    throw new Error(`Refusing to uninstall: managed catalog changed after setup: ${journal.catalogPath}`);
  }
  const current = readFileSync(journal.configPath, "utf8");
  atomicWriteFile(journal.configPath, restoreTopLevelAssignments(current, journal));
  let removedCatalog = false;
  if (existsSync(journal.catalogPath)) {
    rmSync(journal.catalogPath);
    removedCatalog = true;
  }
  rmSync(getCodexJournalPath());
  return { changed: true, removedCatalog };
}

export function inspectCodexIntegration(): {
  installed: boolean;
  configPath: string;
  catalogPath: string;
  journal?: CodexIntegrationJournal;
  errors: string[];
} {
  const journal = readJournal();
  const errors: string[] = [];
  if (journal) {
    try {
      const text = readFileSync(journal.configPath, "utf8");
      const lines = text.replace(/\n$/, "").split("\n");
      for (const key of ["openai_base_url", "model_catalog_json"] as const) {
        if (findTopLevelAssignment(lines, key).value !== journal.installed[key]) errors.push(`Codex ${key} no longer matches this installation`);
      }
      if (!existsSync(journal.catalogPath)) errors.push("Managed Codex model catalog is missing");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    installed: Boolean(journal),
    configPath: getCodexConfigPath(),
    catalogPath: getManagedCatalogPath(),
    ...(journal ? { journal } : {}),
    errors,
  };
}
