import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { extractChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import type { CodexParsedRequest } from "../src/types";

const root = resolve(process.cwd());
const environmentXml = `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
</environment_context>`;

function currentWire(options: { workspace?: string; sandbox?: string; includeIds?: boolean } = {}): CodexParsedRequest {
  const workspace = options.workspace ?? root;
  const sandbox = options.sandbox ?? "none";
  const includeIds = options.includeIds ?? true;
  const turnMetadata = {
    thread_id: "thread_current",
    turn_id: "turn_current",
    sandbox,
    workspaces: { [workspace]: { has_changes: true } },
  };
  return {
    modelId: "chatgpt-web/gpt-5.6-sol",
    stream: true,
    context: { messages: [{ role: "user", content: "Inspect the workspace", timestamp: 1 }] },
    options: { reasoning: "high" },
    _rawBody: {
      client_metadata: { "x-codex-turn-metadata": JSON.stringify(turnMetadata) },
      input: [
        {
          type: "message",
          ...(includeIds ? { id: "msg_context" } : {}),
          role: "user",
          content: [
            { type: "input_text", text: "<app-context>native app context</app-context>" },
            { type: "input_text", text: environmentXml },
          ],
        },
        {
          type: "message",
          ...(includeIds ? { id: "msg_active" } : {}),
          role: "user",
          content: [{ type: "input_text", text: "Inspect the workspace" }],
        },
      ],
    },
  };
}

describe("trusted current Codex environment envelope", () => {
  test("accepts the v0.146 split envelope when workspace and sandbox metadata agree", () => {
    expect(extractChatGptTurnEnvironment(currentWire())).toEqual({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
  });

  test("rejects a workspace mismatch", () => {
    expect(() => extractChatGptTurnEnvironment(currentWire({ workspace: resolve(root, "elsewhere") })))
      .toThrow("missing cwd");
  });

  test("rejects a sandbox mismatch", () => {
    expect(() => extractChatGptTurnEnvironment(currentWire({ sandbox: "read-only" })))
      .toThrow("missing cwd");
  });

  test("rejects unprovenanced adjacent user content without native item ids", () => {
    expect(() => extractChatGptTurnEnvironment(currentWire({ includeIds: false })))
      .toThrow("missing cwd");
  });
});
