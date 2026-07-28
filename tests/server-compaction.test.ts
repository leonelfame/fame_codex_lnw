import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { compactRequest, responseRequest } from "../src/server";

const model = "chatgpt-web/high";

test("rejects ChatGPT Web compact v1 without opening a browser turn", async () => {
  const response = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: [] }),
  }), defaultConfig("browser-only"));

  expect(response.status).toBe(400);
  const body = await response.json() as { error: { message: string } };
  expect(body.error.message).toContain("ChatGPT owns context compaction");
});

test("rejects ChatGPT Web compact v2 without opening a browser turn", async () => {
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      input: [{ type: "compaction_trigger" }],
    }),
  }), defaultConfig("browser-only"));

  expect(response.status).toBe(400);
  const body = await response.json() as { error: { message: string } };
  expect(body.error.message).toContain("ChatGPT owns context compaction");
});

test("rejects an unknown routed compact model instead of treating it as ChatGPT Web", async () => {
  const response = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/not-enabled", input: [] }),
  }), defaultConfig("browser-only"));

  expect(response.status).toBe(400);
  const body = await response.json() as { error: { message: string } };
  expect(body.error.message).toContain("model is not enabled");
});

test("rejects the Pro routed model before opening a browser when the account has no Pro access", async () => {
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/pro", input: "test", stream: false }),
  }), defaultConfig("browser-only"));

  expect(response.status).toBe(400);
  const body = await response.json() as { error: { message: string } };
  expect(body.error.message).toContain("Pro is not available for this account");
});

test("refuses a ChatGPT Web continuation when local previous-response state is unavailable", async () => {
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      previous_response_id: "resp_missing_after_restart",
      input: "continue",
      stream: false,
    }),
  }), defaultConfig("browser-only"));

  expect(response.status).toBe(409);
  const body = await response.json() as { error: { message: string } };
  expect(body.error.message).toContain("partial Codex context");
});
