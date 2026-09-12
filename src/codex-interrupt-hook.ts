import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import type { AppConfig } from "./config";
import { getConfigDir } from "./config";
import type { InstalledCodexInterruptHook } from "./codex-integration-shared";

export const MANAGED_INTERRUPT_HOOK_START =
  "# Managed by codex-chatgpt-web: release the exact Responses request when its Codex turn is interrupted.";
export const MANAGED_INTERRUPT_HOOK_END =
  "# End codex-chatgpt-web interrupt lifecycle hook.";

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJson(item)]),
  );
}

/** Match codex_config::version_for_toml for the normalized Interrupt command hook. */
export function codexInterruptHookHash(command: string): string {
  const identity = canonicalJson({
    event_name: "interrupt",
    hooks: [{
      type: "command",
      command,
      timeout: 3,
      async: false,
    }],
  });
  return `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

function posixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function powerShellArgument(value: string): string {
  if (value.includes('"') || /[\r\n]/.test(value)) {
    throw new Error("Codex interrupt hook command contains an invalid Windows path character");
  }
  // Native Codex uses PowerShell on Windows. Single quotes prevent interpolation, and doubling
  // embedded apostrophes preserves literal paths. The caller supplies PowerShell's call operator.
  return `'${value.replaceAll("'", "''")}'`;
}

export function codexInterruptHookCommand(
  config: Pick<AppConfig, "runtimeCommand">,
  home = getConfigDir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const absoluteHome = platform === "win32" ? win32.resolve(home) : posix.resolve(home);
  const args = [...config.runtimeCommand, "--home", absoluteHome, "hook", "interrupt"];
  return (platform === "win32" ? "& " : "")
    + args.map(platform === "win32" ? powerShellArgument : posixShellArgument).join(" ");
}

function lineEnding(text: string): "\n" | "\r\n" | "\r" {
  return text.includes("\r\n") ? "\r\n" : text.includes("\n") ? "\n" : text.includes("\r") ? "\r" : "\n";
}

