async function sendWebContentsCommand(debuggerClient, method, params = {}) {
  if (!debuggerClient || typeof debuggerClient.sendCommand !== "function") {
    throw new Error("Electron WebContents debugger is unavailable");
  }
  if (!debuggerClient.isAttached()) debuggerClient.attach("1.3");
  return await debuggerClient.sendCommand(method, params);
}

async function dispatchTrustedClick({ debuggerClient, point }) {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
    throw new Error("CDP click point is invalid");
  }
  const base = {
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  };
  await sendWebContentsCommand(debuggerClient, "Input.dispatchMouseEvent", {
    ...base,
    type: "mousePressed",
  });
  await sendWebContentsCommand(debuggerClient, "Input.dispatchMouseEvent", {
    ...base,
    type: "mouseReleased",
  });
}

async function evaluatePage({ debuggerClient, expression }) {
  if (typeof expression !== "string" || !expression.trim()) {
    throw new Error("CDP evaluation expression is required");
  }
  const response = await sendWebContentsCommand(debuggerClient, "Runtime.evaluate", {
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
}

module.exports = {
  dispatchTrustedClick,
  evaluatePage,
  sendWebContentsCommand,
};
