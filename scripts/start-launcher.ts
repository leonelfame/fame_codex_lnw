import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const launcher = resolve(root, "launcher");

function run(args: string[], cwd: string): void {
  const result = Bun.spawnSync([process.execPath, ...args], {
    cwd,
    env: {
      ...process.env,
      CODEX_WEB_GPT_BUN: process.execPath,
      CODEX_CHATGPT_WEB_BUN: process.execPath,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

run(["install", "--frozen-lockfile"], root);
run(["install", "--frozen-lockfile"], launcher);
run(["run", "dev"], launcher);