function interruptGroupCount(text: string): number {
  return text.split(/\r\n|\n|\r/).filter(line => /^\s*\[\[hooks\.Interrupt\]\]\s*(?:#.*)?$/.test(line)).length;
}

function managedMarkerCount(text: string): number {
  return text.split(MANAGED_INTERRUPT_HOOK_START).length - 1;
}

function canonicalConfigPath(configPath: string): string {
  const absolute = resolve(configPath);
  try {
    return realpathSync.native(absolute);
  } catch {
    try {
      return join(realpathSync.native(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

export function installCodexInterruptHook(
  text: string,
  configPath: string,
  config: Pick<AppConfig, "runtimeCommand">,
): { text: string; installed: InstalledCodexInterruptHook } {
  return installCodexInterruptHookCommand(text, configPath, codexInterruptHookCommand(config));
}

export function installCodexInterruptHookCommand(
  text: string,
  configPath: string,
  command: string,
): { text: string; installed: InstalledCodexInterruptHook } {
  if (managedMarkerCount(text) !== 0 || text.includes(MANAGED_INTERRUPT_HOOK_END)) {
    throw new Error("Codex config already contains a codex-chatgpt-web interrupt hook marker");
  }
  const groupIndex = interruptGroupCount(text);
  const stateKey = `${canonicalConfigPath(configPath)}:interrupt:${groupIndex}:0`;
  const trustedHash = codexInterruptHookHash(command);
  const ending = lineEnding(text);
  const core = [
    MANAGED_INTERRUPT_HOOK_START,
    "[[hooks.Interrupt]]",
    "",
    "[[hooks.Interrupt.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(command)}`,
    "timeout = 3",
    "",
    `[hooks.state.${JSON.stringify(stateKey)}]`,
    `trusted_hash = ${JSON.stringify(trustedHash)}`,
    MANAGED_INTERRUPT_HOOK_END,
  ].join(ending);
  const leading = text.length === 0
    ? ""
    : text.endsWith(`${ending}${ending}`)
      ? ""
      : text.endsWith(ending)
        ? ending
        : `${ending}${ending}`;
  const trailing = text.length > 0 && text.endsWith(ending) ? ending : "";
  const fragment = `${leading}${core}${trailing}`;
  return {
    text: `${text}${fragment}`,
    installed: { command, groupIndex, stateKey, trustedHash, fragment },
  };
}

export function restoreVerifiedOrphanedCodexInterruptHook(
  text: string,
  configPath: string,
): string {
  const startCount = managedMarkerCount(text);
  const endCount = text.split(MANAGED_INTERRUPT_HOOK_END).length - 1;
  if (startCount === 0 && endCount === 0) return text;
  if (startCount !== 1 || endCount !== 1) {
    throw new Error("Codex config contains invalid codex-chatgpt-web interrupt hook markers");
  }
  const start = text.indexOf(MANAGED_INTERRUPT_HOOK_START);
  const end = text.indexOf(MANAGED_INTERRUPT_HOOK_END, start) + MANAGED_INTERRUPT_HOOK_END.length;
  const fragment = text.slice(start, end);
  const lines = fragment.split(/\r\n|\n|\r/);
  if (lines.length !== 11
    || lines[0] !== MANAGED_INTERRUPT_HOOK_START
    || lines[1] !== "[[hooks.Interrupt]]"
    || lines[2] !== ""
    || lines[3] !== "[[hooks.Interrupt.hooks]]"
    || lines[4] !== 'type = "command"'
    || !lines[5]?.startsWith("command = ")
    || lines[6] !== "timeout = 3"
    || lines[7] !== ""
    || !lines[8]?.startsWith("[hooks.state.")
    || !lines[9]?.startsWith("trusted_hash = ")
    || lines[10] !== MANAGED_INTERRUPT_HOOK_END) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing automatic repair");
  }
  let command: string;
  let stateKey: string;
  let trustedHash: string;
  try {
    command = JSON.parse(lines[5].slice("command = ".length)) as string;
    stateKey = JSON.parse(lines[8].slice("[hooks.state.".length, -1)) as string;
    trustedHash = JSON.parse(lines[9].slice("trusted_hash = ".length)) as string;
  } catch {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing automatic repair");
  }
  const groupIndex = interruptGroupCount(text.slice(0, start));
  const expectedStateKey = `${canonicalConfigPath(configPath)}:interrupt:${groupIndex}:0`;
  if (typeof command !== "string" || stateKey !== expectedStateKey
    || trustedHash !== codexInterruptHookHash(command)) {
    throw new Error("Codex interrupt lifecycle hook ownership cannot be verified; refusing automatic repair");
  }
  return restoreCodexInterruptHook(text, { command, groupIndex, stateKey, trustedHash, fragment });
}

function hookTextPattern(text: string): string {
  return text.split(/\r\n|\n|\r/)
    .map(line => line.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join("(?:\\r\\n|\\n|\\r)");
}

function locateCodexInterruptHook(text: string, installed: InstalledCodexInterruptHook): Array<{
  start: number; end: number;
}> {
  const parsed = Bun.TOML.parse(text.replace(/\r\n?/g, "\n")) as { hooks?: { Interrupt?: Array<{ hooks?: Array<{ command?: string }> }> } };
  const matchingCommands = parsed.hooks?.Interrupt?.flatMap(group => group.hooks ?? [])
    .filter(hook => hook.command === installed.command).length ?? 0;
  if (matchingCommands > 1) {
    throw new Error("Codex interrupt lifecycle hook has duplicate commands; refusing to overwrite it");
  }
  const marker = installed.fragment.indexOf(MANAGED_INTERRUPT_HOOK_END);
  if (marker < 0) throw new Error("Codex interrupt lifecycle hook journal fragment is invalid");
  const ownedPrefix = installed.fragment.slice(0, marker);
  // Native config writes normalize CRLF to LF; commands and owned fields must still match exactly.
  const pattern = new RegExp(hookTextPattern(ownedPrefix), "g");
  const match = pattern.exec(text);
  if (!match || pattern.exec(text)) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  const first = match.index;
  const ownedEnd = first + match[0].length;
  if (interruptGroupCount(text.slice(0, first)) !== installed.groupIndex) {
    throw new Error("Codex interrupt lifecycle hook order changed after setup; refusing to overwrite it");
  }
  const endMarker = text.indexOf(MANAGED_INTERRUPT_HOOK_END);
  if (managedMarkerCount(text) !== 1 || endMarker < 0
    || (endMarker >= first && endMarker < ownedEnd)
    || text.split(MANAGED_INTERRUPT_HOOK_END).length !== 2) {
    throw new Error("Codex interrupt lifecycle hook markers changed after setup; refusing to overwrite them");
  }
  if (endMarker < first) {
    // A moved comment is independent of the owned definitions. Prove it is still a comment,
    // rather than matching text inside an unrelated TOML value, before removing it separately.
    const precedingConfig = text.slice(0, first);
    const withoutMarker = precedingConfig.slice(0, endMarker)
      + precedingConfig.slice(endMarker + MANAGED_INTERRUPT_HOOK_END.length);
    try {
      if (JSON.stringify(canonicalJson(Bun.TOML.parse(precedingConfig)))
        !== JSON.stringify(canonicalJson(Bun.TOML.parse(withoutMarker)))) {
        throw new Error("Marker removal changes TOML values");
      }
    } catch {
      throw new Error("Codex interrupt lifecycle hook markers changed after setup; refusing to overwrite them");
    }
  }
  if (codexInterruptHookHash(installed.command) !== installed.trustedHash) {
    throw new Error("Codex interrupt lifecycle hook journal hash is invalid");
  }
  // Codex's TOML editor inserts new tables before trailing comments. The end marker can therefore
  // move past unrelated config even though the owned hook fields remain unchanged.
  const appendedConfig = text.slice(ownedEnd, endMarker < first ? undefined : endMarker);
  const firstAssignment = appendedConfig.split(/\r\n|\n|\r/)
    .map(line => line.trim()).find(line => line && !line.startsWith("#"));
  if (firstAssignment && !/^\[\[?.+\]\]?(?:\s*#.*)?$/.test(firstAssignment)) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  if (firstAssignment) {
    // A later table can also extend the owned hook or trust state. Compare those exact
    // definitions with Bun's TOML parser before treating the inserted tables as unrelated.
    const ownedDefinitions = (fragment: string): string => {
      const { hooks } = Bun.TOML.parse(fragment) as {
        hooks: { Interrupt: unknown[]; state: Record<string, unknown> };
      };
      return JSON.stringify(canonicalJson([hooks.Interrupt[0], hooks.state[installed.stateKey]]));
    };
    try {
      if (ownedDefinitions(ownedPrefix) !== ownedDefinitions(ownedPrefix + appendedConfig)) {
        throw new Error("Modified owned definitions");
      }
    } catch {
      throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
    }
  }
  const end = endMarker + MANAGED_INTERRUPT_HOOK_END.length;
  const trailing = installed.fragment.slice(marker + MANAGED_INTERRUPT_HOOK_END.length);
  const trailingLength = new RegExp("^" + hookTextPattern(trailing)).exec(text.slice(end))?.[0].length ?? 0;
  return [{ start: first, end: ownedEnd }, { start: endMarker, end: end + trailingLength }];
}

export function verifyCodexInterruptHook(text: string, installed: InstalledCodexInterruptHook): void {
  locateCodexInterruptHook(text, installed);
}

/** Explicit reinstall only: remove semantically unchanged definitions, preserving all other TOML. */
function restoreSemanticallyVerifiedHook(text: string, installed: InstalledCodexInterruptHook): string {
  const refuse = (detail: string): never => {
    throw new Error(`Codex interrupt lifecycle hook cannot be repaired: ${detail}; compare config.toml with the integration journal before reinstalling`);
  };
  const same = (a: unknown, b: unknown) => JSON.stringify(canonicalJson(a)) === JSON.stringify(canonicalJson(b));
  type HookDocument = { hooks?: { Interrupt?: Array<{ hooks?: Array<{ command?: string }> }>; state?: Record<string, unknown> } };
  const expected = Bun.TOML.parse(installed.fragment) as HookDocument;
  const actual = Bun.TOML.parse(text) as HookDocument;
  if (codexInterruptHookHash(installed.command) !== installed.trustedHash
    || expected.hooks?.Interrupt?.length !== 1
    || !same(expected.hooks.Interrupt[0], { hooks: [{ type: "command", command: installed.command, timeout: 3 }] })
    || !installed.stateKey.endsWith(`:interrupt:${installed.groupIndex}:0`)
    || !same(expected.hooks.state?.[installed.stateKey], { trusted_hash: installed.trustedHash })) {
    return refuse("journal identity or trusted hash is invalid");
  }
  const groups = actual.hooks?.Interrupt;
  if (!Array.isArray(groups)) return refuse("managed hook is missing or invalid");
  const candidates = groups.flatMap((group, index) =>
    group.hooks?.some(hook => hook.command === installed.command) ? [index] : []);
  if (candidates.length !== 1) return refuse("expected exactly one hook with the installed command");
  const index = candidates[0]!;
  if (!same(groups[index], expected.hooks.Interrupt[0])) return refuse("hook settings changed");
  if (!same(actual.hooks?.state?.[installed.stateKey], expected.hooks.state?.[installed.stateKey])) {
    return refuse("trusted hash or trust settings changed");
  }
  const nextStateKey = installed.stateKey.replace(/:interrupt:\d+:0$/, `:interrupt:${groups.length - 1}:0`);
  if (nextStateKey !== installed.stateKey && Object.hasOwn(actual.hooks?.state ?? {}, nextStateKey)) {
    return refuse("the new hook position already has unrelated trust settings");
  }

  // Locate conservative table spans, then prove the complete parsed document lost only our fields.
  // Unusual TOML layouts fail closed if they cannot be removed without touching other definitions.
  const headers = [...text.matchAll(/^[ \t]*(\[.+\])[ \t]*(?:#.*)?\r?$/gm)];
  const ranges: Array<{ start: number; end: number }> = [];
  let groupIndex = -1;
  let inGroup = false;
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i]!;
    const name = header[1]!;
    if (/^\[\[hooks\.Interrupt\]\]$/.test(name)) {
      groupIndex++;
      inGroup = groupIndex === index;
    } else if (!/^\[\[?hooks\.Interrupt\./.test(name)) {
      inGroup = false;
    }
    let ownedState = false;
    if (name.startsWith("[hooks.state.")) {
      try {
        const table = Bun.TOML.parse(name) as HookDocument;
        ownedState = Object.hasOwn(table.hooks?.state ?? {}, installed.stateKey);
      } catch { /* The final semantic comparison rejects unsupported table layouts. */ }
    }
    if (inGroup || ownedState) ranges.push({ start: header.index!, end: headers[i + 1]?.index ?? text.length });
  }
  let result = text;
  for (const range of ranges.reverse()) result = result.slice(0, range.start) + result.slice(range.end);
  const markers = installed.fragment.split(/\r\n|\n|\r/).filter(line => /^# (Managed by .+: release the exact Responses request|End .+ interrupt lifecycle hook\.)/.test(line));
  for (const marker of markers) {
    result = result.replace(new RegExp(`^[ \\t]*${hookTextPattern(marker)}[ \\t]*(?:\\r?\\n|$)`, "gm"), "");
  }
  groups.splice(index, 1);
  delete actual.hooks!.state![installed.stateKey];
  const normalize = (doc: HookDocument) => {
    if (doc.hooks?.Interrupt?.length === 0) delete doc.hooks.Interrupt;
    if (doc.hooks?.state && Object.keys(doc.hooks.state).length === 0) delete doc.hooks.state;
    if (doc.hooks && Object.keys(doc.hooks).length === 0) delete doc.hooks;
    return doc;
  };
  if (!same(normalize(actual), normalize(Bun.TOML.parse(result) as HookDocument))) {
    return refuse("table layout cannot be safely repaired without changing unrelated settings");
  }
  return result;
}

export function restoreCodexInterruptHook(
  text: string,
  installed: InstalledCodexInterruptHook,
  options: { allowAbsent?: boolean; repairUnchanged?: boolean } = {},
): string {
  // Explicit Setup can reinstall a fully removed hook. A stale journal alone does not mean
  // there is still a definition to remove; partial edits must retain the strict checks below.
  if (options.allowAbsent && managedMarkerCount(text) === 0 && !text.includes(MANAGED_INTERRUPT_HOOK_END)) {
    const { hooks } = Bun.TOML.parse(text) as { hooks?: unknown };
    if (hooks === undefined) return text;
    if (hooks && typeof hooks === "object" && !Array.isArray(hooks) && !Object.hasOwn(hooks, "Interrupt")) {
      const state = (hooks as Record<string, unknown>).state;
      if (state === undefined || (state && typeof state === "object" && !Array.isArray(state)
        && !Object.hasOwn(state, installed.stateKey))) return text;
    }
  }
  let owned: Array<{ start: number; end: number }>;
  try {
    owned = locateCodexInterruptHook(text, installed).sort((left, right) => right.start - left.start);
  } catch (error) {
    if (!options.repairUnchanged) throw error;
    return restoreSemanticallyVerifiedHook(text, installed);
  }
  for (const range of owned) text = text.slice(0, range.start) + text.slice(range.end);
  return text;
}

export function verifyCodexInterruptHookRestored(text: string): void {
  if (managedMarkerCount(text) !== 0 || text.includes(MANAGED_INTERRUPT_HOOK_END)) {
    throw new Error("Codex interrupt lifecycle hook is present while the bridge is disconnected");
  }
}
