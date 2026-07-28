const DEFAULT_TIMEOUT_MS = 5_000;

async function resolvePageTarget({
  endpoint,
  pageUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const response = await fetchImpl(`${endpoint}/json`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`CDP target discovery failed with HTTP ${response.status}`);
  }
  const targets = await response.json();
  const matches = Array.isArray(targets)
    ? targets.filter((target) => (
      target?.type === "page"
      && target?.url === pageUrl
      && typeof target?.webSocketDebuggerUrl === "string"
    ))
    : [];
  if (matches.length !== 1) {
    throw new Error(`Expected one CDP page target for ${pageUrl}, found ${matches.length}`);
  }
  return matches[0].webSocketDebuggerUrl;
}

async function withPageCdp({
  endpoint,
  pageUrl,
  action,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const socketUrl = await resolvePageTarget({ endpoint, pageUrl, fetchImpl, timeoutMs });
  const socket = new WebSocketImpl(socketUrl);
  let nextId = 0;
  let closed = false;
  const pending = new Map();

  const rejectPending = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  };

  const opened = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("CDP page connection timed out")),
      timeoutMs,
    );
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Could not connect to the CDP page target"));
    }, { once: true });
  });

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      rejectPending(new Error("CDP page target returned invalid JSON"));
      return;
    }
    if (!Number.isInteger(message.id)) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error?.message) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    closed = true;
    rejectPending(new Error("CDP page target closed before completing the command"));
  });
  socket.addEventListener("error", () => {
    rejectPending(new Error("CDP page target connection failed"));
  });

  await opened;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP command ${method} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });

  try {
    return await action({ send });
  } finally {
    if (!closed) socket.close();
  }
}

async function dispatchTrustedClick({
  endpoint,
  pageUrl,
  point,
  fetchImpl,
  WebSocketImpl,
  timeoutMs,
}) {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
    throw new Error("CDP click point is invalid");
  }
  return await withPageCdp({
    endpoint,
    pageUrl,
    fetchImpl,
    WebSocketImpl,
    timeoutMs,
    action: async ({ send }) => {
      const base = {
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      };
      await send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
      await send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
    },
  });
}

async function evaluatePage({
  endpoint,
  pageUrl,
  expression,
  fetchImpl,
  WebSocketImpl,
  timeoutMs,
}) {
  if (typeof expression !== "string" || !expression.trim()) {
    throw new Error("CDP evaluation expression is required");
  }
  return await withPageCdp({
    endpoint,
    pageUrl,
    fetchImpl,
    WebSocketImpl,
    timeoutMs,
    action: async ({ send }) => {
      const response = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (response?.exceptionDetails) {
        const detail = response.exceptionDetails.exception?.description
          || response.exceptionDetails.text
          || "unknown page exception";
        throw new Error(`CDP page evaluation failed: ${detail}`);
      }
      return response?.result?.value;
    },
  });
}

module.exports = {
  dispatchTrustedClick,
  evaluatePage,
  resolvePageTarget,
  withPageCdp,
};
