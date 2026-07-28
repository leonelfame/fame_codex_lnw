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

const expression = `(() => {
  const visible = (candidate) => {
    const style = getComputedStyle(candidate);
    const rect = candidate.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && rect.width > 0
      && rect.height > 0;
  };
  return Array.from(document.querySelectorAll(':popover-open')).map((root, popoverIndex) => ({
    popoverIndex,
    root: {
      tag: root.tagName.toLowerCase(),
      attributes: Object.fromEntries(Array.from(root.attributes).map(attribute => [attribute.name, attribute.value])),
    },
    descendants: Array.from(root.querySelectorAll('*'))
      .filter(visible)
      .map((candidate, index) => ({
        index,
        tag: candidate.tagName.toLowerCase(),
        attributes: Object.fromEntries(
          Array.from(candidate.attributes)
            .filter(attribute => !['href', 'src', 'value'].includes(attribute.name))
            .map(attribute => [attribute.name, attribute.value])
        ),
        text: candidate.children.length === 0
          ? (candidate.innerText || candidate.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120)
          : '',
      })),
  }));
})()`;

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
      params: { expression, returnByValue: true },
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
