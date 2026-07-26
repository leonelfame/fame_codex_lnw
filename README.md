# codex-chatgpt-web

An independent, focused bridge that exposes two ChatGPT web-backed models in the native Codex
model picker while preserving Codex's Responses protocol, context replay, compaction, streaming,
reasoning summaries, images, and outer tool lifecycle.

This is experimental, unofficial software. It is not affiliated with or endorsed by OpenAI. It
automates a user-controlled ChatGPT browser session; it is not an OpenAI API and must not be used
to evade usage limits or access controls. Read the [public release gate](PUBLIC_RELEASE_CHECKLIST.md)
before publishing or distributing it.

## What is actually installed

| Mode | Native picker entry | Context and images | Local Codex tools | Tunnel |
| --- | --- | --- | --- | --- |
| `pro-only` | `ChatGPT Pro (web)` | Yes | No, with a visible nonfatal warning | None |
| `full` | `ChatGPT 5.6 (web + Codex tools)` and Pro | Yes | Yes, in the same ChatGPT response | Official `openai/tunnel-client` |

The release is one standalone macOS executable. End users do not install Bun, Node.js, Go,
Playwright browsers, or OpenCodex. Google Chrome is the only external runtime dependency.

Playwright's development/debug windows are not part of production. Setup opens one controlled
Chrome window for ChatGPT login. The daemon then owns one long-lived Chrome process and serializes
browser turns. Each Codex turn gets a fresh Temporary Chat page; MCP tool calls stay inside that
same ChatGPT response instead of opening another chat per tool result.

## Install

Current release target: macOS arm64 and Intel.

### Fast path: Pro only

```bash
curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install.sh \
  | sh -s -- --pro-only --acknowledge-unofficial
```

Sign in once in the Chrome window, let setup finish, then restart the Codex app once. The model
appears in the native picker.

### Full Codex tools

Full mode uses OpenAI's outbound tunnel client. It does not expose a public IP, open an inbound
port, or require router/firewall forwarding.

It also requires a ChatGPT workspace that can use full MCP actions. OpenAI currently documents
write/modify MCP support for Business and Enterprise/Edu workspaces; personal Pro is limited to
read/fetch permissions. Workspace developer mode and connector/action-control access must be
enabled by the appropriate admin. See OpenAI's
[developer mode and MCP apps documentation](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).

