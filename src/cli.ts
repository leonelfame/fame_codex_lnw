#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { existsSync, rmSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { checkBrowserEngine, loginToChatGpt } from "./browser-login";
import { getConfigDir, getConfigPath, loadConfig } from "./config";
import { uninstallCodexIntegration } from "./codex-integration";
import { formatDoctorReport, runDoctor } from "./doctor";
import { runChatGptMcpMain } from "./adapters/chatgpt-web/mcp-main";
import { runCommand } from "./process";
import { startServer } from "./server";
import { assertServiceIdle, getServiceStatus, installService, restartService, startService, stopService, uninstallService } from "./service";
import { setup, type SetupOptions } from "./setup";
import { connectTunnel, installRuntimeKeyBytes, managedRuntimeKeyPath, stopTunnel, tunnelStatus } from "./tunnel";
import { VERSION } from "./version";

const HELP = `codex-chatgpt-web ${VERSION}

Focused ChatGPT web-backed models for the native Codex harness.

Usage:
  codex-chatgpt-web setup --pro-only [options]
  codex-chatgpt-web setup --full --tunnel-id ID --runtime-key-file PATH [options]
  codex-chatgpt-web login
  codex-chatgpt-web doctor [--json]
  codex-chatgpt-web browser check
  codex-chatgpt-web serve
  codex-chatgpt-web mcp [--broker-socket PATH]
  codex-chatgpt-web service <status|install|start|restart|stop>
  codex-chatgpt-web tunnel <status|start|stop|key-import>
  codex-chatgpt-web open <tunnels|runtime-keys|connectors>
  codex-chatgpt-web uninstall --yes

Setup options:
  --pro-only                   Pro model, full context/images, no local tools or tunnel
  --full                       Standard tool-capable model plus Pro
  --port NUMBER                Loopback Responses port (default: 17841)
  --chrome PATH                Google Chrome executable
  --app-name NAME              ChatGPT connector name (default: Codex Native)
  --tunnel-id ID               Existing OpenAI tunnel id (full mode)
  --runtime-key-file PATH      File containing a Tunnels Read+Use runtime key
  --replace-codex-route        Reversibly replace an existing openai_base_url
  --source-catalog PATH        Native Codex catalog to use instead of the current routed catalog
  --restart-service            Explicitly restart this project's daemon after an update
  --login                      Refresh the stored ChatGPT login even if one exists
  --auto-approve-tool-calls    Opt in to per-call browser clicks on "Allow once" prompts
  --acknowledge-unofficial     Accept the one-time unofficial-browser-automation notice

Global:
  --home PATH                  Override ~/.codex-chatgpt-web
  -h, --help
  -v, --version
`;

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

async function confirm(question: string): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await reader.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    reader.close();
  }
}

async function prompt(question: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) return "";
  const reader = createInterface({ input: stdin, output: stdout });
  try { return (await reader.question(question)).trim(); }
  finally { reader.close(); }
}

async function secretPrompt(question: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) return "";
  stdout.write(question);
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const reader = createInterface({ input: stdin, output: muted, terminal: true });
  try { return (await reader.question("")).trim(); }
  finally {
    reader.close();
    stdout.write("\n");
  }
}

function assertNoArgs(args: string[]): void {
  if (args.length > 0) throw new Error(`Unknown arguments: ${args.join(" ")}`);
}

async function setupCommand(args: string[]): Promise<void> {
  const proOnly = takeFlag(args, "--pro-only");
  const full = takeFlag(args, "--full");
  if (proOnly === full) throw new Error("Choose exactly one setup mode: --pro-only or --full");
  const portRaw = takeOption(args, "--port");
  let acknowledged = takeFlag(args, "--acknowledge-unofficial");
  const options: SetupOptions = {
    mode: full ? "full" : "pro-only",
    ...(portRaw ? { port: Number(portRaw) } : {}),
  };
  const appName = takeOption(args, "--app-name");
  const tunnelId = takeOption(args, "--tunnel-id");
  const runtimeKeyFile = takeOption(args, "--runtime-key-file");
  const sourceCatalogPath = takeOption(args, "--source-catalog");
  const chrome = takeOption(args, "--chrome");
  if (chrome) options.chromeExecutablePath = chrome;
  if (appName) options.appName = appName;
  if (tunnelId) options.tunnelId = tunnelId;
  if (runtimeKeyFile) options.runtimeKeyFile = runtimeKeyFile;
  if (sourceCatalogPath) options.sourceCatalogPath = sourceCatalogPath;
  options.forceLogin = takeFlag(args, "--login");
  options.autoApproveToolCalls = takeFlag(args, "--auto-approve-tool-calls");
  options.replaceCodexRoute = takeFlag(args, "--replace-codex-route");
  options.restartService = takeFlag(args, "--restart-service");
  assertNoArgs(args);

  if (!acknowledged) {
    stdout.write(
      "This is independent, unofficial software. It automates your ChatGPT web session, can break when the UI changes, "
      + "and must not be used to evade usage limits or access controls.\n",
    );
    acknowledged = await confirm("Continue and store this acknowledgement?");
  }
  if (!acknowledged) throw new Error("Setup cancelled: acknowledgement was not provided");
  options.acknowledgedUnofficial = true;

  if (full && (!options.tunnelId || (!options.runtimeKeyFile && !existsSync(managedRuntimeKeyPath()))) && stdin.isTTY) {
    stdout.write("Full mode needs an OpenAI tunnel and a runtime key with Tunnels Read + Use.\n");
    stdout.write("Tunnels: https://platform.openai.com/settings/organization/tunnels\n");
    stdout.write("Runtime keys: https://platform.openai.com/settings/organization/api-keys\n");
    if (!options.tunnelId) options.tunnelId = await prompt("Tunnel id: ");
    if (!options.runtimeKeyFile && !existsSync(managedRuntimeKeyPath())) {
      options.runtimeKeyValue = await secretPrompt("Runtime key (hidden): ");
    }
  }

  const result = await setup(options);
  stdout.write(`Setup complete: ${result.mode}\n`);
  stdout.write(`Config: ${result.configPath}\n`);
  if (result.connectorSetupRequired) {
    stdout.write("One account-level step remains: attach the tunnel to the ChatGPT connector named in config.\n");
    stdout.write("Open: https://chatgpt.com/#settings/Connectors\n");
  }
  stdout.write("Restart the Codex app once so the generated model catalog appears in the native picker.\n");
}

