import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("setup accepts an explicit native source catalog before runtime validation", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-"));
  try {
    const result = Bun.spawnSync([
      process.execPath,
      resolve(import.meta.dir, "../src/cli.ts"),
      "setup",
      "--pro-only",
      "--port",
      "0",
      "--source-catalog",
      join(root, "native-models.json"),
      "--acknowledge-unofficial",
    ], {
      env: {
        ...process.env,
        CODEX_HOME: join(root, "codex"),
        CODEX_CHATGPT_WEB_HOME: join(root, "app"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = result.stderr.toString();
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("--port must be an integer from 1 to 65535");
    expect(stderr).not.toContain("Unknown arguments");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
