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

async function dispatchTrustedKey({ debuggerClient, key }) {
  if (key !== "Enter") {
    throw new Error(`Unsupported CDP key: ${String(key)}`);
  }
  const event = {
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  };
  await withWebContentsDebugger(debuggerClient, async (sendCommand) => {
    await sendCommand("Input.dispatchKeyEvent", {
      ...event,
      type: "keyDown",
      text: "\r",
      unmodifiedText: "\r",
    });
    await sendCommand("Input.dispatchKeyEvent", {
      ...event,
      type: "keyUp",
    });
  });
}

function printableKeyDescription(character) {
  if (/^[a-z]$/i.test(character)) {
    return {
      code: `Key${character.toUpperCase()}`,
      keyCode: character.toUpperCase().charCodeAt(0),
    };
  }
  if (/^[0-9]$/.test(character)) {
    return { code: `Digit${character}`, keyCode: character.charCodeAt(0) };
  }
  if (character === "@") return { code: "Digit2", keyCode: 50 };
  if (character === " ") return { code: "Space", keyCode: 32 };
  throw new Error(`Trusted CDP typing does not support character ${JSON.stringify(character)}`);
}

async function dispatchTrustedText({ debuggerClient, text, delayMs = 0 }) {
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("Trusted CDP text requires a non-empty string");
  }
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 1_000) {
    throw new Error("Trusted CDP text delay must be between 0 and 1000 milliseconds");
  }
  const characters = Array.from(text);
  await withWebContentsDebugger(debuggerClient, async (sendCommand) => {
    for (const [index, character] of characters.entries()) {
      const description = printableKeyDescription(character);
      await sendCommand("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: character,
        code: description.code,
        windowsVirtualKeyCode: description.keyCode,
        nativeVirtualKeyCode: description.keyCode,
        text: character,
        unmodifiedText: character,
      });
      await sendCommand("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: character,
        code: description.code,
        windowsVirtualKeyCode: description.keyCode,
        nativeVirtualKeyCode: description.keyCode,
      });
      if (delayMs > 0 && index < characters.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  });
}

async function dispatchTrustedClick({ debuggerClient, point }) {
  const x = point?.x;
  const y = point?.y;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    throw new Error("Trusted CDP click requires a finite non-negative point");
  }
  await withWebContentsDebugger(debuggerClient, async (sendCommand) => {
    await sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });
    await sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
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
  dispatchTrustedKey,
  dispatchTrustedText,
  evaluatePage,
  withWebContentsDebugger,
};
