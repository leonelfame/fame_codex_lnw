<h1 align="center">ChatGPT Web for Codex</h1>

Building from source requires Bun 1.4.0.

<p align="center">
  <strong>将 ChatGPT Web（包括 Pro）作为 Codex 原生模型使用。</strong><br>
  切换模型档位，保留原有工作流。
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <a href="TROUBLESHOOTING.md">故障排除</a> · <a href="SECURITY.md">安全</a> · <a href="CONTRIBUTING.md">贡献</a>
</p>

<p align="center">
  <a href="https://github.com/leonelfame/fame_codex_lnw/actions/workflows/ci.yml"><img src="https://github.com/leonelfame/fame_codex_lnw/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-black?logo=apple" alt="macOS arm64 and x64">
  <img src="https://img.shields.io/badge/Windows-x64-0078d4?logo=windows11" alt="Windows x64">
  <img src="https://img.shields.io/badge/Linux-x64-fcc624?logo=linux&logoColor=black" alt="Linux x64">
  <img src="https://img.shields.io/badge/Free_AI-no_API_fees-10a37f" alt="Free AI with no API fees">
</p>

Free 和 Go 账户会在 Codex 原生模型选择器中看到 **ChatGPT Web — Luna**。具有推理选择器的
账户仍会按订阅权限看到 **Instant**、**Medium**、**High**、**Extra High** 和 **Pro**。
桥接程序会把当前编译后的 Codex 任务上下文发送到一个全新的 ChatGPT 临时聊天，附加图片，
并将可见的推理过程、工具活动和 Markdown 流式传回同一个 Codex 任务。

<p align="center">
  <img src="assets/demo.gif" alt="ChatGPT Web 实时轮次正在使用原生 Codex harness" width="960">
</p>

```text
Codex task ──Responses + SSE──▶ codex-chatgpt-web ──embedded browser──▶ ChatGPT
     ▲                                │                                      │
     └──────── native UI, context, images, tracing, and tool lifecycle ──────┘
```

Codex 会保留原生任务、上下文生命周期、界面和工具 harness。本地 Responses 桥接程序只会将
所选模型的任务转发到与该任务绑定的 ChatGPT 临时聊天；在完整模式下，MCP 会把 ChatGPT 连接回
同一个 Codex 任务的工具，直到下一次上下文压缩边界。

> [!TIP]
> 能够近实时改变 ChatGPT/Codex 声音的本地应用。它不会接触你的账户、浏览器会话或 ChatGPT
> 请求，因此不会带来账户封禁风险。如果你喜欢我的作品，欢迎试用。

## 免责声明

本项目是独立软件，与 OpenAI 无关联，也未获得 OpenAI 背书。请仅使用自己的账户，并遵守适用的
[使用条款](https://openai.com/policies/terms-of-use/)和工作区政策；本项目不会绕过身份验证或
访问控制。
