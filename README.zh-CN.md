<h1 align="center">ChatGPT Web for Codex</h1>

<p align="center">
  <strong>将 ChatGPT Web（包括 Pro）作为 Codex 原生模型使用。</strong><br>
  切换模型档位，保留原有工作流。
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml"><img src="https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-black?logo=apple" alt="macOS arm64 and x64">
  <img src="https://img.shields.io/badge/Windows-x64-0078d4?logo=windows11" alt="Windows x64">
  <img src="https://img.shields.io/badge/Linux-x64-fcc624?logo=linux&logoColor=black" alt="Linux x64">
  <img src="https://img.shields.io/badge/Free_AI-no_API_fees-10a37f" alt="Free AI with no API fees">
</p>

在 Codex 原生模型选择器中选择 **ChatGPT Web — Instant**、**Medium**、**High**、
**Extra High** 或 **Pro**。桥接程序会把完整的 Codex 任务上下文发送到一个全新的
ChatGPT 临时聊天，附加图片，并将可见的推理过程、工具活动和 Markdown 流式传回同一个
Codex 任务。

<p align="center">
  <img src="assets/demo.gif" alt="ChatGPT Web 在原生 Codex harness 中运行" width="960">
</p>

```text
Codex task ──Responses + SSE──▶ codex-chatgpt-web ──embedded browser──▶ ChatGPT
     ▲                                │                                      │
     └──────── native UI, context, images, tracing, and tool lifecycle ──────┘
```

## 亮点

- **精致的跨平台启动器。** 一条命令即可安装原生 macOS、Windows 或 Linux 应用。登录、设置、
  冒烟测试、MCP 指南、运行状态和本地日志都集中在同一处；内置浏览器还能让你实时看到每个
  ChatGPT 轮次的执行过程。
- **原生 Codex harness。** 使用的仍然是你熟悉的 Codex 模型选择器、任务历史、上下文生命周期、
  审批、沙箱、流式输出、追踪和工具界面，而不是另一个聊天客户端。与 OpenCodex 类似，
  它只更换模型后端，同时保留原生工作流。
- **本地优先的任务会话。** Codex 仍然是电脑上任务历史的真实来源。每个浏览器轮次都会从一个
  全新的 ChatGPT 临时聊天开始，并接收完整的累计 Codex 上下文，因此浏览器聊天不会在任务之间
  复用，也不会加入普通 ChatGPT 历史记录。
- **通过 MCP 使用完整 Codex harness。** 在完整模式下，Instant 到 Extra High 可以通过 MCP
  使用当前 Codex 任务的文件系统、shell、图片、审批以及已配置的工具和应用。调用及其真实结果
  会留在同一个浏览器响应中，不会被模拟成文本。
- **Pro 仍然实用。** Pro 是唯一的例外：ChatGPT 当前的 Pro 模式不会暴露此桥接程序所需的自定义
  MCP 连接器。它的原生能力（包括网页搜索和研究）仍然可用。你可以先用 Instant 到 Extra High
  收集本地工作区上下文，再切换到 Pro；Pro 会收到完整的累计 Codex 任务，用于更深入的分析。
- **故障时明确失败，并经过人工测试。** 模型选择、超长内联上下文、图片、流式输出、可见追踪、
  上下文压缩、原生工具轮次、取消操作和 Pro 均已在 macOS 上完成端到端测试。UI 变化或能力缺失
  会产生明确错误，而不是静默回退。

