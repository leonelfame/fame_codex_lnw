const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REQUIRED_LIBNOTIFY_SYMBOL = "notify_notification_get_activation_app_launch_context";

function bundledLibnotifyPaths(root) {
  const matches = [];
  const visit = (directory, depth) => {
    if (depth > 3) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target, depth + 1);
      else if (entry.isFile() && entry.name === "libnotify.so.4") matches.push(target);
    }
  };
  visit(root, 0);
  return matches;
}

function requireLibnotifySymbol(libraryPath) {
  const result = spawnSync("nm", ["-D", "--defined-only", libraryPath], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Could not inspect ${libraryPath}: ${result.stderr.trim() || `nm exited ${result.status}`}`);
  }
  const exports = result.stdout.split(/\r?\n/).some((line) => (
    line.trim().split(/\s+/).at(-1) === REQUIRED_LIBNOTIFY_SYMBOL
  ));
  if (!exports) {
    throw new Error(`${libraryPath} does not export ${REQUIRED_LIBNOTIFY_SYMBOL}`);
  }
}

async function afterPack(context) {
  if (context.electronPlatformName !== "linux") return;
  const source = process.env.CODEX_WEB_GPT_LINUX_LIBNOTIFY?.trim();
  if (!source || !path.isAbsolute(source) || !fs.statSync(source, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(
      "Linux packaging requires CODEX_WEB_GPT_LINUX_LIBNOTIFY from scripts/prepare-linux-libnotify.sh",
    );
  }
  requireLibnotifySymbol(source);
  const bundled = bundledLibnotifyPaths(context.appOutDir);
  if (bundled.length !== 1) {
    throw new Error(`Expected exactly one packaged libnotify.so.4; found ${bundled.length}`);
  }
  fs.copyFileSync(source, bundled[0]);
  fs.chmodSync(bundled[0], 0o755);
  requireLibnotifySymbol(bundled[0]);
}

module.exports = afterPack;
module.exports.REQUIRED_LIBNOTIFY_SYMBOL = REQUIRED_LIBNOTIFY_SYMBOL;
module.exports.bundledLibnotifyPaths = bundledLibnotifyPaths;
module.exports.requireLibnotifySymbol = requireLibnotifySymbol;