1. Create or choose a tunnel in [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels).
2. Create a runtime key with **Tunnels Read + Use** in [Platform API key settings](https://platform.openai.com/settings/organization/api-keys).
3. Install the binary without running setup yet:

```bash
curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install.sh | sh
```

4. Import the runtime key without echoing it or placing it in shell history, then run setup:

```bash
~/.local/bin/codex-chatgpt-web tunnel key-import
~/.local/bin/codex-chatgpt-web setup --full \
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef \
  --acknowledge-unofficial
```

5. While `doctor` reports the tunnel ready, attach that tunnel to a ChatGPT connector named
   `Codex Native` at [ChatGPT connector settings](https://chatgpt.com/#settings/Connectors), scan
   its tools, and configure the workspace action permissions you intend to allow.
6. Restart Codex once.

The account-level tunnel, runtime-key, and connector permissions cannot be manufactured locally;
those are the only manual full-mode steps.

By default the bridge refuses an unexpected per-call confirmation instead of clicking through it.
If the workspace cannot configure action control and the user explicitly accepts per-call browser
approval, rerun setup with `--auto-approve-tool-calls`; this selects only **Allow once**, never a
global permission.

## Operations

```bash
codex-chatgpt-web doctor
codex-chatgpt-web service status
codex-chatgpt-web tunnel status       # full mode
codex-chatgpt-web browser check       # invisible local Playwright/Chrome smoke test
codex-chatgpt-web login               # refresh expired ChatGPT login
codex-chatgpt-web uninstall --yes
```

Private state lives under `~/.codex-chatgpt-web` with user-only permissions. Setup modifies only
the top-level `openai_base_url` and `model_catalog_json` values in `~/.codex/config.toml`, writes a
journal of the exact prior values, and restores them during uninstall. If either value changes
after setup, uninstall fails closed instead of overwriting the user's newer configuration.

Service-changing operations use an authenticated drain handshake. The daemon first stops accepting
new Responses requests and reports both active HTTP work and the live browser/tool loop. Restart,
stop, setup replacement, and uninstall refuse to continue unless both counters are exactly zero;
they never kill an in-progress Codex turn. Runtime-changing setup also requires the explicit
`--restart-service` flag, so rerunning setup cannot silently replace the process underneath the
task issuing the command.

If Codex already points at another Responses proxy, setup stops and asks for the explicit
`--replace-codex-route` flag. Replacement remains journaled and reversible.

## How the harness works

```text
Codex app / CLI
    │ native Responses API + SSE
    ▼
codex-chatgpt-web (127.0.0.1 only)
    ├── context replay + remote compaction v1/v2
    ├── one serialized Chrome worker
    ├── Markdown/reasoning/image streaming
    └── turn-bound capability broker
             ▲
             │ stdio MCP over outbound OpenAI tunnel
             ▼
      ChatGPT custom connector
```

The MCP server does not become a second agent. ChatGPT remains the decision engine. The bridge
only transports exact Codex tool definitions and results, enforces the active Codex sandbox/workspace
boundary, and renders each requested call back into Codex's native tool lifecycle. A capability is
opaque, bound to one Codex turn, expires, and is revoked at completion.

Pro is deliberately separate. ChatGPT Pro's UI mode does not expose the custom connector tool in
this flow, so Pro receives the complete accumulated Codex context and images but no capability.
The response begins with a visible Codex commentary warning; there is no silent downgrade to
another reasoning level or model.

## Development

```bash
bun install --frozen-lockfile
bun run verify
```

`verify` performs strict TypeScript checking, 31 focused harness/MCP/config tests, creates the
standalone binary, starts that binary against an isolated home, probes its Responses surface, and
launches system Chrome headlessly through the compiled Playwright bundle.

The runtime intentionally contains no generic model registry, OAuth provider pool, alternate LLM
adapters, OpenCodex dashboard, or compatibility shim. The Responses translation and browser harness
retain OpenCodex attribution under the MIT license; see [NOTICE.md](NOTICE.md).

## Publishing a release

The repository is prepared for `miuuyy/codex-chatgpt-web`, but no remote repository is created by
the source tree itself.

```bash
git init
git add .
git commit -m "Initial standalone ChatGPT web harness"
gh repo create miuuyy/codex-chatgpt-web --public --source=. --remote=origin --push
git tag v0.1.0
git push origin v0.1.0
```

The tag workflow builds and smoke-tests native arm64 and Intel binaries, ad-hoc signs each Mach-O,
creates SHA-256 checksums, packages license notices, and creates a **draft** GitHub release with
`install.sh`. Review the release gate before publishing that draft. Developer ID signing and
notarization remain a gate until the corresponding Apple credentials are configured.

Before making it public, review OpenAI's current [Terms of Use](https://openai.com/policies/terms-of-use/),
the [Services Agreement](https://openai.com/policies/services-agreement/), and this project's
[release checklist](PUBLIC_RELEASE_CHECKLIST.md). Do not describe the project as a quota bypass.

## Security and limitations

- ChatGPT UI selectors can change without notice. Failures are explicit; the runtime never silently
  changes model, effort, or transport.
- Browser state is equivalent to a sensitive login artifact. Do not share or commit it.
- The Responses listener is loopback-only, but another process running as the same local user can
  reach it. Use a trusted single-user workstation.
- Browser turns are serialized. This protects one browser profile and avoids accidental cross-turn
  transcript reuse, at the cost of local concurrency.
- Version `0.1` supports managed background installation on macOS only. Other platforms fail
  explicitly instead of installing an untested service fallback.

Report security issues according to [SECURITY.md](SECURITY.md).
The complete trust-boundary analysis is in [THREAT_MODEL.md](THREAT_MODEL.md).
