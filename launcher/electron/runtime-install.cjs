const fs = require("node:fs");
const path = require("node:path");
const { renameAtomicFile } = require("./atomic-file.cjs");
const { runtimeBundlePaths } = require("./runtime-command.cjs");

function validateRuntimeBundle(runtimeRoot, { version, platform, arch }) {
  const manifestPath = path.join(runtimeRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`Runtime manifest is missing: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1
    || manifest.appVersion !== version
    || manifest.platform !== platform
    || manifest.arch !== arch) {
    throw new Error(
      `Runtime bundle identity mismatch: expected ${version} ${platform}/${arch}, received ${JSON.stringify(manifest)}`,
    );
  }
  const paths = runtimeBundlePaths(runtimeRoot, platform);
  for (const required of [paths.executable, paths.entrypoint, path.join(runtimeRoot, "app", "browser-helper.cjs")]) {
    if (!fs.existsSync(required) || !fs.statSync(required).isFile()) {
      throw new Error(`Runtime bundle file is missing: ${required}`);
    }
  }
  if (platform !== "win32" && (fs.statSync(paths.executable).mode & 0o111) === 0) {
    throw new Error(`Bundled Bun runtime is not executable: ${paths.executable}`);
  }
  return paths.runtimeRoot;
}

function ensurePackagedRuntime({ app, coreHome, resourcesPath }) {
  if (!app.isPackaged) return null;
  const identity = {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  };
  const source = path.join(resourcesPath, "runtime");
  validateRuntimeBundle(source, identity);
  const versionsRoot = path.join(coreHome, "versions");
  const destination = path.join(
    versionsRoot,
    `${identity.version}-${identity.platform}-${identity.arch}`,
  );
  if (fs.existsSync(destination)) return validateRuntimeBundle(destination, identity);

  fs.mkdirSync(versionsRoot, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.cpSync(source, temporary, { recursive: true, errorOnExist: true, force: false });
    validateRuntimeBundle(temporary, identity);
    try {
      renameAtomicFile(temporary, destination);
    } catch (error) {
      if (!fs.existsSync(destination)) throw error;
      validateRuntimeBundle(destination, identity);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  try { fs.chmodSync(destination, 0o700); } catch {}
  return validateRuntimeBundle(destination, identity);
}

module.exports = {
  ensurePackagedRuntime,
  validateRuntimeBundle,
};
