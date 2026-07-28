import { homedir } from "node:os";
import { join } from "node:path";
import { readLauncherBrowserHostDescriptor } from "../src/launcher-browser-host";

const descriptorPath = join(homedir(), ".codex-chatgpt-web", "runtime", "launcher-browser.json");
const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
const targets = await fetch(`${descriptor.endpoint}/json`).then(response => response.json()) as Array<{
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}>;
const target = targets.find(candidate => (
  candidate.type === "page"
  && candidate.url?.startsWith("https://chatgpt.com/")
  && typeof candidate.webSocketDebuggerUrl === "string"
));
if (!target?.webSocketDebuggerUrl) throw new Error("The launcher CDP endpoint has no ChatGPT page target");

const inspectExpression = `(() => {
  const visible = (candidate) => {
    const style = getComputedStyle(candidate);
    const rect = candidate.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && rect.width > 0
      && rect.height > 0;
  };
  const attributes = (candidate) => Object.fromEntries(
    Array.from(candidate.attributes)
      .filter(attribute => (
        attribute.name === 'class'
        || attribute.name === 'role'
        || attribute.name === 'tabindex'
        || attribute.name === 'popover'
        || attribute.name.startsWith('aria-')
        || attribute.name.startsWith('data-')
      ))
      .map(attribute => [attribute.name, attribute.value])
  );
  const describe = (candidate) => ({
    tag: candidate.tagName.toLowerCase(),
    attributes: attributes(candidate),
  });
  const effortControl = Array.from(document.querySelectorAll('button[aria-haspopup="menu"][data-tone="neutral"]'))
    .filter(visible)
    .at(-1);
  if (!effortControl) return { error: 'effort control not found' };
  const controlRect = effortControl.getBoundingClientRect();
  const region = {
    left: Math.max(0, controlRect.left - 280),
    right: Math.min(innerWidth, controlRect.right + 80),
    top: Math.max(0, controlRect.top - 520),
    bottom: Math.min(innerHeight, controlRect.bottom + 80),
  };
  const candidates = Array.from(document.querySelectorAll('*'))
    .filter((candidate) => {
      if (!visible(candidate)) return false;
      const rect = candidate.getBoundingClientRect();
      if (
        rect.right < region.left
        || rect.left > region.right
        || rect.bottom < region.top
        || rect.top > region.bottom
      ) return false;
      const text = (candidate.innerText || candidate.textContent || '').replace(/\\s+/g, ' ').trim();
      const attrs = attributes(candidate);
      return (
        (candidate.children.length === 0 && text.length > 0 && text.length <= 120)
        || candidate.tagName === 'BUTTON'
        || Object.keys(attrs).some(name => (
          name === 'role'
          || name === 'tabindex'
          || name === 'popover'
          || name === 'data-testid'
          || name === 'data-radix-collection-item'
          || name === 'aria-haspopup'
        ))
      );
    })
    .slice(0, 120)
    .map((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const ancestors = [];
      let parent = candidate.parentElement;
      for (let depth = 0; parent && depth < 4; depth += 1, parent = parent.parentElement) {
        ancestors.push(describe(parent));
      }
      return {
        ...describe(candidate),
        text: (candidate.innerText || candidate.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        ancestors,
      };
    });
  return {
    viewport: { width: innerWidth, height: innerHeight },
    effortControl: {
      ...describe(effortControl),
      rect: {
        x: Math.round(controlRect.x),
        y: Math.round(controlRect.y),
        width: Math.round(controlRect.width),
        height: Math.round(controlRect.height),
      },
    },
    openPopoverCount: document.querySelectorAll(':popover-open').length,
    candidates,
  };
})()`;

const exerciseExpression = `(async () => {
  const visible = (candidate) => {
    const style = getComputedStyle(candidate);
    const rect = candidate.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && rect.width > 0
      && rect.height > 0;
  };
  const sleep = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));
  const effortControl = Array.from(document.querySelectorAll('button[aria-haspopup="menu"][data-tone="neutral"]'))
    .filter(visible)
    .at(-1);
  if (!effortControl) return { ok: false, stage: 'control', error: 'effort control not found' };
  const menuSelector = '[data-testid="composer-intelligence-picker-content"][role="group"]';
  const readMenu = () => {
    const menu = Array.from(document.querySelectorAll(menuSelector)).filter(visible).at(-1);
    const items = menu
      ? Array.from(menu.querySelectorAll('[role="menuitemradio"]')).filter(visible)
      : [];
    return { menu, items };
  };
  const waitFor = async (predicate, timeoutMs) => {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await sleep(50);
    }
    return null;
  };

  if (readMenu().menu) {
    effortControl.click();
    if (!await waitFor(() => !readMenu().menu, 5_000)) {
      return { ok: false, stage: 'close', error: 'menu did not close after semantic control click' };
    }
  }

  const openedAt = performance.now();
  effortControl.click();
  const opened = await waitFor(() => {
    const state = readMenu();
    return state.items.length >= 5 ? state : null;
  }, 5_000);
  if (!opened) {
    const state = readMenu();
    return { ok: false, stage: 'open', itemCount: state.items.length };
  }

  const target = opened.items[2];
  const targetLabel = (target.innerText || target.textContent || '').replace(/\\s+/g, ' ').trim();
  target.click();
  const confirmed = await waitFor(() => {
    const label = (effortControl.innerText || effortControl.textContent || '').replace(/\\s+/g, ' ').trim();
    return label === targetLabel ? label : null;
  }, 5_000);
  return {
    ok: Boolean(confirmed),
    stage: confirmed ? 'confirmed' : 'confirm',
    itemCount: opened.items.length,
    openLatencyMs: Math.round(performance.now() - openedAt),
    targetIndex: 2,
    targetLabel,
    confirmedLabel: confirmed,
  };
})()`;

const expression = process.argv.includes("--exercise") ? exerciseExpression : inspectExpression;

const popovers = await new Promise<unknown>((resolveResult, rejectResult) => {
  const socket = new WebSocket(target.webSocketDebuggerUrl!);
  const timeout = setTimeout(() => {
    socket.close();
    rejectResult(new Error("CDP Runtime.evaluate timed out"));
  }, 10_000);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      error?: { message?: string };
      result?: { exceptionDetails?: unknown; result?: { value?: unknown } };
    };
    if (message.id !== 1) return;
    clearTimeout(timeout);
    socket.close();
    if (message.error?.message) return rejectResult(new Error(message.error.message));
    if (message.result?.exceptionDetails) return rejectResult(new Error("CDP Runtime.evaluate raised an exception"));
    resolveResult(message.result?.result?.value);
  });
  socket.addEventListener("error", () => {
    clearTimeout(timeout);
    rejectResult(new Error("Could not connect to the ChatGPT page CDP target"));
  });
});

console.log(JSON.stringify(popovers, null, 2));
