import { expect, test } from "bun:test";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

test("explicit browser-turn cancellation aborts and removes every registered session", () => {
  const sessions = new ChatGptTurnSessions();
  let cancelled = 0;
  sessions.getOrCreate("turn-a", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  }));
  sessions.getOrCreate("turn-b", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  }));

  expect(sessions.activeCount()).toBe(2);
  expect(sessions.clear()).toBe(2);
  expect(cancelled).toBe(2);
  expect(sessions.activeCount()).toBe(0);
});

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
