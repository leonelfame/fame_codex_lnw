<h1 align="center">codex-chatgpt-web</h1>

<p align="center">
  <strong>Use ChatGPT Pro as a native Codex model.</strong><br>
  Keep Codex's model picker, context, compaction, images, streaming, and task history. Change the model—not your workflow.
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml"><img src="https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/macOS-arm64%20%7C%20Intel-black?logo=apple" alt="macOS arm64 and Intel">
</p>

<p align="center"><code>curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install.sh | sh -s -- --pro-only --acknowledge-unofficial</code></p>

<p align="center"><sub>One binary · one ChatGPT login window · no API key or tunnel in Pro-only mode</sub></p>

**Codex has the harness. ChatGPT has Pro. This connects them.**

Open a normal Codex task, choose **ChatGPT Pro (web)** in the native model picker, and keep working
in the same Codex UI. The bridge replays the complete task context into a fresh ChatGPT Temporary
Chat and streams the result back through Codex's native Responses protocol.

```text
Codex task ──Responses + SSE──▶ codex-chatgpt-web ──controlled browser──▶ ChatGPT
     ▲                                │                                      │
     └──── native text, reasoning, images, compaction, and tool lifecycle ───┘
```

## Choose a mode

| Mode | Native picker | Context and images | Local Codex tools | Tunnel |
| --- | --- | --- | --- | --- |
| **Pro-only** | `ChatGPT Pro (web)` | Full | No, with a visible warning | None |
| **Full harness** | `ChatGPT 5.6 (web + Codex tools)` plus Pro | Full | Yes, in the same ChatGPT response | Official OpenAI tunnel-client |

Pro is intentionally read-only with respect to the local computer: it receives all context already
collected by Codex, but it cannot request another local tool call. Full harness mode adds the
standard ChatGPT model with the Codex tool loop; the separate Pro entry remains read-only.

## Install Pro

Current release target: macOS arm64 and Intel. Google Chrome is the only external runtime
dependency.

```bash
curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install.sh \
  | sh -s -- --pro-only --acknowledge-unofficial
```

Then:

1. Sign in to ChatGPT in the single Chrome window opened by setup.
2. Let setup finish.
3. Restart the Codex app once.
4. Pick **ChatGPT Pro (web)** from the native model picker.

That command downloads one checksum-verified standalone executable, stores private browser state
under `~/.codex-chatgpt-web`, installs a user launchd service, and applies a reversible Codex model
catalog/config patch. It does **not** install Node, Bun, Go, OpenCodex, or a Playwright browser.

Normal use reuses one long-lived Chrome process. It does not repeat setup or create a new browser
window for every tool call. Run `codex-chatgpt-web login` only when the ChatGPT session expires.

## Enable the full Codex tool loop

Full mode uses the official [OpenAI tunnel-client](https://github.com/openai/tunnel-client). The
tunnel is outbound: it does not expose a public IP, open an inbound port, or require router
forwarding.

Full write/modify actions require a ChatGPT workspace and admin policy that permit them. OpenAI
currently documents those actions for Business and Enterprise/Edu workspaces; personal Pro is
limited to read/fetch MCP permissions. See the current
[developer mode and MCP apps documentation](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).

1. Create or choose a tunnel in [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels).
2. Create a runtime key with **Tunnels Read + Use** in [Platform API key settings](https://platform.openai.com/settings/organization/api-keys).
3. Install the binary:

   ```bash
   curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install.sh | sh
   ```

4. Import the key without echoing it or placing it in shell history, then run setup:

   ```bash
   ~/.local/bin/codex-chatgpt-web tunnel key-import
   ~/.local/bin/codex-chatgpt-web setup --full \
     --tunnel-id tunnel_0123456789abcdef0123456789abcdef \
     --acknowledge-unofficial
   ```

5. While `doctor` reports the tunnel ready, attach it to a ChatGPT connector named `Codex Native`
   in [ChatGPT connector settings](https://chatgpt.com/#settings/Connectors), scan its tools, and
   configure the intended workspace action permissions.
6. Restart Codex once.

Setup automates everything local: it downloads the pinned tunnel-client release, verifies its
published checksum, writes its profile, starts the outbound runtime, waits for health/readiness,
and only then enables the Codex catalog. Tunnel creation, runtime-key creation, and connector/admin
permissions remain account-level steps and cannot be created on the user's behalf.

Unexpected browser approval prompts fail closed by default. `--auto-approve-tool-calls` is an
explicit opt-in that selects **Allow once** only; it never grants a global permission.

## What stays native

- Codex model picker and task history
- complete system/developer/user context replay
- `previous_response_id` continuation and compaction v1/v2
- image attachments
- streamed Markdown, reasoning summaries, and final answers
- Codex-owned sandbox, approvals, command sessions, and tool results

The MCP server is a capability transport, not a second agent. ChatGPT remains the decision engine.
Each capability is opaque, bound to one outer Codex turn, expires, and is revoked at completion.
See the full [architecture](docs/architecture.md).

## Operations

```bash
codex-chatgpt-web doctor
codex-chatgpt-web service status
codex-chatgpt-web tunnel status       # full mode
codex-chatgpt-web browser check       # invisible Chrome smoke test
codex-chatgpt-web login               # refresh an expired ChatGPT session
codex-chatgpt-web uninstall --yes
```

Setup journals the exact previous `openai_base_url` and `model_catalog_json` values and restores
them on uninstall. It refuses to overwrite a different existing route unless
`--replace-codex-route` is explicit. Stop, restart, setup replacement, and uninstall also refuse to
proceed while either a Responses request or browser/tool turn is active.

## Development

```bash
bun install --frozen-lockfile
bun run verify
```

`verify` runs dependency auditing, strict TypeScript checking, 31 harness/MCP/config tests, a
compiled standalone Responses smoke test, and a real headless launch of system Chrome. The runtime
contains no generic provider registry, alternate LLM adapter, dashboard, or compatibility shim.

Maintainer details:

- [Architecture](docs/architecture.md)
- [Security model](docs/security-model.md)
- [Release checklist](docs/releasing.md)
- [Contributing](CONTRIBUTING.md)

## Security and limitations

- ChatGPT UI selectors can change without notice. UI drift fails explicitly; the runtime never
  silently changes model, effort, or transport.
- Browser state is equivalent to a sensitive login artifact. Never share or commit it.
- The Responses listener is loopback-only, but another process under the same local user can reach
  it. Use a trusted single-user workstation.
- Browser turns are serialized to protect one profile and prevent cross-turn transcript reuse.
- Managed background installation currently supports macOS only.

Report vulnerabilities according to [SECURITY.md](SECURITY.md) and review the complete
[security model](docs/security-model.md) before enabling full mode.

## Credits and disclaimer

Portions of the Responses translation, Codex catalog integration, and browser harness were adapted
from [OpenCodex](https://github.com/lidge-jun/opencodex) under the MIT license. See the complete
[third-party notices](LICENSES/NOTICE.md).

This is experimental, independent software. It is not affiliated with or endorsed by OpenAI, and
it is not an OpenAI API. Do not use it to evade usage limits or access controls. Before public
distribution, review OpenAI's current [Terms of Use](https://openai.com/policies/terms-of-use/),
the [Services Agreement](https://openai.com/policies/services-agreement/), and the project's
[release checklist](docs/releasing.md).
