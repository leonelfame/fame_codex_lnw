import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const packageVersion = (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version?: string }).version;
if (!packageVersion) throw new Error("package.json has no version");
const expected = [
  ["src/version.ts", `export const VERSION = ${JSON.stringify(packageVersion)};`],
  ["scripts/install.sh", `VERSION=\"\${CODEX_CHATGPT_WEB_VERSION:-${packageVersion}}\"`],
  ["scripts/smoke-release.ts", `releaseVersion: ${JSON.stringify(packageVersion)}`],
] as const;
for (const [path, needle] of expected) {
  if (!readFileSync(resolve(root, path), "utf8").includes(needle)) throw new Error(`${path} is not synchronized to ${packageVersion}`);
}
process.stdout.write(`VERSION_SYNC_OK ${packageVersion}\n`);
