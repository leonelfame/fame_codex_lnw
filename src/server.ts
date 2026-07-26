import { createChatGptWebAdapter } from "./adapters/chatgpt-web";
import { timingSafeEqual } from "node:crypto";
import { chatGptTurnSessions } from "./adapters/chatgpt-web/turn-execution";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "./bridge";
import type { AppConfig } from "./config";
import { providerConfig } from "./config";
import { AsyncEventQueue } from "./event-queue";
import { readJsonRequestBody } from "./http-body";
import { forwardNativeCodexRequest } from "./native-passthrough";
import { buildCompactV1Output, COMPACT_PROMPT, decodeCompactionSummary, extractCompactUserMessages } from "./responses/compaction";
import { parseRequest } from "./responses/parser";
import { expandPreviousResponseInput, flushResponseState, rememberResponseState } from "./responses/state";
import { namespacedToolName, type AdapterEvent, type CodexParsedRequest } from "./types";
import { VERSION } from "./version";

const ROUTED_PREFIX = "chatgpt-web/";
const WEB_MODEL = "gpt-5.6-sol";

function modelList(): Array<Record<string, unknown>> {
  return [{ id: `${ROUTED_PREFIX}${WEB_MODEL}`, object: "model", created: 0, owned_by: "chatgpt-web" }];
}

function routeModel(parsed: CodexParsedRequest, config: AppConfig): string {
  const requested = parsed.modelId.startsWith(ROUTED_PREFIX)
    ? parsed.modelId.slice(ROUTED_PREFIX.length)
    : parsed.modelId;
  if (requested !== WEB_MODEL) throw new Error(`ChatGPT web model is not enabled: ${parsed.modelId}`);
  if (parsed.options.reasoning === "pro" && !config.proAvailable) {
    throw new Error("ChatGPT Pro effort is not available for this account");
  }
  parsed.modelId = requested;
  if (parsed._rawBody && typeof parsed._rawBody === "object") {
    (parsed._rawBody as { model?: string }).model = requested;
  }
  return requested;
}

function toolBridgeMaps(parsed: CodexParsedRequest): {
  toolNsMap: Map<string, { namespace: string; name: string }>;
  freeformToolNames: Set<string>;
  toolSearchToolNames: Set<string>;
} {
  const toolNsMap = new Map<string, { namespace: string; name: string }>();
  const freeformToolNames = new Set<string>();
  const toolSearchToolNames = new Set<string>();
  for (const tool of parsed.context.tools ?? []) {
    if (tool.namespace) toolNsMap.set(namespacedToolName(tool.namespace, tool.name), { namespace: tool.namespace, name: tool.name });
    if (tool.freeform) freeformToolNames.add(tool.name);
    if (tool.toolSearch) toolSearchToolNames.add(tool.name);
  }
  return { toolNsMap, freeformToolNames, toolSearchToolNames };
}

