import { expect, test } from "bun:test";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";

test("authenticated lifecycle control cancels orphaned browser turns", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config);
  let cancelled = 0;
  chatGptTurnSessions.clear();
  chatGptTurnSessions.getOrCreate("orphan", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  }));

  try {
    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/admin/cancel-browser-turns`, {
      method: "POST",
      headers: { authorization: "Bearer invalid" },
    });
    expect(unauthorized.status).toBe(401);
    expect(chatGptTurnSessions.activeCount()).toBe(1);

    const response = await fetch(`http://127.0.0.1:${server.port}/admin/cancel-browser-turns`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      cancelled_browser_turns: 1,
      active_http_turns: 0,
      active_browser_turns: 0,
    });
    expect(cancelled).toBe(1);
    expect(chatGptTurnSessions.activeCount()).toBe(0);
  } finally {
    chatGptTurnSessions.clear();
    await server.stop(true);
  }
});
