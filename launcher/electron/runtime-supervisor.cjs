const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const {
  DETACH_OWNED_CHILD,
  processRunning,
  terminateOwnedProcessTree,
} = require("./process-tree.cjs");
const { runtimeInvocation } = require("./runtime-command.cjs");

const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS_PER_WINDOW = 5;
const MAX_RUNTIME_LOG_LINE_CHARS = 64 * 1024;
const MAX_CONTROL_OUTPUT_BYTES = 1024 * 1024;
const DRAIN_IDLE_TIMEOUT_MS = 15_000;
const DRAIN_POLL_INTERVAL_MS = 100;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function collectLines(stream, onLine) {
  let buffered = "";
  stream.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline).trimEnd();
      buffered = buffered.slice(newline + 1);
      if (line) onLine(line);
    }
    if (buffered.length > MAX_RUNTIME_LOG_LINE_CHARS) {
      onLine(`${buffered.slice(0, MAX_RUNTIME_LOG_LINE_CHARS)}…[truncated]`);
      buffered = "";
    }
  });
  stream.on("end", () => {
    const line = buffered.trim();
    if (line) onLine(line);
  });
}

function readJson(pathname) {
  return JSON.parse(fs.readFileSync(pathname, "utf8"));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function appendFailure(primary, label, failure) {
  return `${primary}; ${label}: ${errorMessage(failure)}`;
}

function absolutePath(value, platform = process.platform) {
  return platform === "win32" ? path.win32.isAbsolute(value) : path.isAbsolute(value);
}

function pathIdentity(value, platform = process.platform) {
  const normalized = platform === "win32" ? path.win32.resolve(value) : path.resolve(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function windowsPipeEndpoint(value) {
  return /^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/.test(value);
}

function validateConfig(config, descriptorPath, platform = process.platform) {
  if (!config || config.version !== 3) throw new Error("Runtime configuration is missing or unsupported");
  if (config.mode !== "browser-only" && config.mode !== "full") {
    throw new Error("Runtime configuration has an invalid mode");
  }
  if (typeof config.releaseVersion !== "string" || !config.releaseVersion.trim()) {
    throw new Error("Runtime configuration has no release version");
  }
  if (config.browserHost !== "launcher") throw new Error("Runtime configuration is not owned by the launcher");
  if (!absolutePath(config.browserHostDescriptorPath || "", platform)
    || pathIdentity(config.browserHostDescriptorPath || "", platform) !== pathIdentity(descriptorPath, platform)) {
    throw new Error("Runtime configuration points to a different launcher browser host");
  }
  if (config.host !== "127.0.0.1"
    || !Number.isInteger(config.port)
    || config.port < 1
    || config.port > 65_535) {
    throw new Error("Runtime configuration has an invalid loopback endpoint");
  }
  if (typeof config.controlToken !== "string" || !/^[A-Za-z0-9_-]{40,}$/.test(config.controlToken)) {
    throw new Error("Runtime configuration has an invalid lifecycle control token");
  }
  if (!Number.isSafeInteger(config.contextWindow) || config.contextWindow <= 0) {
    throw new Error("Runtime configuration has an invalid context window");
  }
  if (typeof config.appName !== "string" || !config.appName.trim() || config.appName.length > 80) {
    throw new Error("Runtime configuration has an invalid connector name");
  }
  for (const key of ["chromeExecutablePath", "storageStatePath", "brokerSocketPath"]) {
    if (typeof config[key] !== "string" || !config[key].trim()) {
      throw new Error(`Runtime configuration is missing ${key}`);
    }
  }
  if (platform === "win32") {
    if (!windowsPipeEndpoint(config.brokerSocketPath)) {
      throw new Error("Runtime configuration has an invalid Windows broker pipe");
    }
  } else if (!absolutePath(config.brokerSocketPath, platform) || windowsPipeEndpoint(config.brokerSocketPath)) {
    throw new Error("Runtime configuration has an invalid Unix broker socket");
  }
  for (const key of ["headed", "proAvailable", "autoApproveToolCalls"]) {
    if (typeof config[key] !== "boolean") {
      throw new Error(`Runtime configuration has an invalid ${key}`);
    }
  }
  if (!Array.isArray(config.runtimeCommand)
    || config.runtimeCommand.length === 0
    || config.runtimeCommand.some(part => typeof part !== "string" || !part.trim())) {
    throw new Error("Runtime configuration has an invalid runtime command");
  }
  if (config.mode === "full") {
    if (!config.tunnel || typeof config.tunnel !== "object") {
      throw new Error("Full mode is missing tunnel configuration");
    }
    for (const key of ["binaryPath", "tunnelId", "runtimeKeyFile", "profileDir", "profileName", "alias"]) {
      if (typeof config.tunnel[key] !== "string" || !config.tunnel[key].trim()) {
        throw new Error(`Full mode is missing tunnel.${key}`);
      }
    }
    if (!/^tunnel_[a-f0-9]{32}$/.test(config.tunnel.tunnelId)) {
      throw new Error("Full mode has an invalid tunnel id");
    }
    for (const key of ["profileName", "alias"]) {
      if (!/^[A-Za-z0-9._-]+$/.test(config.tunnel[key])) {
        throw new Error(`Full mode has an invalid tunnel.${key}`);
      }
    }
    for (const key of ["binaryPath", "runtimeKeyFile", "profileDir"]) {
      if (!absolutePath(config.tunnel[key], platform)) {
        throw new Error(`Full mode requires an absolute tunnel.${key}`);
      }
    }
  }
  return config;
}

class RuntimeSupervisor {
  constructor({
    app,
    logger,
    sourceRoot,
    installedRuntimeRoot,
    runtimeRootProvider,
    coreHome,
    browserDescriptorPath,
    publishOperation,
    runtimeInvocationFactory = runtimeInvocation,
  }) {
    this.app = app;
    this.logger = logger;
    this.sourceRoot = sourceRoot;
    this.installedRuntimeRoot = installedRuntimeRoot;
    this.runtimeRootProvider = runtimeRootProvider;
    this.coreHome = coreHome;
    this.browserDescriptorPath = browserDescriptorPath;
    this.publishOperation = publishOperation;
    this.runtimeInvocationFactory = runtimeInvocationFactory;
    this.configPath = path.join(coreHome, "config.json");
    this.statePath = path.join(coreHome, "runtime", "launcher-supervisor.json");
    this.daemon = null;
    this.tunnel = null;
    this.stopping = false;
    this.startPromise = null;
    this.stopPromise = null;
    this.restartHistory = { daemon: [], tunnel: [] };
    this.restartTimers = { daemon: null, tunnel: null };
    this.recoveryTasks = new Set();
    this.expectedExits = new WeakSet();
    this.restartableChildren = new WeakSet();
    this.lastChildFailure = { daemon: null, tunnel: null };
  }

  readConfig() {
    if (!fs.existsSync(this.configPath)) return null;
    return validateConfig(readJson(this.configPath), this.browserDescriptorPath);
  }

  readSetupConfig() {
    if (!fs.existsSync(this.configPath)) return null;
    const config = readJson(this.configPath);
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("Runtime configuration is not an object");
    }
    const mode = config.mode === "pro-only" ? "browser-only" : config.mode;
    if (mode !== "browser-only" && mode !== "full") {
      throw new Error("Runtime configuration has an invalid setup mode");
    }
    return { ...config, mode };
  }

  readState() {
    if (!fs.existsSync(this.statePath)) return null;
    try {
      const state = readJson(this.statePath);
      const validPid = (value) => value === null || (Number.isInteger(value) && value > 0);
      if (!state
        || state.version !== 1
        || !Number.isInteger(state.ownerPid)
        || state.ownerPid < 1
        || !validPid(state.daemonPid)
        || !validPid(state.tunnelPid)
        || typeof state.status !== "string"
        || typeof state.updatedAt !== "string"
        || Number.isNaN(Date.parse(state.updatedAt))) {
        throw new Error("state shape is invalid");
      }
      return state;
    } catch (error) {
      throw new Error(`Launcher runtime ownership state is invalid at ${this.statePath}: ${errorMessage(error)}`);
    }
  }

  snapshot(status = "idle", detail) {
    return {
      version: 1,
      ownerPid: process.pid,
      daemonPid: this.daemon?.pid ?? null,
      tunnelPid: this.tunnel?.pid ?? null,
      status,
      ...(detail ? { detail } : {}),
      updatedAt: new Date().toISOString(),
    };
  }

  writeState(status, detail) {
    const state = this.snapshot(status, detail);
    writePrivateFileAtomic(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
    return state;
  }

  tryWriteState(status, detail) {
    try {
      this.writeState(status, detail);
      return true;
    } catch (error) {
      const message = `Could not persist launcher runtime ownership: ${errorMessage(error)}`;
      this.stopping = true;
      for (const name of ["daemon", "tunnel"]) {
        if (this.restartTimers[name]) {
          clearTimeout(this.restartTimers[name]);
          this.restartTimers[name] = null;
        }
      }
      this.logger.error("runtime.state_write_failed", { status, message });
      this.publishOperation?.({ name: "runtime-supervisor", status: "failed", message });
      return false;
    }
  }

  clearState() {
    fs.rmSync(this.statePath, { force: true });
  }

  prepareExternalMigration() {
    if (this.daemon || this.tunnel) {
      throw new Error("Launcher-owned runtime children exist while an external installation is configured");
    }
    const state = this.readState();
    if (state && (
      processRunning(state.ownerPid)
      || processRunning(state.daemonPid)
      || processRunning(state.tunnelPid)
    )) {
      throw new Error("Launcher ownership processes are still alive while an external installation is configured");
    }
    this.clearState();
  }

  writeExternalState(detail) {
    const existing = this.readState();
    const preservesLiveOwnership = existing && (
      processRunning(existing.ownerPid)
      || processRunning(existing.daemonPid)
      || processRunning(existing.tunnelPid)
    );
    if (!preservesLiveOwnership) this.writeState("external", detail);
  }

  spawnChild(name, invocation) {
    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      detached: DETACH_OWNED_CHILD,
      env: {
        ...process.env,
        CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: this.browserDescriptorPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this[name] = child;
    this.lastChildFailure[name] = null;
    collectLines(child.stdout, (line) => this.logger.info(`runtime.${name}_stdout`, { line }));
    collectLines(child.stderr, (line) => this.logger.warn(`runtime.${name}_stderr`, { line }));
    let terminalHandled = false;
    const handleTerminal = ({ code = null, signal = null, error = null }) => {
      if (terminalHandled) return;
      terminalHandled = true;
      const expected = this.stopping || this.expectedExits.has(child);
      this.expectedExits.delete(child);
      const restartable = this.restartableChildren.has(child);
      this.restartableChildren.delete(child);
      if (this[name] === child) this[name] = null;
      const detail = error
        ? `${name} failed to start: ${error.message}`
        : `${name} exited (${signal || code})`;
      this.lastChildFailure[name] = detail;
      const statePersisted = this.tryWriteState(expected ? "stopping" : "degraded", detail);
      this.logger[expected ? "info" : "error"](
        error ? `runtime.${name}_spawn_failed` : `runtime.${name}_exited`,
        error ? { message: error.message } : { code, signal },
      );
      if (!expected && restartable && statePersisted) this.scheduleRecovery(name);
    };
    child.once("error", (error) => {
      if (!Number.isInteger(child.pid)) {
        handleTerminal({ error });
        return;
      }
      this.logger.error(`runtime.${name}_process_error`, { message: error.message, pid: child.pid });
    });
    child.once("exit", (code, signal) => handleTerminal({ code, signal }));
    this.logger.info(`runtime.${name}_started`, { pid: child.pid });
    this.writeState("starting");
    return child;
  }

  runtimeCommand(args) {
    if (this.runtimeRootProvider) this.installedRuntimeRoot = this.runtimeRootProvider();
    return this.runtimeInvocationFactory({
      app: this.app,
      sourceRoot: this.sourceRoot,
      installedRuntimeRoot: this.installedRuntimeRoot,
      args,
    });
  }

  tunnelCommand(config) {
    const tunnel = config.tunnel;
    if (!tunnel || !fs.existsSync(tunnel.binaryPath)) {
      throw new Error(`Tunnel client is missing: ${tunnel?.binaryPath || "not configured"}`);
    }
    const profile = path.join(tunnel.profileDir, `${tunnel.profileName}.yaml`);
    if (!fs.existsSync(profile)) throw new Error(`Tunnel profile is missing: ${profile}`);
    return {
      executable: tunnel.binaryPath,
      args: ["run", "--profile-dir", tunnel.profileDir, "--profile", tunnel.profileName],
      cwd: tunnel.profileDir,
    };
  }

  async proxyHealthPayload(config, timeoutMs = 2_000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`http://${config.host}:${config.port}/healthz`, { signal: controller.signal });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async proxyHealth(config, timeoutMs = 2_000, expectedPid, requireAccepting = false) {
    const body = await this.proxyHealthPayload(config, timeoutMs);
    return body?.service === "codex-chatgpt-web"
      && body?.status === "ok"
      && body?.mode === config.mode
      && body?.version === config.releaseVersion
      && (expectedPid === undefined || body?.pid === expectedPid)
      && (!requireAccepting || body?.accepting_turns === true);
  }

  async waitForProxy(config, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const daemon = this.daemon;
      if (!daemon) {
        throw new Error(this.lastChildFailure.daemon || "Responses proxy exited before becoming healthy");
      }
      if (!Number.isInteger(daemon.pid)) {
        await sleep(50);
        continue;
      }
      if (await this.proxyHealth(config, 2_000, daemon.pid, true)) return;
      await sleep(200);
    }
    throw new Error(`Responses proxy did not become healthy on 127.0.0.1:${config.port} within ${timeoutMs}ms`);
  }

  async tunnelHealth(config) {
    const tunnel = config.tunnel;
    const result = await this.runTunnelCommand(
      config,
      ["runtimes", "status", tunnel.alias, "--json"],
      5_000,
      "Tunnel health probe",
    );
    if (result.code !== 0) return false;
    try {
      const parsed = JSON.parse(result.output);
      return parsed.healthy === true && parsed.ready === true;
    } catch {
      return false;
    }
  }

  async waitForTunnel(config, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.tunnel) {
        throw new Error(this.lastChildFailure.tunnel || "Tunnel runtime exited before becoming ready");
      }
      if (await this.tunnelHealth(config)) return;
      await sleep(250);
    }
    throw new Error(`Tunnel runtime did not become healthy and ready within ${timeoutMs}ms`);
  }

  async startTunnel(config) {
    if (config.mode !== "full") return;
    if (this.tunnel) {
      const child = this.tunnel;
      await this.waitForTunnel(config);
      if (this.tunnel !== child) throw new Error("Tunnel runtime exited while readiness was being confirmed");
      this.restartableChildren.add(child);
      return;
    }
    let child;
    try {
      child = this.spawnChild("tunnel", this.tunnelCommand(config));
      await this.waitForTunnel(config);
      if (this.tunnel !== child) throw new Error("Tunnel runtime exited immediately after becoming ready");
      this.restartableChildren.add(child);
    } catch (error) {
      let cleanupError;
      try {
        await this.stopChild("tunnel");
      } catch (caught) {
        cleanupError = caught;
      }
      if (cleanupError) {
        throw new Error(appendFailure(errorMessage(error), "tunnel startup cleanup failed", cleanupError));
      }
      throw error;
    }
  }

  async startDaemon(config) {
    if (this.daemon) {
      const child = this.daemon;
      const identity = Number.isInteger(child.pid)
        && await this.proxyHealth(config, 2_000, child.pid);
      if (identity && !await this.proxyHealth(config, 2_000, child.pid, true)) {
        const resumed = await this.control(config, "resume");
        if (resumed.status !== "ok" || resumed.accepting_turns !== true) {
          throw new Error("Responses proxy did not acknowledge readiness after resume");
        }
      }
      await this.waitForProxy(config);
      if (this.daemon !== child) throw new Error("Responses proxy exited while readiness was being confirmed");
      this.restartableChildren.add(child);
      return;
    }
    let child;
    try {
      child = this.spawnChild("daemon", this.runtimeCommand(["serve"]));
      await this.waitForProxy(config);
      if (this.daemon !== child) throw new Error("Responses proxy exited immediately after becoming healthy");
      this.restartableChildren.add(child);
    } catch (error) {
      let cleanupError;
      try {
        await this.stopChild("daemon");
      } catch (caught) {
        cleanupError = caught;
      }
      if (cleanupError) {
        throw new Error(appendFailure(errorMessage(error), "daemon startup cleanup failed", cleanupError));
      }
      throw error;
    }
  }

  async startIfConfigured() {
    if (this.stopPromise) await this.stopPromise;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startConfigured();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async startConfigured() {
    let config;
    try {
      config = this.readConfig();
    } catch (error) {
      const detail = errorMessage(error);
      this.logger.warn("runtime.setup_required", { detail });
      return { status: "needs-setup", detail };
    }
    if (!config) {
      const ownershipState = this.readState();
      if (ownershipState && (
        processRunning(ownershipState.daemonPid)
        || processRunning(ownershipState.tunnelPid)
      )) {
        const detail = "Runtime configuration is missing while launcher ownership processes are still alive";
        this.logger.warn("runtime.external_owner_detected", { detail });
        return { status: "external", detail };
      }
      this.clearState();
      return { status: "not-configured" };
    }
    if (config.releaseVersion !== this.app.getVersion()) {
      if (await this.proxyHealth(config) || this.readState()) {
        try {
          const recovered = await this.stopStaleOwnedRuntime(config);
          if (!recovered) {
            const detail = "A runtime for another launcher version could not be safely recovered";
            this.writeExternalState(detail);
            this.logger.warn("runtime.external_owner_detected", { port: config.port, detail });
            return { status: "external", detail };
          }
        } catch (error) {
          const detail = errorMessage(error);
          this.writeExternalState(detail);
          this.logger.warn("runtime.external_owner_detected", { port: config.port, detail });
          return { status: "external", detail };
        }
      }
      const detail = `Config requires ${config.releaseVersion}; launcher is ${this.app.getVersion()}`;
      this.writeState("needs-setup", detail);
      this.logger.warn("runtime.setup_required", { detail });
      return { status: "needs-setup", detail };
    }
    if (!this.daemon && !this.tunnel) {
      const healthyRuntime = await this.proxyHealth(config);
      const ownershipState = this.readState();
      if (healthyRuntime || ownershipState) {
        try {
          const recovered = await this.stopStaleOwnedRuntime(config);
          if (!recovered) {
            const detail = healthyRuntime
              ? "An external runtime already owns the configured port"
              : "Existing launcher runtime ownership could not be safely recovered";
            this.writeExternalState(detail);
            this.logger.warn("runtime.external_owner_detected", { port: config.port, detail });
            return { status: "external", detail };
          }
        } catch (error) {
          const detail = errorMessage(error);
          this.writeExternalState(detail);
          this.logger.warn("runtime.external_owner_detected", { port: config.port, detail });
          return { status: "external", detail };
        }
      }
    }

    this.stopping = false;
    this.publishOperation?.({ name: "runtime-start", status: "running", message: "Starting local runtime" });
    try {
      await this.startTunnel(config);
      await this.startDaemon(config);
      this.restartHistory.daemon = [];
      this.restartHistory.tunnel = [];
      this.writeState("ready");
      this.publishOperation?.({ name: "runtime-start", status: "completed", message: "Local runtime is ready" });
      return { status: "ready", daemonPid: this.daemon?.pid, tunnelPid: this.tunnel?.pid };
    } catch (error) {
      this.stopping = true;
      let cleanupError;
      try {
        await this.cleanupFailedStart(config);
      } catch (caught) {
        cleanupError = caught;
      } finally {
        this.stopping = false;
      }
      const primary = errorMessage(error);
      const message = cleanupError
        ? appendFailure(primary, "runtime startup cleanup failed", cleanupError)
        : primary;
      this.tryWriteState("failed", message);
      this.publishOperation?.({ name: "runtime-start", status: "failed", message });
      throw new Error(message);
    }
  }

  recordRestart(name) {
    const cutoff = Date.now() - RESTART_WINDOW_MS;
    const recent = this.restartHistory[name].filter((at) => at >= cutoff);
    recent.push(Date.now());
    this.restartHistory[name] = recent;
    return recent.length;
  }

  scheduleRecovery(name) {
    if (this.stopping) return;
    if (this.restartTimers[name]) return;
    const attempts = this.recordRestart(name);
    if (attempts > MAX_RESTARTS_PER_WINDOW) {
      const message = `${name} stopped more than ${MAX_RESTARTS_PER_WINDOW} times in 60 seconds; automatic restart is disabled`;
      this.tryWriteState("failed", message);
      this.publishOperation?.({ name: "runtime-recovery", status: "failed", message });
      return;
    }
    const delay = Math.min(attempts * 1_000, 5_000);
    this.restartTimers[name] = setTimeout(() => {
      this.restartTimers[name] = null;
      const recovery = this.recover(name).catch((error) => {
        const message = errorMessage(error);
        this.logger.error(`runtime.${name}_recovery_failed`, { message });
        if (this.tryWriteState("failed", message)) this.scheduleRecovery(name);
      });
      this.recoveryTasks.add(recovery);
      void recovery.finally(() => this.recoveryTasks.delete(recovery));
    }, delay);
  }

  async recover(name) {
    if (this.stopping) return;
    const config = this.readConfig();
    if (!config) return;
    this.publishOperation?.({ name: "runtime-recovery", status: "running", message: `Restarting ${name}` });
    if (name === "tunnel") await this.startTunnel(config);
    else await this.startDaemon(config);
    if (!this.daemon) throw new Error("Responses proxy is unavailable after runtime recovery");
    if (config.mode === "full" && !this.tunnel) {
      throw new Error("Tunnel runtime is unavailable after runtime recovery");
    }
    await this.waitForProxy(config);
    if (config.mode === "full") await this.waitForTunnel(config);
    if (!this.tryWriteState("ready")) {
      let cleanupError;
      try {
        await this.cleanupFailedStart(config);
      } catch (caught) {
        cleanupError = caught;
      }
      const message = cleanupError
        ? appendFailure(
            "Recovered runtime could not persist launcher ownership",
            "runtime recovery cleanup failed",
            cleanupError,
          )
        : "Recovered runtime could not persist launcher ownership";
      throw new Error(message);
    }
    this.publishOperation?.({ name: "runtime-recovery", status: "completed", message: `${name} recovered` });
  }

  async cleanupFailedStart(config) {
    if (this.daemon) {
      const child = this.daemon;
      const healthy = Number.isInteger(child.pid) && await this.proxyHealth(config, 2_000, child.pid);
      if (healthy) {
        let drained = false;
        try {
          drained = await this.acquireDrain(config);
          await this.shutdownDaemon(config);
        } catch (error) {
          if (drained) {
            try {
              await this.control(config, "resume");
            } catch (resumeError) {
              throw new Error(appendFailure(errorMessage(error), "daemon resume compensation failed", resumeError));
            }
          }
          throw error;
        }
      } else {
        await this.stopChild("daemon");
      }
    }
    if (this.tunnel) {
      const child = this.tunnel;
      if (this.restartableChildren.has(child)) await this.stopTunnelGracefully(config);
      else await this.stopChild("tunnel");
    }
  }

  async restoreDrainedDaemon(config) {
    const child = this.daemon;
    const childAlive = child
      && child.exitCode === null
      && child.signalCode === null
      && processRunning(child.pid);
    if (childAlive) {
      if (!Number.isInteger(child.pid) || !await this.proxyHealth(config, 2_000, child.pid)) {
        throw new Error("drained daemon is still alive but no longer provides matching health evidence");
      }
      const resumed = await this.control(config, "resume");
      if (resumed.status !== "ok" || resumed.accepting_turns !== true) {
        throw new Error("drained daemon did not acknowledge resume");
      }
      await this.waitForProxy(config);
      return { status: "resumed", pid: child.pid };
    }
    this.daemon = null;
    await this.waitForPortRelease(config);
    await this.startDaemon(config);
    return { status: "restarted", pid: this.daemon?.pid };
  }

  async ownedRuntimeReady(config) {
    const daemon = this.daemon;
    if (!daemon
      || !Number.isInteger(daemon.pid)
      || daemon.exitCode !== null
      || daemon.signalCode !== null
      || !await this.proxyHealth(config, 2_000, daemon.pid, true)) {
      return false;
    }
    if (config.mode !== "full") return true;
    return Boolean(this.tunnel && await this.tunnelHealth(config));
  }

  async control(config, action) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`http://${config.host}:${config.port}/admin/${action}`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.controlToken}` },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async waitForChildExit(name, child, timeoutMs) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timeout);
        child.off("exit", finish);
        child.off("close", finish);
        resolve();
      };
      const timeout = setTimeout(() => {
        child.off("exit", finish);
        child.off("close", finish);
        reject(new Error(`${name} did not stop within ${timeoutMs}ms`));
      }, timeoutMs);
      child.once("exit", finish);
      child.once("close", finish);
    });
  }

  async waitForProcessExit(name, pid, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (processRunning(pid) && Date.now() < deadline) await sleep(50);
    if (processRunning(pid)) throw new Error(`${name} process ${pid} did not stop within ${timeoutMs}ms`);
  }

  async waitForPortRelease(config, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = "port is still occupied";
    while (Date.now() < deadline) {
      try {
        await new Promise((resolve, reject) => {
          const probe = net.createServer();
          probe.unref();
          probe.once("error", reject);
          probe.listen(config.port, config.host, () => {
            probe.close((error) => error ? reject(error) : resolve());
          });
        });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await sleep(100);
      }
    }
    throw new Error(
      `Responses port ${config.host}:${config.port} was not released within ${timeoutMs}ms: ${lastError}`,
    );
  }

  async shutdownDaemon(config, timeoutMs = 10_000) {
    const child = this.daemon;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.daemon = null;
      return;
    }
    const result = await this.control(config, "shutdown");
    if (result.status !== "ok") throw new Error("daemon did not acknowledge graceful shutdown");
    await this.waitForChildExit("daemon", child, timeoutMs);
    await this.waitForPortRelease(config);
    this.daemon = null;
  }

  async stopTunnelGracefully(config, timeoutMs = 10_000) {
    const child = this.tunnel;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.tunnel = null;
      return;
    }
    const tunnel = config.tunnel;
    if (!tunnel) throw new Error("launcher-owned tunnel has no runtime configuration");
    const result = await this.runTunnelStopCommand(config);
    if (result.code !== 0) {
      throw new Error(`tunnel runtime refused graceful shutdown: ${result.output || `exit ${result.code}`}`);
    }
    await this.waitForChildExit("tunnel", child, timeoutMs);
    this.tunnel = null;
  }

  async runTunnelStopCommand(config) {
    const tunnel = config.tunnel;
    if (!tunnel) throw new Error("launcher-owned tunnel has no runtime configuration");
    return await this.runTunnelCommand(
      config,
      ["runtimes", "stop", tunnel.alias, "--json"],
      10_000,
      "Tunnel shutdown",
    );
  }

  async runTunnelCommand(config, args, timeoutMs, label) {
    const tunnel = config.tunnel;
    if (!tunnel) throw new Error("launcher-owned tunnel has no runtime configuration");
    return await new Promise((resolve, reject) => {
      const child = spawn(tunnel.binaryPath, args, {
        cwd: tunnel.profileDir,
        detached: DETACH_OWNED_CHILD,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const capture = (chunks, chunk, stream) => {
        const used = stream === "stdout" ? stdoutBytes : stderrBytes;
        const remaining = MAX_CONTROL_OUTPUT_BYTES - used;
        if (remaining <= 0) return;
        const captured = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        chunks.push(captured);
        if (stream === "stdout") stdoutBytes += captured.length;
        else stderrBytes += captured.length;
      };
      let settled = false;
      let timeoutError = null;
      let terminationTimeout = null;
      let forceTimeout = null;
      const clearTimers = () => {
        clearTimeout(timeout);
        if (terminationTimeout) clearTimeout(terminationTimeout);
        if (forceTimeout) clearTimeout(forceTimeout);
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        timeoutError = new Error(`${label} timed out after ${timeoutMs}ms`);
        try {
          terminateOwnedProcessTree(child);
        } catch (error) {
          settled = true;
          clearTimers();
          reject(new Error(
            `${timeoutError.message}; control process tree termination failed: ${errorMessage(error)}`,
          ));
          return;
        }
        terminationTimeout = setTimeout(() => {
          if (settled) return;
          try {
            terminateOwnedProcessTree(child, "SIGKILL");
          } catch (error) {
            settled = true;
            clearTimers();
            reject(new Error(
              `${timeoutError.message}; forced control process tree termination failed: ${errorMessage(error)}`,
            ));
            return;
          }
          forceTimeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            clearTimers();
            reject(new Error(`${timeoutError.message}; the control process did not exit after forced termination`));
          }, 2_000);
        }, 5_000);
      }, timeoutMs);
      child.stdout.on("data", (chunk) => capture(stdout, chunk, "stdout"));
      child.stderr.on("data", (chunk) => capture(stderr, chunk, "stderr"));
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        reject(timeoutError
          ? new Error(`${timeoutError.message}; termination failed: ${error.message}`)
          : error);
      });
      child.once("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (timeoutError) {
          try {
            terminateOwnedProcessTree(child, "SIGKILL");
            reject(timeoutError);
          } catch (error) {
            reject(new Error(
              `${timeoutError.message}; final control process-group cleanup failed: ${errorMessage(error)}`,
            ));
          }
          return;
        }
        resolve({
          code: code ?? 1,
          output: Buffer.concat(stdout.length ? stdout : stderr).toString("utf8").trim(),
        });
      });
    });
  }

  async stopStaleOwnedRuntime(config) {
    const state = this.readState();
    if (!state) return false;
    if (state.ownerPid === process.pid) {
      if (!processRunning(state.daemonPid) && !processRunning(state.tunnelPid)) {
        this.clearState();
        return true;
      }
      return false;
    }
    const health = await this.proxyHealthPayload(config);
    const daemonRunning = health?.service === "codex-chatgpt-web"
      && health?.mode === config.mode
      && health?.version === config.releaseVersion;
    if (daemonRunning && health.pid !== state.daemonPid) {
      throw new Error("The process on the Responses port does not match the stale launcher marker");
    }
    if (!daemonRunning && processRunning(state.daemonPid)) {
      throw new Error(
        `The stale daemon PID ${state.daemonPid} is still alive but did not provide matching health evidence`,
      );
    }
    const tunnelRunning = processRunning(state.tunnelPid);
    if (!daemonRunning && !tunnelRunning) {
      this.clearState();
      return true;
    }
    if (processRunning(state.ownerPid)) {
      throw new Error(`Another launcher process still owns the runtime (pid ${state.ownerPid})`);
    }

    this.logger.warn("runtime.stale_owner_recovery_started", {
      ownerPid: state.ownerPid,
      daemonPid: daemonRunning ? state.daemonPid : null,
      tunnelPid: tunnelRunning ? state.tunnelPid : null,
    });
    if (daemonRunning) {
      let drained = false;
      try {
        drained = await this.acquireDrain(config);
        const shutdown = await this.control(config, "shutdown");
        if (shutdown.status !== "ok") throw new Error("stale daemon did not acknowledge graceful shutdown");
        await this.waitForProcessExit("stale daemon", state.daemonPid);
        await this.waitForPortRelease(config);
      } catch (error) {
        if (drained) {
          try {
            await this.control(config, "resume");
          } catch (resumeError) {
            throw new Error(appendFailure(errorMessage(error), "stale daemon resume compensation failed", resumeError));
          }
        }
        throw error;
      }
    }
    if (tunnelRunning) {
      const stopped = await this.runTunnelStopCommand(config);
      if (stopped.code !== 0) {
        throw new Error(`stale tunnel refused graceful shutdown: ${stopped.output || `exit ${stopped.code}`}`);
      }
      await this.waitForProcessExit("stale tunnel", state.tunnelPid);
    }
    this.clearState();
    this.logger.info("runtime.stale_owner_recovered");
    return true;
  }

  async acquireDrain(config, timeoutMs = DRAIN_IDLE_TIMEOUT_MS) {
    let attempted = false;
    try {
      attempted = true;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const health = await this.control(config, "drain");
        if (health.accepting_turns !== false
          || !Number.isInteger(health.active_http_turns)
          || !Number.isInteger(health.active_browser_turns)) {
          throw new Error("daemon did not acknowledge the drain contract");
        }
        if (health.active_http_turns === 0 && health.active_browser_turns === 0) return true;
        if (Date.now() >= deadline) {
          throw new Error(
            `daemon has ${health.active_http_turns} active HTTP turn(s) and ${health.active_browser_turns} active browser turn(s)`,
          );
        }
        await sleep(Math.min(DRAIN_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
      }
    } catch (error) {
      let resumeError;
      if (attempted) {
        try {
          await this.control(config, "resume");
        } catch (caught) {
          resumeError = caught;
        }
      }
      const message = resumeError
        ? appendFailure(errorMessage(error), "compensating resume failed", resumeError)
        : errorMessage(error);
      throw new Error(`Refusing to stop launcher-owned runtime because atomic idleness could not be proven: ${message}`);
    }
  }

  async stopChild(name, timeoutMs = 10_000) {
    const child = this[name];
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this[name] = null;
      return;
    }
    this.expectedExits.add(child);
    try {
      terminateOwnedProcessTree(child);
    } catch (error) {
      this.expectedExits.delete(child);
      if (!processRunning(child.pid)) {
        this[name] = null;
        return;
      }
      throw new Error(`Could not request ${name} process-tree shutdown: ${errorMessage(error)}`);
    }
    try {
      await this.waitForChildExit(name, child, timeoutMs);
    } catch (gracefulError) {
      try {
        terminateOwnedProcessTree(child, "SIGKILL");
        await this.waitForChildExit(name, child, 2_000);
      } catch (forceError) {
        throw new Error(appendFailure(
          errorMessage(gracefulError),
          `forced ${name} process-tree shutdown failed`,
          forceError,
        ));
      }
      this.logger.warn(`runtime.${name}_forced_stop`, { message: errorMessage(gracefulError) });
    }
    terminateOwnedProcessTree(child, "SIGKILL");
    this[name] = null;
  }

  async stopForSetup() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.performStopForSetup();
    try {
      return await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  async performStopForSetup() {
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch (error) {
        this.logger.warn("runtime.start_failed_before_stop", { message: errorMessage(error) });
      }
    }
    const config = this.readConfig();
    this.stopping = true;
    for (const name of ["daemon", "tunnel"]) {
      if (this.restartTimers[name]) {
        clearTimeout(this.restartTimers[name]);
        this.restartTimers[name] = null;
      }
    }
    if (this.recoveryTasks.size > 0) {
      await Promise.allSettled([...this.recoveryTasks]);
    }
    let drained = false;
    let tunnelStopped = false;
    try {
      if (!this.daemon && !this.tunnel) {
        if (!config) {
          const ownershipState = this.readState();
          if (ownershipState && (
            processRunning(ownershipState.daemonPid)
            || processRunning(ownershipState.tunnelPid)
          )) {
            throw new Error("runtime configuration is missing while launcher ownership processes are still alive");
          }
        } else if (await this.proxyHealth(config) || this.readState()) {
          const recovered = await this.stopStaleOwnedRuntime(config);
          if (!recovered) {
            throw new Error("an existing runtime could not be safely recovered");
          }
        }
        this.clearState();
        return { status: "stopped" };
      }
      if (this.daemon && config) {
        const daemonPid = this.daemon.pid;
        if (!Number.isInteger(daemonPid)
          || !await this.proxyHealth(config, 2_000, daemonPid)) {
          throw new Error("launcher-owned daemon did not provide matching health evidence");
        }
        drained = await this.acquireDrain(config);
      }
      if (this.tunnel) {
        if (!config) throw new Error("launcher-owned tunnel cannot be stopped without a valid configuration");
        await this.stopTunnelGracefully(config);
        tunnelStopped = true;
      }
      if (this.daemon) {
        if (!config || !drained) {
          throw new Error("launcher-owned daemon cannot be stopped without a verified idle drain");
        }
        await this.shutdownDaemon(config);
      }
      this.clearState();
      return { status: "stopped" };
    } catch (error) {
      const compensationErrors = [];
      if (tunnelStopped && config?.mode === "full" && !this.tunnel) {
        try {
          await this.startTunnel(config);
        } catch (caught) {
          compensationErrors.push(["tunnel restart compensation failed", caught]);
        }
      }
      if (drained && config) {
        try {
          await this.restoreDrainedDaemon(config);
        } catch (caught) {
          compensationErrors.push(["daemon resume compensation failed", caught]);
        }
      }
      const message = compensationErrors.reduce(
        (current, [label, failure]) => appendFailure(current, label, failure),
        errorMessage(error),
      );
      let restoredReady = false;
      if (compensationErrors.length === 0 && config) {
        try {
          restoredReady = await this.ownedRuntimeReady(config);
        } catch {
          restoredReady = false;
        }
      }
      this.tryWriteState(restoredReady ? "ready" : "failed", message);
      throw new Error(message);
    } finally {
      this.stopping = false;
    }
  }

  async restart() {
    await this.stopForSetup();
    return this.startIfConfigured();
  }

  async shutdown() {
    return this.stopForSetup();
  }
}

module.exports = {
  MAX_RESTARTS_PER_WINDOW,
  RESTART_WINDOW_MS,
  RuntimeSupervisor,
  validateConfig,
};