async function responseRequest(req: Request, config: AppConfig): Promise<Response> {
  const nativeRequest = req.clone();
  let raw: unknown;
  try {
    raw = await readJsonRequestBody(req);
  } catch (error) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      error instanceof Error ? error.message : "Request body must be valid JSON",
    );
  }
  const requestedModel = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { model?: unknown }).model
    : undefined;
  if (typeof requestedModel === "string" && !requestedModel.startsWith(ROUTED_PREFIX)) {
    try {
      return await forwardNativeCodexRequest(nativeRequest, "responses");
    } catch (error) {
      return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
    }
  }
  const expanded = expandPreviousResponseInput(raw);
  let parsed: CodexParsedRequest;
  try {
    parsed = parseRequest(expanded);
    routeModel(parsed, config);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }

  const compaction = parsed._compactionRequest === true;
  if (compaction) {
    delete parsed.context.tools;
    delete parsed.options.toolChoice;
    delete parsed.options.parallelToolCalls;
    parsed.context.messages.push({ role: "user", content: COMPACT_PROMPT, timestamp: Date.now() });
  }

  const adapter = createChatGptWebAdapter(providerConfig(config));
  const queue = new AsyncEventQueue<AdapterEvent>();
  const abort = new AbortController();
  if (req.signal.aborted) abort.abort();
  else req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const run = async () => {
    try {
      await adapter.runTurn!(parsed, { headers: req.headers, abortSignal: abort.signal }, event => queue.push(event));
    } catch (error) {
      queue.push({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      queue.close();
    }
  };
  const maps = toolBridgeMaps(parsed);
  const responseModel = `${ROUTED_PREFIX}${parsed.modelId}`;

  if (parsed.stream) {
    void run();
    const stream = bridgeToResponsesSSE(
      queue,
      responseModel,
      maps.toolNsMap,
      maps.freeformToolNames,
      maps.toolSearchToolNames,
      () => abort.abort(),
      2_000,
      {
        hideThinkingSummary: parsed.options.hideThinkingSummary,
        ...(compaction ? { compaction: true } : {}),
        ...(!compaction ? {
          onCompletedResponse: response => rememberResponseState(parsed._rawBody, response, { force: true }),
        } : {}),
      },
    );
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  await run();
  const events = await queue.collect();
  const json = buildResponseJSON(events, responseModel, {
    hideThinkingSummary: parsed.options.hideThinkingSummary,
    toolNsMap: maps.toolNsMap,
    freeformToolNames: maps.freeformToolNames,
    toolSearchToolNames: maps.toolSearchToolNames,
    ...(compaction ? { compaction: true } : {}),
  });
  if (!compaction) rememberResponseState(parsed._rawBody, json, { force: true });
  return Response.json(json);
}

async function compactRequest(req: Request, config: AppConfig): Promise<Response> {
  const nativeRequest = req.clone();
  let raw: Record<string, unknown>;
  try {
    const parsed = await readJsonRequestBody(req);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    raw = parsed as Record<string, unknown>;
  } catch (error) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      error instanceof Error ? error.message : "Compaction request body must be a JSON object",
    );
  }
  if (typeof raw.model !== "string" || !raw.model) {
    return formatErrorResponse(400, "invalid_request_error", "Compaction request requires a model");
  }
  if (!raw.model.startsWith(ROUTED_PREFIX)) {
    try {
      return await forwardNativeCodexRequest(nativeRequest, "responses/compact");
    } catch (error) {
      return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
    }
  }
  const input = Array.isArray(raw.input) ? raw.input : [];
  const headers = new Headers(req.headers);
  headers.set("content-type", "application/json");
  const internal = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...raw, stream: false, input: [...input, { type: "compaction_trigger" }] }),
    signal: req.signal,
  });
  const response = await responseRequest(internal, config);
  if (!response.ok) return response;
  let body: { output?: unknown[]; status?: unknown; error?: unknown };
  try {
    body = await response.json() as typeof body;
  } catch {
    return formatErrorResponse(502, "invalid_response_error", "Compaction turn returned invalid JSON");
  }
  if (body.error || body.status !== "completed") {
    return formatErrorResponse(502, "upstream_error", `Compaction turn failed (status: ${String(body.status ?? "unknown")})`);
  }
  const items = (body.output ?? []).filter(
    (item): item is { type: "compaction"; encrypted_content?: string } =>
      Boolean(item && typeof item === "object" && (item as { type?: string }).type === "compaction"),
  );
  if (items.length !== 1) {
    return formatErrorResponse(502, "invalid_response_error", `Compaction turn produced ${items.length} compaction items; expected one`);
  }
  const summary = typeof items[0]!.encrypted_content === "string"
    ? decodeCompactionSummary(items[0]!.encrypted_content)
    : null;
  if (!summary?.trim()) return formatErrorResponse(502, "invalid_response_error", "Compaction turn produced an empty summary");
  return Response.json({ output: buildCompactV1Output(extractCompactUserMessages(input), summary) });
}

export function startServer(config: AppConfig): ReturnType<typeof Bun.serve> {
  const startedAt = Date.now();
  let activeHttpTurns = 0;
  let draining = false;
  const activity = () => ({
    active_http_turns: activeHttpTurns,
    active_browser_turns: chatGptTurnSessions.activeCount(),
  });
  const controlAuthorized = (req: Request): boolean => {
    const header = req.headers.get("authorization") ?? "";
    const expected = Buffer.from(`Bearer ${config.controlToken}`);
    const actual = Buffer.from(header);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") {
        return Response.json({
          status: "ok",
          service: "codex-chatgpt-web",
          version: VERSION,
          mode: config.mode,
          pid: process.pid,
          port: config.port,
          uptime: (Date.now() - startedAt) / 1_000,
          accepting_turns: !draining,
          ...activity(),
        });
      }
      if (req.method === "POST" && (url.pathname === "/admin/drain" || url.pathname === "/admin/resume")) {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        draining = url.pathname === "/admin/drain";
        return Response.json({ status: "ok", accepting_turns: !draining, ...activity() });
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        return Response.json({ object: "list", data: modelList() });
      }
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        if (draining) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");
        activeHttpTurns += 1;
        return responseRequest(req, config).finally(() => { activeHttpTurns -= 1; });
      }
      if (req.method === "POST" && url.pathname === "/v1/responses/compact") {
        if (draining) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");
        activeHttpTurns += 1;
        return compactRequest(req, config).finally(() => { activeHttpTurns -= 1; });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  const shutdown = () => {
    draining = true;
    flushResponseState();
    void server.stop(true);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}
