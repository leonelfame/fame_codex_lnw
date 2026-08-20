import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  devLauncherEnvironment,
  installedLauncherCandidates,
  resolveDevProfilePaths,
} from "../src/dev-chat/profile";

test("DEV profile paths isolate browser, Codex, config, chat, and runtime state", () => {
  const homeDirectory = "/Users/tester";
  const paths = resolveDevProfilePaths({
    homeDirectory,
    environment: {
      CODEX_CHATGPT_WEB_HOME: join(homeDirectory, "production"),
      CODEX_WEB_GPT_DEV_HOME: join(homeDirectory, "development"),
    },
  });
  expect(paths).toEqual({
    home: join(homeDirectory, "development"),
    codexHome: join(homeDirectory, "development", "codex-home"),
    launcherUserData: join(homeDirectory, "development", "launcher"),
    descriptorPath: join(homeDirectory, "development", "runtime", "launcher-browser.json"),
    chatsPath: join(homeDirectory, "development", "chats"),
    runtimePath: join(homeDirectory, "development", "runtime", "dev-chat"),
    configPath: join(homeDirectory, "development", "config.json"),
  });
});

test("DEV profile path refuses production home reuse", () => {
  const shared = "/Users/tester/shared";
  expect(() => resolveDevProfilePaths({
    homeDirectory: "/Users/tester",
    environment: {
      CODEX_CHATGPT_WEB_HOME: shared,
      CODEX_WEB_GPT_DEV_HOME: shared,
    },
  })).toThrow("must differ from the production");
});

test("installed launcher discovery has explicit platform candidates", () => {
  expect(installedLauncherCandidates({
    platform: "darwin",
    homeDirectory: "/Users/tester",
    environment: {},
  })).toEqual([
    "/Applications/Codex Web GPT.app/Contents/MacOS/Codex Web GPT",
    "/Users/tester/Applications/Codex Web GPT.app/Contents/MacOS/Codex Web GPT",
  ]);
  expect(installedLauncherCandidates({
    platform: "linux",
    homeDirectory: "/home/tester",
    environment: { PATH: "/usr/local/bin:/usr/bin" },
  })).toEqual([
    "/home/tester/.local/bin/codex-web-gpt",
    "/usr/local/bin/codex-web-gpt",
    "/usr/bin/codex-web-gpt",
  ]);
});

test("DEV launcher child cannot inherit production home or browser-profile overrides", () => {
  const paths = resolveDevProfilePaths({
    homeDirectory: "/Users/tester",
    environment: {
      CODEX_CHATGPT_WEB_HOME: "/Users/tester/production",
      CODEX_WEB_GPT_DEV_HOME: "/Users/tester/development",
    },
  });
  expect(devLauncherEnvironment(paths, {
    KEEP_ME: "yes",
    CODEX_CHATGPT_WEB_HOME: paths.home,
    CODEX_HOME: "/Users/tester/production-codex",
    CODEX_WEB_GPT_LAUNCHER_DATA_DIR: "/Users/tester/production-launcher",
  })).toEqual({
    KEEP_ME: "yes",
    CODEX_WEB_GPT_DEV_HOME: paths.home,
  });
});
