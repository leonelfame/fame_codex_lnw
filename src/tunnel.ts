import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { unzipSync } from "fflate";
import type { AppConfig, TunnelConfig } from "./config";
import { atomicWriteFile, getConfigDir } from "./config";
import { runCommand, runChecked } from "./process";
import { getTunnelServiceStatus } from "./tunnel-service";

const TUNNEL_VERSION = "0.0.10";
const RELEASE_BASE = `https://github.com/openai/tunnel-client/releases/download/v${TUNNEL_VERSION}`;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

interface TunnelInstallManifest {
  version: 1;
  tunnelClientVersion: string;
  asset: string;
  archiveSha256: string;
  binarySha256: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function platformAsset(): string {
  const os = process.platform === "darwin" ? "darwin"
    : process.platform === "linux" ? "linux"
      : process.platform === "win32" ? "windows"
        : undefined;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : undefined;
  if (!os || !arch) throw new Error(`openai/tunnel-client has no pinned build for ${process.platform}/${process.arch}`);
  return `tunnel-client-v${TUNNEL_VERSION}-${os}-${arch}.zip`;
}

async function fetchBytes(url: string, timeoutMs = 120_000): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) throw new Error(`Download exceeds ${MAX_DOWNLOAD_BYTES} bytes: ${url}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error(`Download exceeds ${MAX_DOWNLOAD_BYTES} bytes: ${url}`);
    return bytes;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Download timed out after ${timeoutMs}ms: ${url}`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseExpectedChecksum(text: string, asset: string): string {
  const line = text.split(/\r?\n/).find(candidate => candidate.trim().endsWith(asset));
  const checksum = line?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error(`SHA256SUMS.txt has no valid entry for ${asset}`);
  return checksum;
}

function binaryPath(): string {
  return join(getConfigDir(), "bin", process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client");
}

function manifestPath(): string {
  return join(getConfigDir(), "bin", "tunnel-client-manifest.json");
}

export async function installTunnelClient(): Promise<string> {
  const executable = binaryPath();
  const manifestFile = manifestPath();
  if (existsSync(executable) && existsSync(manifestFile)) {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Partial<TunnelInstallManifest>;
    const actual = sha256(readFileSync(executable));
    if (manifest.version === 1 && manifest.tunnelClientVersion === TUNNEL_VERSION && manifest.binarySha256 === actual) {
      if (process.platform !== "win32" && (statSync(executable).mode & 0o111) === 0) {
        throw new Error(`Existing tunnel-client is not executable: ${executable}`);
      }
      const version = runChecked(executable, ["--version"], { timeout: 10_000 });
      if (!version.stdout.includes(TUNNEL_VERSION) && !version.stderr.includes(TUNNEL_VERSION)) {
        throw new Error(`Existing tunnel-client did not report version ${TUNNEL_VERSION}`);
      }
      return executable;
    }
    throw new Error(`Existing tunnel-client failed integrity validation: ${executable}`);
  }
  if (existsSync(executable) || existsSync(manifestFile)) {
    rmSync(executable, { force: true });
    rmSync(manifestFile, { force: true });
  }

  const asset = platformAsset();
  const [archive, sums] = await Promise.all([
    fetchBytes(`${RELEASE_BASE}/${asset}`),
    fetchBytes(`${RELEASE_BASE}/SHA256SUMS.txt`),
  ]);
  const expected = parseExpectedChecksum(new TextDecoder().decode(sums), asset);
  const archiveHash = sha256(archive);
  if (archiveHash !== expected) throw new Error(`Checksum mismatch for ${asset}`);
  const files = unzipSync(archive);
  const expectedName = process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client";
  const entry = Object.entries(files).find(([name]) => basename(name) === expectedName);
  if (!entry) throw new Error(`${asset} does not contain ${expectedName}`);
  const binary = entry[1];
  mkdirSync(dirname(executable), { recursive: true, mode: 0o700 });
  atomicWriteFile(executable, binary);
  if (process.platform !== "win32") chmodSync(executable, 0o700);
  let version: ReturnType<typeof runChecked>;
  try {
    version = runChecked(executable, ["--version"], { timeout: 10_000 });
  } catch (error) {
    rmSync(executable, { force: true });
    throw error;
  }
  if (!version.stdout.includes(TUNNEL_VERSION) && !version.stderr.includes(TUNNEL_VERSION)) {
    rmSync(executable, { force: true });
    throw new Error(`Installed tunnel-client did not report version ${TUNNEL_VERSION}`);
  }
  const manifest: TunnelInstallManifest = {
    version: 1,
    tunnelClientVersion: TUNNEL_VERSION,
    asset,
    archiveSha256: archiveHash,
    binarySha256: sha256(binary),
  };
  atomicWriteFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return executable;
}

export function installRuntimeKey(sourcePath: string): string {
  if (!existsSync(sourcePath)) throw new Error(`Tunnel runtime key file does not exist: ${sourcePath}`);
  const key = readFileSync(sourcePath);
  if (key.byteLength === 0 || key.byteLength > 64 * 1024) throw new Error("Tunnel runtime key file is empty or unexpectedly large");
  return installRuntimeKeyBytes(key);
}

export function managedRuntimeKeyPath(): string {
  return join(getConfigDir(), "secrets", "tunnel-runtime.key");
}

export function installRuntimeKeyBytes(key: Uint8Array | string): string {
  const bytes = typeof key === "string" ? new TextEncoder().encode(key.trim()) : key;
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) throw new Error("Tunnel runtime key is empty or unexpectedly large");
  const destination = managedRuntimeKeyPath();
  atomicWriteFile(destination, bytes);
  return destination;
}

export function createTunnelConfig(options: {
  binaryPath: string;
  tunnelId: string;
  runtimeKeyFile: string;
  profileName?: string;
  alias?: string;
}): TunnelConfig {
  if (!/^tunnel_[a-f0-9]{32}$/.test(options.tunnelId)) throw new Error("--tunnel-id must be tunnel_ followed by 32 lowercase hexadecimal characters");
  const profileName = options.profileName ?? "codex-chatgpt-web";
  const alias = options.alias ?? "codex-chatgpt-web";
  if (!/^[A-Za-z0-9._-]+$/.test(profileName) || !/^[A-Za-z0-9._-]+$/.test(alias)) {
    throw new Error("Tunnel profile and alias may contain only letters, digits, dot, underscore, and dash");
  }
  return {
    binaryPath: options.binaryPath,
    tunnelId: options.tunnelId,
    runtimeKeyFile: options.runtimeKeyFile,
    profileDir: join(getConfigDir(), "tunnel", "profiles"),
    profileName,
    alias,
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function windowsBatchQuoted(value: string): string {
  if (/["\r\n]/.test(value)) throw new Error("Windows MCP launcher values must not contain quotes or newlines");
  return `"${value.replaceAll("%", "%%")}"`;
}

export function buildWindowsMcpLauncher(config: AppConfig): string {
  const command = [...config.runtimeCommand, "mcp", "--broker-socket", config.brokerSocketPath];
  return [
    "@echo off",
    "setlocal",
    "chcp 65001 >nul",
    `set "CODEX_CHATGPT_WEB_HOME=${getConfigDir().replaceAll("%", "%%")}"`,
    command.map(windowsBatchQuoted).join(" "),
    "",
  ].join("\r\n");
}

export function mcpCommand(config: AppConfig, platform = process.platform): string {
  if (platform === "win32") {
    const launcher = join(getConfigDir(), "bin", "mcp-launcher.cmd");
    atomicWriteFile(launcher, buildWindowsMcpLauncher(config));
    return `cmd.exe /d /s /c call ${windowsBatchQuoted(launcher)}`;
  }
  return [...config.runtimeCommand, "mcp", "--broker-socket", config.brokerSocketPath].map(shellQuote).join(" ");
}

function tunnel(config: AppConfig): TunnelConfig {
  if (config.mode !== "full" || !config.tunnel) throw new Error("Tunnel commands require full mode");
  return config.tunnel;
}

export function connectTunnel(config: AppConfig): void {
  const settings = tunnel(config);
  mkdirSync(settings.profileDir, { recursive: true, mode: 0o700 });
  runChecked(settings.binaryPath, [
    "runtimes", "connect",
    "--alias", settings.alias,
    "--profile", settings.profileName,
    "--profile-dir", settings.profileDir,
    "--tunnel-client-bin", settings.binaryPath,
    "--tunnel-id", settings.tunnelId,
    "--runtime-api-key", `file:${settings.runtimeKeyFile}`,
    "--mcp-command", mcpCommand(config),
    "--json",
  ], { timeout: 60_000 });
}

export function stopTunnel(config: AppConfig): void {
  const settings = tunnel(config);
  const result = runCommand(
    settings.binaryPath,
    ["runtimes", "stop", settings.alias, "--json"],
    { timeout: 15_000 },
  );
  if (result.status !== 0 && !/not found|not running|unknown alias/i.test(`${result.stdout}\n${result.stderr}`)) {
    throw new Error(`Failed to stop tunnel runtime: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

export interface TunnelRuntimeStatus {
  ok: boolean;
  processRunning: boolean;
  healthy: boolean;
  ready: boolean;
  state?: string;
  detail: string;
}

function safeTunnelDetail(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text
    .replace(/tunnel_[a-f0-9]{32}/g, "[tunnel-id]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted-key]")
    .slice(0, 2_000);
}

function launcherTunnelProcessRunning(): boolean {
  const path = join(getConfigDir(), "runtime", "launcher-supervisor.json");
  if (!existsSync(path)) return false;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as {
      version?: unknown;
      ownerPid?: unknown;
      tunnelPid?: unknown;
    };
    if (state.version !== 1
      || !Number.isInteger(state.ownerPid)
      || (state.ownerPid as number) <= 0
      || !Number.isInteger(state.tunnelPid)
      || (state.tunnelPid as number) <= 0) return false;
    process.kill(state.ownerPid as number, 0);
    process.kill(state.tunnelPid as number, 0);
    return true;
  } catch {
    return false;
  }
}

export function parseTunnelStatus(output: string, exitStatus = 0): TunnelRuntimeStatus {
  if (exitStatus !== 0) {
    return { ok: false, processRunning: false, healthy: false, ready: false, detail: safeTunnelDetail(output) };
  }
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const processRunning = parsed.process_running === true;
    const healthy = parsed.healthy === true;
    const ready = parsed.ready === true;
    const state = typeof parsed.runtime_state === "string" ? parsed.runtime_state
      : typeof parsed.status === "string" ? parsed.status
        : undefined;
    const issues = parsed.local && typeof parsed.local === "object" && Array.isArray((parsed.local as { issues?: unknown }).issues)
      ? ((parsed.local as { issues: unknown[] }).issues).filter(issue => typeof issue === "string").slice(0, 3)
      : [];
    const explicitError = typeof parsed.error === "string" && parsed.error ? parsed.error : undefined;
    const ok = processRunning && healthy && ready;
    const detail = ok
      ? "process_running=true healthy=true ready=true"
      : safeTunnelDetail([`process_running=${processRunning}`, `healthy=${healthy}`, `ready=${ready}`, ...(state ? [`state=${state}`] : []), ...(explicitError ? [explicitError] : []), ...issues].join("; "));
    return { ok, processRunning, healthy, ready, ...(state ? { state } : {}), detail };
  } catch {
    return { ok: false, processRunning: false, healthy: false, ready: false, detail: `tunnel-client returned non-JSON status: ${safeTunnelDetail(output)}` };
  }
}

export function tunnelStatus(config: AppConfig): TunnelRuntimeStatus {
  const settings = tunnel(config);
  if (!existsSync(settings.binaryPath)) {
    return { ok: false, processRunning: false, healthy: false, ready: false, detail: `Missing ${settings.binaryPath}` };
  }
  const result = runCommand(
    settings.binaryPath,
    ["runtimes", "status", settings.alias, "--json"],
    { timeout: 10_000 },
  );
  let output = (result.stdout || result.stderr).trim();
  const service = getTunnelServiceStatus();
  if (result.status === 0 && (service.running || launcherTunnelProcessRunning())) {
    try {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      parsed.process_running = true;
      if (parsed.healthy === true && parsed.ready === true) parsed.runtime_state = "ready";
      output = JSON.stringify(parsed);
    } catch {
      // parseTunnelStatus owns the diagnostic for malformed output.
    }
  }
  return parseTunnelStatus(output, result.status);
}

export async function waitForTunnelReady(config: AppConfig, timeoutMs = 30_000): Promise<TunnelRuntimeStatus> {
  const deadline = Date.now() + timeoutMs;
  let status = tunnelStatus(config);
  while (!status.ok && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
    status = tunnelStatus(config);
  }
  return status;
}

export function tunnelClientVersion(): string {
  return TUNNEL_VERSION;
}