async function doctorCommand(args: string[]): Promise<void> {
  const json = takeFlag(args, "--json");
  assertNoArgs(args);
  const report = await runDoctor();
  stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorReport(report));
  if (!report.ok) process.exitCode = 1;
}

async function serviceCommand(args: string[]): Promise<void> {
  const action = args.shift() ?? "status";
  assertNoArgs(args);
  const config = action === "status" ? undefined : loadConfig();
  const status = action === "status" ? getServiceStatus()
    : action === "install" ? installService(config!)
      : action === "start" ? startService()
        : action === "restart" ? await restartService(config!)
          : action === "stop" ? await stopService(config!)
            : undefined;
  if (!status) throw new Error(`Unknown service action: ${action}`);
  stdout.write(`${JSON.stringify(status, null, 2)}\n`);
}

async function tunnelCommand(args: string[]): Promise<void> {
  const action = args.shift() ?? "status";
  assertNoArgs(args);
  if (action === "key-import") {
    const key = await secretPrompt("Runtime key (hidden): ");
    if (!key) throw new Error("A non-empty runtime key is required");
    installRuntimeKeyBytes(key);
    stdout.write(`Runtime key stored privately at ${managedRuntimeKeyPath()}\n`);
    return;
  }
  const config = loadConfig();
  if (action === "start") connectTunnel(config);
  else if (action === "stop") stopTunnel(config);
  else if (action !== "status") throw new Error(`Unknown tunnel action: ${action}`);
  const status = tunnelStatus(config);
  stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  if (action !== "stop" && !status.ok) process.exitCode = 1;
}

async function openCommand(args: string[]): Promise<void> {
  const target = args.shift();
  assertNoArgs(args);
  const urls: Record<string, string> = {
    tunnels: "https://platform.openai.com/settings/organization/tunnels",
    "runtime-keys": "https://platform.openai.com/settings/organization/api-keys",
    connectors: "https://chatgpt.com/#settings/Connectors",
  };
  const url = target ? urls[target] : undefined;
  if (!url) throw new Error("Choose one of: tunnels, runtime-keys, connectors");
  if (process.platform === "darwin") {
    const result = runCommand("open", [url]);
    if (result.status !== 0) throw new Error(result.stderr.trim() || `Could not open ${url}`);
  } else {
    stdout.write(`${url}\n`);
  }
}

async function uninstallCommand(args: string[]): Promise<void> {
  const yes = takeFlag(args, "--yes");
  const keepData = takeFlag(args, "--keep-data");
  assertNoArgs(args);
  if (!yes && !await confirm("Restore Codex config, stop services, and remove this installation?")) {
    throw new Error("Uninstall cancelled");
  }
  const config = existsSync(getConfigPath()) ? loadConfig() : undefined;
  if (!config && process.platform === "darwin" && getServiceStatus().installed) {
    throw new Error("Service exists but configuration is missing; refusing an unverifiable uninstall");
  }
  if (config && process.platform === "darwin") await assertServiceIdle(config);
  uninstallCodexIntegration();
  if (config?.mode === "full") stopTunnel(config);
  if (config && process.platform === "darwin") await uninstallService(config);
  if (!keepData) rmSync(getConfigDir(), { recursive: true, force: true });
  stdout.write(keepData ? "Uninstalled; private application data was preserved.\n" : "Uninstalled and removed private application data.\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const home = takeOption(args, "--home");
  if (home) process.env.CODEX_CHATGPT_WEB_HOME = home;
  if (takeFlag(args, "--help") || takeFlag(args, "-h")) {
    stdout.write(HELP);
    return;
  }
  if (takeFlag(args, "--version") || takeFlag(args, "-v")) {
    stdout.write(`${VERSION}\n`);
    return;
  }
  const command = args.shift() ?? "help";
  if (command === "help") stdout.write(HELP);
  else if (command === "setup") await setupCommand(args);
  else if (command === "login") {
    assertNoArgs(args);
    const result = await loginToChatGpt(loadConfig());
    stdout.write(`ChatGPT login stored at ${result.storageStatePath}\n`);
  } else if (command === "doctor" || command === "status") await doctorCommand(args);
  else if (command === "browser") {
    const action = args.shift();
    assertNoArgs(args);
    if (action !== "check") throw new Error("Browser command must be: browser check");
    await checkBrowserEngine(loadConfig());
    stdout.write("Playwright can launch the configured Chrome executable.\n");
  } else if (command === "serve") {
    assertNoArgs(args);
    const config = loadConfig();
    const server = startServer(config);
    stdout.write(`codex-chatgpt-web ${VERSION} listening on http://${config.host}:${server.port}/v1 (${config.mode})\n`);
    await new Promise<void>(() => {});
  } else if (command === "mcp") await runChatGptMcpMain(args);
  else if (command === "service") await serviceCommand(args);
  else if (command === "tunnel") await tunnelCommand(args);
  else if (command === "open") await openCommand(args);
  else if (command === "uninstall") await uninstallCommand(args);
  else throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}

main().catch(error => {
  process.stderr.write(`codex-chatgpt-web: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
