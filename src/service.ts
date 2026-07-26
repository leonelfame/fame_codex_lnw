import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { AppConfig } from "./config";
import { atomicWriteFile, getConfigDir } from "./config";
import { runCommand, runChecked } from "./process";

const LABEL = "io.github.codex-chatgpt-web.daemon";

export interface ServiceStatus {
  supported: boolean;
  installed: boolean;
  loaded: boolean;
  label: string;
  definitionPath?: string;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function launchDomain(): string {
  return `gui/${userInfo().uid}`;
}

function serviceTarget(): string {
  return `${launchDomain()}/${LABEL}`;
}

function plist(config: AppConfig): string {
  const logDir = join(getConfigDir(), "logs");
  const args = [...config.runtimeCommand, "serve"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(arg => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_CHATGPT_WEB_HOME</key>
    <string>${xml(getConfigDir())}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(join(logDir, "daemon.stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logDir, "daemon.stderr.log"))}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

function assertMacOs(): void {
  if (process.platform !== "darwin") {
    throw new Error("Version 0.1 supports managed background services on macOS only; run `codex-chatgpt-web serve` manually on this platform.");
  }
}

export function getServiceStatus(): ServiceStatus {
  if (process.platform !== "darwin") return { supported: false, installed: false, loaded: false, label: LABEL };
  const path = plistPath();
  const result = runCommand("launchctl", ["print", serviceTarget()]);
  return {
    supported: true,
    installed: existsSync(path),
    loaded: result.status === 0,
    label: LABEL,
    definitionPath: path,
  };
}

export function installService(config: AppConfig): ServiceStatus {
  assertMacOs();
  const path = plistPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  mkdirSync(join(getConfigDir(), "logs"), { recursive: true, mode: 0o700 });
  const next = plist(config);
  if (!existsSync(path) || readFileSync(path, "utf8") !== next) atomicWriteFile(path, next);
  const status = getServiceStatus();
  if (!status.loaded) runChecked("launchctl", ["bootstrap", launchDomain(), path]);
  return getServiceStatus();
}

export function startService(): ServiceStatus {
  assertMacOs();
  const path = plistPath();
  if (!existsSync(path)) throw new Error(`Service is not installed: ${path}`);
  const status = getServiceStatus();
  if (!status.loaded) runChecked("launchctl", ["bootstrap", launchDomain(), path]);
  return getServiceStatus();
}

interface DrainLease {
  release: () => Promise<void>;
}

async function control(config: AppConfig, action: "drain" | "resume"): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(`http://${config.host}:${config.port}/admin/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json() as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

async function acquireDrain(config: AppConfig): Promise<DrainLease> {
  if (!getServiceStatus().loaded) return { release: async () => {} };
  let drained = false;
  try {
    const health = await control(config, "drain");
    drained = true;
    const activeHttp = health.active_http_turns;
    const activeBrowser = health.active_browser_turns;
    if (!Number.isInteger(activeHttp) || !Number.isInteger(activeBrowser) || health.accepting_turns !== false) {
      throw new Error("daemon did not acknowledge the drain contract");
    }
    if ((activeHttp as number) > 0 || (activeBrowser as number) > 0) {
      throw new Error(`daemon has ${activeHttp} active HTTP turn(s) and ${activeBrowser} active browser turn(s)`);
    }
    return { release: async () => { if (drained) { await control(config, "resume"); drained = false; } } };
  } catch (error) {
    if (drained) await control(config, "resume").catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Refusing to stop or restart because atomic idleness could not be proven: ${message}`);
  }
}

export async function assertServiceIdle(config: AppConfig): Promise<void> {
  const lease = await acquireDrain(config);
  await lease.release();
}

export async function restartService(config: AppConfig): Promise<ServiceStatus> {
  assertMacOs();
  if (!getServiceStatus().loaded) return startService();
  const lease = await acquireDrain(config);
  try {
    runChecked("launchctl", ["kickstart", "-k", serviceTarget()]);
  } catch (error) {
    await lease.release().catch(() => {});
    throw error;
  }
  return getServiceStatus();
}

export async function stopService(config: AppConfig): Promise<ServiceStatus> {
  assertMacOs();
  if (getServiceStatus().loaded) {
    const lease = await acquireDrain(config);
    try {
      runChecked("launchctl", ["bootout", serviceTarget()]);
    } catch (error) {
      await lease.release().catch(() => {});
      throw error;
    }
  }
  return getServiceStatus();
}

export async function uninstallService(config: AppConfig): Promise<ServiceStatus> {
  assertMacOs();
  if (getServiceStatus().loaded) {
    const lease = await acquireDrain(config);
    try {
      runChecked("launchctl", ["bootout", serviceTarget()]);
    } catch (error) {
      await lease.release().catch(() => {});
      throw error;
    }
  }
  rmSync(plistPath(), { force: true });
  return getServiceStatus();
}
