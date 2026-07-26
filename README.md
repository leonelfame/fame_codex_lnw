<h1 align="center">codex-chatgpt-web</h1>

<p align="center">
  <strong>Use ChatGPT Web—including Pro—as native Codex models.</strong><br>
  Keep Codex's model picker, complete context, images, streaming, tracing, and task history. Change the model—not your workflow.
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml"><img src="https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/macOS-arm64%20%7C%20Intel-black?logo=apple" alt="macOS arm64 and Intel">
</p>

<p align="center"><code>curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install.sh | sh -s -- --browser-only --acknowledge-unofficial</code></p>

<p align="center"><sub>One runtime bundle · one ChatGPT login window · no API key or tunnel in browser-only mode</sub></p>

**Codex has the harness. ChatGPT has Pro. This connects them.**

Open a normal Codex task, choose **ChatGPT Web — Light**, **Medium**, **High**, **Extra High**, or
**Pro** in the native model picker, and keep working in the same Codex UI. Each model has one fixed
browser mode. The bridge replays the complete task
context into a fresh ChatGPT Temporary Chat and streams the result back through Codex's native
Responses protocol.

```text
Codex task ──Responses + SSE──▶ codex-chatgpt-web ──controlled browser──▶ ChatGPT
     ▲                                │                                      │
     └──── native text, visible trace, images, and tool lifecycle ──────────┘
```

## Choose a mode

| Mode | Native picker | Context and images | Local Codex tools | Tunnel |
| --- | --- | --- | --- | --- |
| **Browser-only** | Four fixed models + Pro when available | Full | No, with a visible warning | None |
| **Full harness** | The same fixed models | Full | Light–Extra High: yes; Pro: read-only | Official OpenAI tunnel-client |

Codex Desktop always renders an Effort row for custom models. Every ChatGPT Web model therefore
advertises exactly one immutable protocol effort; the model selection is authoritative. The Pro
model uses Codex's `ultra` wire value and binds explicitly to ChatGPT **Pro**. Pro is intentionally
read-only with respect to the local computer: it receives all context already
collected by Codex, but it cannot request another local tool call. Full harness mode attaches the
Codex tool loop to Light, Medium, High, and Extra High. The selected model never changes silently.

## Install without local tools

Current release target: macOS arm64 and Intel. Google Chrome is the only external runtime
dependency.

```bash
curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install.sh \
  | sh -s -- --browser-only --acknowledge-unofficial
```

Then:

1. Sign in to ChatGPT in the single Chrome window opened by setup.
2. Let setup finish.
3. Restart the Codex app once.
4. Pick one of the **ChatGPT Web — …** models. **ChatGPT Web — Pro** appears only when setup
   detected that Pro is available in the authenticated account.

That command downloads one checksum-verified, versioned runtime bundle, stores private browser
state under `~/.codex-chatgpt-web`, installs a user launchd service, and applies a reversible Codex
`openai_base_url` route. The proxy forwards Codex's official `/models` response unchanged and
appends four fixed ChatGPT Web entries plus the account-gated Pro entry when available; it never
generates or replaces the native catalog. The service starts after macOS login and restarts after
a crash; normal
use requires no terminal command. It does **not** require a system Node/Bun/Go runtime, OpenCodex,
or a Playwright browser download.

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
published checksum, writes its profile, installs separate proxy and tunnel launchd services, waits
for health/readiness, and only then enables the Codex route. Both services start after macOS login
and are restarted by launchd after a crash. Tunnel creation, runtime-key creation, and
connector/admin permissions remain account-level steps and cannot be created on the user's behalf.

Unexpected browser approval prompts fail closed by default. `--auto-approve-tool-calls` is an
explicit opt-in that selects **Allow once** only; it never grants a global permission.

## What stays native

- Codex model picker and task history
- complete system/developer/user context replay
- `previous_response_id` continuation
- ChatGPT-owned internal compaction surfaced as a visible trace checkpoint
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

Setup journals the exact previous `openai_base_url`, `model_provider`, and `model_catalog_json`
assignments and restores them on uninstall. During normal operation, only `openai_base_url` is
active, so Codex keeps its built-in `openai` provider, native task history, and live model catalog.
Setup refuses to overwrite a different existing route unless
`--replace-codex-route` is explicit. Stop, restart, setup replacement, and uninstall also refuse to
proceed while either a Responses request or browser/tool turn is active.

When migrating from another Codex proxy, remove it first or explicitly allow this setup to replace
its routing assignments reversibly:

```bash
codex-chatgpt-web setup --browser-only \
  --replace-codex-route \
  --acknowledge-unofficial
```

## Development

```bash
bun install --frozen-lockfile
bun run verify
```

`verify` runs dependency auditing, strict TypeScript checking, harness/MCP/config tests, a
relocatable runtime smoke test, and a real headless launch of system Chrome. The runtime
contains no generic provider registry, alternate LLM adapter, dashboard, or compatibility shim.

Maintainer details:

- [Architecture](docs/architecture.md)
- [Security model](docs/security-model.md)
- [Release checklist](docs/releasing.md)
- [Contributing](CONTRIBUTING.md)

## Security and limitations

- ChatGPT UI selectors can change without notice. UI drift fails explicitly; the runtime never
  silently changes model, effort, or transport.
- Current Codex Desktop always shows an Effort row and hardcodes `ultra` as **Ultra**. Each routed
  model exposes only its one fixed value, so the row cannot change the selected browser mode. The
  app also always shows a **Standard** speed row even though ChatGPT Web sends no service tier.
  The model catalog cannot rename or hide these controls; patching the signed app is out of scope.
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
