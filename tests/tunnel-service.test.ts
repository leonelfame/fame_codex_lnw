import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { buildWindowsMcpLauncher, createTunnelConfig, mcpCommand } from "../src/tunnel";
import { tunnelServiceDefinition } from "../src/tunnel-service";
import { existingFullSetupCredentials, tunnelWorkerRuntimeChanged } from "../src/setup";

const roots: string[] = [];

afterEach(() => {
  delete process.env.CODEX_CHATGPT_WEB_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("tunnel launchd ownership", () => {
  test("runs the pinned client directly and asks launchd to restore it", () => {
    const root = join(tmpdir(), `codex-chatgpt-web-tunnel-service-${process.pid}-${Date.now()}`);
    roots.push(root);
    process.env.CODEX_CHATGPT_WEB_HOME = root;
    const binary = join(root, "bin", "tunnel-client");
    const key = join(root, "secrets", "runtime.key");
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "secrets"), { recursive: true });
    writeFileSync(binary, "binary");
    writeFileSync(key, "secret");
    const config = defaultConfig("full");
    config.tunnel = createTunnelConfig({
      binaryPath: binary,
      runtimeKeyFile: key,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    });

    const definition = tunnelServiceDefinition(config);
    expect(definition).toContain("<string>run</string>");
    expect(definition).toContain(`<string>${config.tunnel.profileDir}</string>`);
    expect(definition).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(definition).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(definition).not.toContain("tmux");
    expect(definition).not.toContain("/bin/sh");
    expect(definition).not.toContain(config.tunnel.tunnelId);
    expect(definition).not.toContain(key);
  });

  test("restarts the long-lived MCP worker when the installed release changes", () => {
    const root = join(tmpdir(), `codex-chatgpt-web-tunnel-runtime-${process.pid}-${Date.now()}`);
    roots.push(root);
    process.env.CODEX_CHATGPT_WEB_HOME = root;
    const runtime = join(root, "bin", "codex-chatgpt-web");
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(runtime, "runtime");
    const before = defaultConfig("browser-only");
    before.mode = "full";
    before.releaseVersion = "0.1.3";
    before.runtimeCommand = [runtime];
    const after = structuredClone(before);
    after.releaseVersion = "0.1.9";

    expect(tunnelWorkerRuntimeChanged(before, after)).toBe(true);
    after.releaseVersion = before.releaseVersion;
    expect(tunnelWorkerRuntimeChanged(before, after)).toBe(false);
  });

  test("reuses complete full-mode tunnel credentials during setup updates", () => {
    const root = join(tmpdir(), `codex-chatgpt-web-existing-tunnel-${process.pid}-${Date.now()}`);
    roots.push(root);
    process.env.CODEX_CHATGPT_WEB_HOME = root;
    const key = join(root, "secrets", "runtime.key");
    mkdirSync(join(root, "secrets"), { recursive: true });
    writeFileSync(key, "secret");
    const config = defaultConfig("full");
    config.tunnel = createTunnelConfig({
      binaryPath: process.execPath,
      runtimeKeyFile: key,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    });

    expect(existingFullSetupCredentials(config)).toEqual({ tunnelId: true, runtimeKey: true });
    rmSync(key);
    expect(existingFullSetupCredentials(config)).toEqual({ tunnelId: true, runtimeKey: false });
    expect(existingFullSetupCredentials(defaultConfig("browser-only"))).toEqual({ tunnelId: false, runtimeKey: false });
  });

  test("writes a shell-independent Windows MCP launcher for named-pipe transport", () => {
    const root = join(tmpdir(), `codex-chatgpt-web-windows-mcp-${process.pid}-${Date.now()}`);
    roots.push(root);
    process.env.CODEX_CHATGPT_WEB_HOME = root;
    const runtime = join(root, "Program Files", "runtime", "bun.exe");
    mkdirSync(join(root, "Program Files", "runtime"), { recursive: true });
    writeFileSync(runtime, "runtime");
    const config = defaultConfig("browser-only");
    config.runtimeCommand = [runtime, join(root, "Program Files", "app", "cli.js")];
    config.brokerSocketPath = "\\\\.\\pipe\\codex-chatgpt-web-test";

    const launcher = buildWindowsMcpLauncher(config);
    expect(launcher).toContain("\r\n");
    expect(launcher).toContain("chcp 65001 >nul");
    expect(launcher).toContain(`"${runtime}"`);
    expect(launcher).toContain('"\\\\.\\pipe\\codex-chatgpt-web-test"');
    expect(launcher).not.toContain("'\"'\"'");

    const command = mcpCommand(config, "win32");
    expect(command).toStartWith("cmd.exe /d /s /c call ");
    expect(command).toContain("mcp-launcher.cmd");
    expect(existsSync(join(root, "bin", "mcp-launcher.cmd"))).toBe(true);
  });
});