临时聊天是 ChatGPT 的隐私模式，并不代表匿名或仅在本地推理：提示仍会由 OpenAI 处理，并受账户
设置及 OpenAI [临时聊天政策](https://help.openai.com/en/articles/8914046-temporary-chat-faq)
约束。本项目为非官方项目；用户仍需自行遵守适用的 OpenAI 条款和工作区政策。

## 快速开始

安装桌面启动器：

**macOS 或 Linux**

```bash
curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.sh | sh
```

**Windows PowerShell**

```powershell
irm https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.ps1 | iex
```

然后在应用中完成三项检查：

1. 在内置浏览器中登录 ChatGPT。
2. 运行浏览器冒烟测试。
3. 点击 **安装模型**，重启一次 Codex，然后选择一个 **ChatGPT Web — …** 模型。

只有已登录账户支持 Pro 时，Pro 才会显示。独立的 **MCP** 页面是可选项，它会在不需要终端命令
的情况下引导你完成完整 harness 设置。

启动器是默认使用方式：浏览器登录、模型安装、可选 MCP 指南、运行状态、日志和更新都集中在同一
界面。它统一管理内置浏览器、登录 profile、Responses 代理、Tunnel 进程以及 macOS、Windows
和 Linux 的登录启动项。打包后的仅浏览器模式不需要 Google Chrome、模型 API 密钥、系统级
Node/Bun、OpenCodex 或单独下载 Playwright 浏览器。

**从源码运行**

```bash
git clone https://github.com/miuuyy/codex-chatgpt-web.git && \
cd codex-chatgpt-web && \
bun run app
```

源码方式需要 Bun 1.3.11。该命令会安装锁定版本的依赖并打开应用。

<details>
<summary>高级：仅终端安装</summary>

```bash
curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install.sh \
  | sh -s -- --browser-only --acknowledge-unofficial
```

此旧版 macOS 专用模式使用独立管理的 Chrome 窗口，而不是启动器。

</details>

## 模式

| 模式 | 模型 | 本地 Codex 工具 | 额外设置 |
| --- | --- | --- | --- |
| **仅浏览器** | Instant 到 Pro | 不可用；Codex 会显示警告 | 无 |
| **完整 harness** | Instant 到 Pro | Instant–Extra High：可用；Pro：只读 | OpenAI 隧道 + ChatGPT 连接器 |

模型选择器中的每一项都对应一个固定的 ChatGPT 模式。Codex 仍会显示内置的 Effort 和 Speed
选项，但更改它们不会在后台静默切换所选的浏览器模型。Pro 会收到 Codex 已经收集的完整上下文，
但 ChatGPT Pro 无法主动发起本地 MCP/工具调用。

代理保留 Codex 内置的 `openai` provider 和实时模型目录。它会原样转发官方目录，只附加自己的
ChatGPT Web 条目，因此原生模型、任务历史、审批、沙箱和工具结果仍由 Codex 管理。

## 完整 harness

完整模式通过官方
[OpenAI tunnel-client](https://github.com/openai/tunnel-client)
将 ChatGPT 的工具调用连接回当前 Codex 任务。该隧道为出站连接：不会暴露公网 IP、开放入站端口，
也不需要配置路由器端口转发。

1. 完成启动器中的必需设置。
2. 在启动器中打开 **MCP**。请在将使用 ChatGPT 连接器的同一个 OpenAI 账户中创建 Tunnel
   和普通 API 密钥；创建密钥本身免费，也不会消耗模型 API 额度。
3. 粘贴 Tunnel ID 和 API 密钥，然后点击 **连接 Harness**。
4. 在 ChatGPT 设置中启用 **开发者模式**。创建连接器时选择 **Tunnel**，选择刚创建的
   Tunnel，将 **身份验证** 设为 **无**，并将连接器准确命名为 `Codex Native`。
5. 扫描工具，选择需要的操作权限，然后运行 **验证运行时**。验证过程会打开 `@c` 菜单并选择
   精确匹配的 `Codex Native` 项。

写入/修改操作需要 ChatGPT 工作区及管理员政策允许。OpenAI 目前仅为 Business 和
Enterprise/Edu 工作区说明了这些操作；个人 Pro 账户仅限 read/fetch MCP 权限。请参阅
[开发者模式和 MCP 应用](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)。
除非显式启用 `--auto-approve-tool-calls`，否则意外的审批提示会直接失败；该选项只会点击
**Allow once**，绝不会授予永久权限。

## 日常操作

在 **活动** 页面查看结构化本地日志，在 **设置 → 运行诊断** 中执行端到端健康检查。如果 Codex
任务已停止，但 ChatGPT 在原生工具轮次之间仍在工作，请使用
**设置 → 取消残留的浏览器任务**，然后重试操作。删除启动器前，请使用
**设置 → 移除 Codex 集成**；它会先排空运行时并恢复此前的 Codex 路由。

核心私有状态位于 `~/.codex-chatgpt-web`；ChatGPT 登录保存在启动器的私有 Electron profile
中。设置会记录此前的 Codex 路由，以便可逆恢复。启动器不会替换无关路由，并且只要 HTTP 任务
或浏览器/工具任务仍在活动，就会拒绝停止、更新或退出。

<details>
<summary>高级 CLI 诊断</summary>

```bash
codex-chatgpt-web doctor
codex-chatgpt-web service status
codex-chatgpt-web tunnel status
codex-chatgpt-web browser check
codex-chatgpt-web service cancel-turns
codex-chatgpt-web uninstall --yes       # 仅终端安装
```

</details>

## 限制和安全性

- 这是非官方浏览器自动化，并非 OpenAI API。ChatGPT UI 变更可能破坏选择器；发生变化时会明确
  失败，而不是静默切换模型或传输方式。
- 浏览器状态是敏感的登录凭据。切勿共享启动器 profile 或应用数据目录。
- Responses 监听器只绑定到 loopback，但以同一本地用户身份运行的其他进程仍可访问它。
  请仅在可信的单用户工作站上使用。
- 浏览器轮次会串行执行，以保护单一 profile 并防止任务之间复用对话内容。
- 发布包目前支持 macOS 13+（arm64/x64）、Windows x64 和 Linux x64。浏览器流程已在 macOS
  上完成手动端到端测试；核心运行时、测试和原生打包会在 CI 中对三种操作系统进行检查。
- 在为发布配置平台签名证书之前，macOS Gatekeeper 或 Windows SmartScreen 可能会显示未知发布者
  警告。一键安装脚本会在安装前验证发布的 SHA-256 清单。
- Codex Desktop 会将 Pro 的 wire effort 固定显示为 **Ultra**，并始终显示 **Standard** speed。
  这些控件不会改变固定的 ChatGPT Web 模型；重命名它们需要修改已签名的 Codex 应用。
- 高级的仅终端 Chrome 模式仍仅支持 macOS。

启用完整模式前，请阅读完整的[架构说明](docs/architecture.md)和
[安全模型](docs/security-model.md)。安全漏洞请通过 [SECURITY.md](SECURITY.md) 报告。

## 开发

```bash
bun run app
bun run verify
bun run app:package
```

`app` 会安装锁定版本的根目录和启动器依赖，并打开开发构建。`verify` 会运行依赖审计、严格
TypeScript 检查、核心与启动器测试、生产 renderer 构建、可重定位运行时冒烟测试，以及 macOS
上的真实系统 Chrome 无头检查。`app:package` 会为当前操作系统创建原生安装包；由于每个应用
都会嵌入对应平台的 Bun 运行时，因此拒绝跨平台打包。

- [架构说明](docs/architecture.md)
- [安全模型](docs/security-model.md)
- [贡献指南](CONTRIBUTING.md)

## 致谢与免责声明

Responses 转换、Codex 目录集成和浏览器 harness 的部分代码依据 MIT 许可证改编自
[OpenCodex](https://github.com/lidge-jun/opencodex)。详情请参阅
[第三方声明](LICENSES/NOTICE.md)。

本项目是实验性的独立软件，与 OpenAI 无关联，也未获得 OpenAI 背书。不得使用本项目规避使用限制
或访问控制。在公开分发前，请查阅 OpenAI 当前的
[使用条款](https://openai.com/policies/terms-of-use/)和
[服务协议](https://openai.com/policies/services-agreement/)。
