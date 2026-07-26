import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

interface PackageJson {
  name?: string;
  version?: string;
  license?: string | { type?: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const root = resolve(import.meta.dir, "..");
const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;
const visited = new Map<string, { directory: string; manifest: PackageJson }>();

function packageDirectory(name: string, from: string): string | undefined {
  let cursor = from;
  for (;;) {
    const candidate = join(cursor, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return undefined;
}

function visit(name: string, from: string, optional = false): void {
  const directory = packageDirectory(name, from);
  if (!directory) {
    if (optional) return;
    throw new Error(`Installed runtime dependency is missing: ${name} (from ${from})`);
  }
  if (visited.has(directory)) return;
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as PackageJson;
  if (!manifest.name || !manifest.version || !manifest.license) throw new Error(`Incomplete package metadata: ${directory}`);
  visited.set(directory, { directory, manifest });
  for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency, directory);
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) visit(dependency, directory, true);
}

for (const dependency of Object.keys(rootPackage.dependencies ?? {})) visit(dependency, root);

function licenseFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter(name => /^(licen[cs]e|copying|notice)(?:\..*)?$/i.test(name))
    .filter(name => statSync(join(directory, name)).isFile())
    .sort();
}

const sections = [...visited.values()]
  .sort((a, b) => `${a.manifest.name}@${a.manifest.version}`.localeCompare(`${b.manifest.name}@${b.manifest.version}`))
  .map(({ directory, manifest }) => {
    const files = licenseFiles(directory);
    if (files.length === 0) throw new Error(`No license/notice file found for ${manifest.name}@${manifest.version}`);
    const license = typeof manifest.license === "string" ? manifest.license : manifest.license?.type ?? "unknown";
    return [
      "=".repeat(80),
      `${manifest.name}@${manifest.version} (${license})`,
      ...files.flatMap(file => ["-".repeat(80), file, "-".repeat(80), readFileSync(join(directory, file), "utf8").trim()]),
    ].join("\n");
  });

const bunLicense = readFileSync(join(root, "LICENSES", "Bun-1.3.11.md"), "utf8").trim();
const output = [
  "codex-chatgpt-web third-party notices",
  "",
  "This file covers runtime JavaScript packages bundled into the standalone executable.",
  "The executable also embeds Bun 1.3.11; Bun's licensing and relinking notice follows first.",
  "Project/OpenCodex notices are distributed separately in NOTICE.md and OpenCodex-MIT.txt.",
  "",
  "=".repeat(80),
  "Bun 1.3.11 runtime",
  "=".repeat(80),
  bunLicense,
  "",
  ...sections,
  "",
].join("\n");

const destination = join(root, "dist", "THIRD_PARTY_NOTICES.txt");
writeFileSync(destination, output);
process.stdout.write(`Wrote ${destination} (${visited.size} runtime packages)\n`);
