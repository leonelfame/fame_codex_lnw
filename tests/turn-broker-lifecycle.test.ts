import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

test("turn broker creates its private runtime directory on a cold start", async () => {
  const root = mkdtempSync("/tmp/cgw-broker-");
  const socketPath = join(root, "runtime", "turn-broker.sock");
  const broker = TurnBroker.forSocket(socketPath);
  try {
    await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    }, 10_000);
    expect(existsSync(socketPath)).toBe(true);
    expect(statSync(dirname(socketPath)).mode & 0o777).toBe(0o700);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
