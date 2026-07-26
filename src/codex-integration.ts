import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AppConfig } from "./config";
import { atomicWriteFile, getConfigDir } from "./config";

const STANDARD_MODEL = "chatgpt-web/gpt-5.6-sol";
const PRO_MODEL = "chatgpt-web/gpt-5.6-sol-pro";
const PROVIDER_ID = "codex-chatgpt-web";
const MANAGED_COMMENT = "# Managed by codex-chatgpt-web; `codex-chatgpt-web uninstall` restores prior values.";
const PROVIDER_BEGIN = "# BEGIN codex-chatgpt-web provider";
const PROVIDER_END = "# END codex-chatgpt-web provider";

type JsonObject = Record<string, unknown>;

interface PreviousAssignment {
  present: boolean;
  rawLine?: string;
  value?: string;
}

export interface CodexIntegrationJournal {
  version: 2;
  configPath: string;
  catalogPath: string;
  sourceCatalogPath: string;
  catalogSha256: string;
  providerBlock: string;
  installed: {
    model_provider: string;
    model_catalog_json: string;
  };
  previous: {
    model_provider: PreviousAssignment;
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

function validateSourceCatalog(source: unknown, label: string): JsonObject {
  const catalog = asObject(source, label);
  if (!Array.isArray(catalog.models)) throw new Error(`${label} is missing a models array`);
  if (!catalog.models.some(model => modelSlug(model) === "gpt-5.6-sol")) {
    throw new Error(`${label} is missing the native gpt-5.6-sol entry`);
  }
  return catalog;
}

function bundledCatalogSnapshotPath(): string {
  return join(getConfigDir(), "codex", "source-model-catalog.bundled.json");
}

function codexCommandCandidates(): string[] {
  const configured = process.env.CODEX_CHATGPT_WEB_CODEX_BINARY?.trim();
  return [
    ...(configured ? [configured] : []),
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "codex",
  ];
}

function readJsonCatalogFile(path: string): { path: string; source: JsonObject } {
  if (!existsSync(path)) throw new Error(`Codex source model catalog does not exist: ${path}`);
  return { path, source: validateSourceCatalog(JSON.parse(readFileSync(path, "utf8")), `Codex source model catalog at ${path}`) };
}

function readBundledCodexCatalog(): { path: string; source: JsonObject } {
  const errors: string[] = [];
  for (const command of codexCommandCandidates()) {
    const result = spawnSync(command, ["debug", "models", "--bundled"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    if (result.status !== 0) {
      const detail = result.error?.message || result.stderr || result.signal || `exit ${result.status}`;
      errors.push(`${command}: ${detail.trim()}`);
      continue;
    }
    try {
      const source = validateSourceCatalog(JSON.parse(result.stdout), `bundled Codex catalog from ${command}`);
      const path = bundledCatalogSnapshotPath();
      atomicWriteFile(path, `${JSON.stringify(source, null, 2)}\n`);
      return { path, source };
    } catch (error) {
      errors.push(`${command}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(
    "Could not read Codex's bundled model catalog. "
    + "Install or update the ChatGPT app, or pass --source-catalog PATH explicitly. "
    + `Attempts: ${errors.join("; ")}`,
  );
}

function readPreservedSourceCatalog(
  existingJournal: CodexIntegrationJournal | undefined,
): { path: string; source: JsonObject } | undefined {
  if (!existingJournal) return undefined;
  const previous = existingJournal.previous.model_catalog_json;
  if (!previous.present) return undefined;
  if (!previous.value) {
    throw new Error("Codex integration journal is missing the preserved pre-install model catalog path");
  }
  const path = resolve(previous.value);
  if (path === resolve(getManagedCatalogPath())) {
    throw new Error("Codex integration journal points its preserved source at the managed catalog; refusing recursive catalog generation");
  }
  return readJsonCatalogFile(path);
}

export function buildManagedCatalog(source: unknown, config: AppConfig): JsonObject {
  const catalog = cloneObject(validateSourceCatalog(source, "Codex model catalog"));
  const sourceModels = catalog.models as unknown[];
  const models = sourceModels.filter(model => modelSlug(model) !== STANDARD_MODEL && modelSlug(model) !== PRO_MODEL);
  const template = models.find(model => modelSlug(model) === "gpt-5.6-sol");
  if (!template || typeof template !== "object" || Array.isArray(template)) {
    throw new Error("The native gpt-5.6-sol catalog entry is missing. Update Codex, then rerun setup.");
  }
  const native = template as JsonObject;
  const compactLimit = Math.floor(config.contextWindow * 0.9);
  const webModel: JsonObject = {
    ...cloneObject(native),
    slug: STANDARD_MODEL,
    display_name: "ChatGPT Web",
    description: "ChatGPT web through one native Codex model surface. Effort selects Light, Medium, High, Extra High, or account-gated Pro.",
    context_window: config.contextWindow,
    max_context_window: config.contextWindow,
    auto_compact_token_limit: compactLimit,
    input_modalities: ["text", "image"],
    visibility: "list",
    supported_in_api: false,
    tool_mode: config.mode === "full" ? native.tool_mode : null,
    upgrade: null,
    default_reasoning_level: "high",
    supported_reasoning_levels: [
      { effort: "light", description: "Light — ChatGPT Instant 5.5" },
      reasoningLevel(native, "medium", "Medium"),
      reasoningLevel(native, "high", "High"),
      reasoningLevel(native, "xhigh", "Extra High"),
      ...(config.proAvailable ? [{ effort: "pro", description: "Pro" }] : []),
    ],
  };
  delete webModel.availability_nux;
  catalog.models = [webModel, ...models];
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

type ManagedAssignmentKey = "model_provider" | "model_catalog_json";

function migrateLegacyDefaultModel(text: string): string {
  const lines = text.length > 0 ? text.replace(/\n$/, "").split("\n") : [];
  const current = findTopLevelAssignment(lines, "model");
  if (current.index === undefined || current.value !== PRO_MODEL) return text;
  lines[current.index] = `model = ${JSON.stringify(STANDARD_MODEL)}`;
  return `${lines.join("\n")}${text.endsWith("\n") || lines.length > 0 ? "\n" : ""}`;
}

function setTopLevelAssignments(
  text: string,
  values: Record<ManagedAssignmentKey, string>,
): { text: string; previous: CodexIntegrationJournal["previous"] } {
  const hadTrailingNewline = text.endsWith("\n");
  const lines = text.length > 0 ? text.replace(/\n$/, "").split("\n") : [];
  const provider = findTopLevelAssignment(lines, "model_provider");
  const catalog = findTopLevelAssignment(lines, "model_catalog_json");
  const updates = [
    { key: "model_provider" as const, value: values.model_provider, location: provider },
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
      model_provider: { present: provider.present, ...(provider.rawLine ? { rawLine: provider.rawLine, value: provider.value } : {}) },
      model_catalog_json: { present: catalog.present, ...(catalog.rawLine ? { rawLine: catalog.rawLine, value: catalog.value } : {}) },
    },
  };
}

function providerBlock(config: AppConfig): string {
  return [
    PROVIDER_BEGIN,
    `[model_providers.${PROVIDER_ID}]`,
    'name = "Codex + ChatGPT Web"',
    `base_url = ${JSON.stringify(`http://${config.host}:${config.port}/v1`)}`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "supports_websockets = false",
    PROVIDER_END,
  ].join("\n");
}

function installProviderBlock(text: string, block: string, previousBlock?: string): string {
  if (previousBlock) {
    if (!text.includes(previousBlock)) throw new Error("Managed Codex provider block changed after setup");
    return text.replace(previousBlock, block);
  }
  if (text.includes(PROVIDER_BEGIN) || text.includes(PROVIDER_END)
    || new RegExp(`^\\s*\\[model_providers\\.${PROVIDER_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*$`, "m").test(text)) {
    throw new Error(`Codex config already contains model_providers.${PROVIDER_ID}; refusing to overwrite it`);
  }
  const trimmed = text.replace(/\s+$/, "");
  return `${trimmed}${trimmed ? "\n\n" : ""}${block}\n`;
}

function restoreIntegrationText(text: string, journal: CodexIntegrationJournal): string {
  if (!text.includes(journal.providerBlock)) {
    throw new Error("Refusing to uninstall: managed Codex provider block changed after setup");
  }
  const withoutProvider = text.replace(journal.providerBlock, "").replace(/\n{3,}/g, "\n\n");
  const hadTrailingNewline = withoutProvider.endsWith("\n");
  const lines = withoutProvider.length > 0 ? withoutProvider.replace(/\n$/, "").split("\n") : [];
  const keys: ManagedAssignmentKey[] = ["model_provider", "model_catalog_json"];
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
  if (value.version !== 2 || !value.installed || !value.previous || typeof value.providerBlock !== "string") {
    throw new Error(`Invalid Codex integration journal: ${path}`);
  }
  return value as CodexIntegrationJournal;
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
    for (const key of ["model_provider", "model_catalog_json"] as const) {
      const current = findTopLevelAssignment(lines, key);
      if (current.value !== existingJournal.installed[key]) {
        throw new Error(`Codex ${key} changed after setup; refusing to overwrite the user's newer value`);
      }
    }
    if (!configText.includes(existingJournal.providerBlock)) {
      throw new Error("Managed Codex provider block changed after setup; refusing to overwrite it");
    }
  }

  const loadedSource = options.sourceCatalogPath
    ? readJsonCatalogFile(resolve(options.sourceCatalogPath))
    : readPreservedSourceCatalog(existingJournal) ?? readBundledCodexCatalog();
  const sourceCatalogPath = loadedSource.path;
  const source = loadedSource.source;
  const managed = `${JSON.stringify(buildManagedCatalog(source, config), null, 2)}\n`;
  const catalogPath = getManagedCatalogPath();
  const installed = {
    model_provider: PROVIDER_ID,
    model_catalog_json: catalogPath,
  };

  const currentProvider = findTopLevelAssignment(configText.length > 0 ? configText.replace(/\n$/, "").split("\n") : [], "model_provider");
  if (!existingJournal && currentProvider.value && currentProvider.value !== installed.model_provider && !options.replaceExistingRoute) {
    throw new Error(
      `Codex already uses model_provider=${JSON.stringify(currentProvider.value)}. `
      + "Rerun with --replace-codex-route to replace it reversibly.",
    );
  }

  const patched = setTopLevelAssignments(migrateLegacyDefaultModel(configText), installed);
  const block = providerBlock(config);
  const installedText = installProviderBlock(patched.text, block, existingJournal?.providerBlock);
  const journal: CodexIntegrationJournal = {
    version: 2,
    configPath,
    catalogPath,
    sourceCatalogPath,
    catalogSha256: sha256(managed),
    providerBlock: block,
    installed,
    previous: existingJournal?.previous ?? patched.previous,
  };
  atomicWriteFile(catalogPath, managed);
  atomicWriteFile(configPath, installedText);
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
  atomicWriteFile(journal.configPath, restoreIntegrationText(current, journal));
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
      for (const key of ["model_provider", "model_catalog_json"] as const) {
        if (findTopLevelAssignment(lines, key).value !== journal.installed[key]) errors.push(`Codex ${key} no longer matches this installation`);
      }
      if (!text.includes(journal.providerBlock)) errors.push("Managed Codex provider block no longer matches this installation");
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
