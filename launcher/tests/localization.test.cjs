const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const read = (...parts) => fs.readFileSync(path.join(repositoryRoot, ...parts), "utf8");

function loadI18nModule() {
  const output = ts.transpileModule(read("launcher", "src", "i18n.ts"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  }).outputText;
  const loaded = { exports: {} };
  Function("module", "exports", "require", output)(loaded, loaded.exports, require);
  return loaded.exports;
}

test("launcher exposes English and Thai copy only", () => {
  const { copyFor, localizeRuntimeMessage } = loadI18nModule();
  const thai = copyFor("th");
  assert.equal(thai.thai, "ไทย");
  assert.equal(thai.chooseLanguage, "เลือกภาษา");
  assert.equal(localizeRuntimeMessage(thai, "Checking ChatGPT connector", undefined, "th"), "กำลังตรวจสอบตัวเชื่อมต่อ ChatGPT");
  assert.equal(copyFor("en").english, "English");
  assert.match(read("launcher", "src", "App.tsx"), /value: "th"/);
  assert.doesNotMatch(read("launcher", "src", "App.tsx"), /value: "zh-CN"|value: "ja"/);
});

test("launcher UI localizes MCP verification progress and doctor check messages", () => {
  const appSource = read("launcher", "src", "App.tsx");
  assert.match(appSource, /localizeRuntimeMessage\(copy, operation\.message, undefined, language\)/);
  assert.match(appSource, /check\.status === "ok"\s*\?\s*localizeRuntimeMessage\(copy, check\.message, check\.id, language\)\s*:\s*check\.message/);
});

test("Thai diagnostics preserve literal connector names and endpoints", () => {
  const { copyFor, localizeRuntimeMessage } = loadI18nModule();
  const copy = copyFor("th");
  for (const name of ["Fame Codex Native2", "Native $&", "Native $'", "Native $`", "Native $1", 'Native "quoted"', "Native \\path", "Native \u2028X", "Native \u2029X"]) {
    const message = `ChatGPT connector ${JSON.stringify(name)} is available`;
    assert.equal(localizeRuntimeMessage(copy, message, "connector", "th"), `ตัวเชื่อมต่อ ChatGPT "${name}" พร้อมใช้งาน`);
    assert.equal(localizeRuntimeMessage(copyFor("en"), message, "connector", "en"), message);
  }
  assert.equal(localizeRuntimeMessage(copy, "Responses proxy is healthy on 127.0.0.1:17842", "proxy", "th"), "Responses proxy พร้อมใช้งานที่ 127.0.0.1:17842");
  for (const message of ["Tunnel runtime is not ready", "Unexpected connector diagnostic", 'ChatGPT connector "unterminated is available', 'ChatGPT connector "name" is available (warning)']) {
    assert.equal(localizeRuntimeMessage(copy, message, "connector", "th"), message);
  }
  assert.equal(localizeRuntimeMessage(copy, 'ChatGPT connector "name" is available', "wrong-check", "th"), 'ChatGPT connector "name" is available');
});
