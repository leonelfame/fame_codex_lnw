import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { modelsRequest } from "../src/server";

test("proxies official /models auth and query, then appends ChatGPT Web", async () => {
  const request = new Request("http://127.0.0.1:17841/v1/models?client_version=1.2.3", {
    headers: { authorization: "Bearer codex-oauth-token", "if-none-match": "native-etag" },
  });
  let upstream: Request | undefined;
  const response = await modelsRequest(request, defaultConfig("full"), async input => {
    upstream = input;
    return Response.json({
      models: [{
        slug: "gpt-5.6-sol",
        display_name: "5.6 Sol",
        supported_reasoning_levels: [],
        tool_mode: "code_mode_only",
      }],
    }, { headers: { etag: "native-etag" } });
  });

  expect(upstream!.url).toBe("https://chatgpt.com/backend-api/codex/models?client_version=1.2.3");
  expect(upstream!.method).toBe("GET");
  expect(upstream!.headers.get("authorization")).toBe("Bearer codex-oauth-token");
  expect(upstream!.headers.get("if-none-match")).toBeNull();
  expect(response.headers.get("etag")).not.toBe("native-etag");
  const body = await response.json() as { models: Array<{ slug: string }> };
  expect(body.models.map(model => model.slug)).toEqual(["gpt-5.6-sol", "chatgpt-web/gpt-5.6-sol"]);
});
