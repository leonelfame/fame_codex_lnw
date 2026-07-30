import { homedir } from "node:os";
import { join } from "node:path";
import { readLauncherBrowserHostDescriptor } from "../src/launcher-browser-host";

const descriptorPath = join(homedir(), ".codex-chatgpt-web", "runtime", "launcher-browser.json");
const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
const script = join(import.meta.dir, "inspect-launcher-pages.cjs");
const child = Bun.spawn(
  [descriptor.helper.executable, script, ...process.argv.slice(2)],
  {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exit(await child.exited);
