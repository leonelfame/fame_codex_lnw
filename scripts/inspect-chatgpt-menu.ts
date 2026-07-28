import { homedir } from "node:os";
import { join } from "node:path";
import { connectLauncherBrowserHost } from "../src/launcher-browser-host";

const descriptorPath = join(homedir(), ".codex-chatgpt-web", "runtime", "launcher-browser.json");
const { page } = await connectLauncherBrowserHost(descriptorPath);
const popovers = await page.locator(":popover-open").evaluateAll(elements => (
  elements.map((element, popoverIndex) => {
    const root = element as HTMLElement;
    const visible = (candidate: HTMLElement): boolean => {
      const style = getComputedStyle(candidate);
      const rect = candidate.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && rect.width > 0
        && rect.height > 0;
    };
    return {
      popoverIndex,
      root: {
        tag: root.tagName.toLowerCase(),
        attributes: Object.fromEntries([...root.attributes].map(attribute => [attribute.name, attribute.value])),
      },
      descendants: [...root.querySelectorAll<HTMLElement>("*")]
        .filter(visible)
        .map((candidate, index) => ({
          index,
          tag: candidate.tagName.toLowerCase(),
          attributes: Object.fromEntries(
            [...candidate.attributes]
              .filter(attribute => !["href", "src", "value"].includes(attribute.name))
              .map(attribute => [attribute.name, attribute.value]),
          ),
          text: candidate.children.length === 0
            ? (candidate.innerText || candidate.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120)
            : "",
        })),
    };
  })
));

console.log(JSON.stringify(popovers, null, 2));
