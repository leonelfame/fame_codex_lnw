import { expect, test } from "bun:test";
import { CHATGPT_WEB_MODEL_ID, resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";

test("one ChatGPT Web model maps explicit efforts to the visible ChatGPT modes", () => {
  const capabilities = { localToolsEnabled: true, proAvailable: true };
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "light", capabilities)).toMatchObject({
    uiEffortLabel: "Instant 5.5",
    localTools: true,
  });
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "medium", capabilities)).toMatchObject({
    uiEffortLabel: "Medium",
    localTools: true,
  });
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "high", capabilities)).toMatchObject({
    uiEffortLabel: "High",
    localTools: true,
  });
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "xhigh", capabilities)).toMatchObject({
    uiEffortLabel: "Extra High",
    localTools: true,
  });
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "pro", capabilities)).toMatchObject({
    uiEffortLabel: "Pro",
    localTools: false,
  });
});

test("capabilities gate tools and Pro explicitly without changing the selected model", () => {
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "high", {
    localToolsEnabled: false,
    proAvailable: true,
  })).toMatchObject({ localTools: false });
  expect(() => resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "pro", {
    localToolsEnabled: false,
    proAvailable: false,
  })).toThrow("Pro effort is not available");
  expect(() => resolveChatGptWebModelMode("unknown", "high", {
    localToolsEnabled: false,
    proAvailable: true,
  })).toThrow("model is not supported");
  expect(() => resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "turbo", {
    localToolsEnabled: false,
    proAvailable: true,
  })).toThrow("effort is not supported");
});
