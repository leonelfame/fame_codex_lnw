import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const launcher = resolve(root, "launcher");
const bunExecutable = Bun.which("bun") ?? (() => {
  throw new Error("The installed Bun executable could not be resolved");
})();

function run(args: string[], cwd: string): void {
  const result = Bun.spawnSync([bunExecutable, ...args], {
    cwd,
    env: {
      ...process.env,
      CODEX_WEB_GPT_BUN: bunExecutable,
      CODEX_CHATGPT_WEB_BUN: bunExecutable,
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
