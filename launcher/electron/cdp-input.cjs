async function withWebContentsDebugger(debuggerClient, action) {
  if (!debuggerClient || typeof debuggerClient.sendCommand !== "function") {
    throw new Error("Electron WebContents debugger is unavailable");
  }
  const ownedAttachment = !debuggerClient.isAttached();
  if (ownedAttachment) debuggerClient.attach("1.3");
  try {
    return await action((method, params = {}) => debuggerClient.sendCommand(method, params));
  } finally {
    if (ownedAttachment && debuggerClient.isAttached()) debuggerClient.detach();
  }
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
  await withWebContentsDebugger(debuggerClient, async (sendCommand) => {
    await sendCommand("Input.dispatchMouseEvent", {
      ...base,
      type: "mousePressed",
    });
    await sendCommand("Input.dispatchMouseEvent", {
      ...base,
      type: "mouseReleased",
    });
  });
}

async function evaluatePage({ debuggerClient, expression }) {
  if (typeof expression !== "string" || !expression.trim()) {
    throw new Error("CDP evaluation expression is required");
  }
  return await withWebContentsDebugger(debuggerClient, async (sendCommand) => {
    const response = await sendCommand("Runtime.evaluate", {
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
  });
}

module.exports = {
  dispatchTrustedClick,
  evaluatePage,
  withWebContentsDebugger,
};
