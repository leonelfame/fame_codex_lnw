import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { compactRequest, responseRequest } from "../src/server";

const model = "chatgpt-web/gpt-5.6-sol";

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
