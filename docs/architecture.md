# Architecture

```text
Codex app / CLI
      │ Responses API on loopback
      ▼
codex-chatgpt-web daemon
  ├─ Responses parser + native SSE bridge
  ├─ ChatGPT browser worker (one Chrome process, one turn at a time)
  ├─ capability broker (full mode only)
  └─ stdio MCP server
            ▲
            │ outbound OpenAI Tunnel
            ▼
      ChatGPT custom connector
```

## Modes

### `browser-only`

- Exposes one `chatgpt-web/gpt-5.6-sol` model with Light, Medium, High, Extra High, and Pro efforts.
- Sends the complete Codex context and image attachments to a fresh ChatGPT Temporary Chat.
- Never starts the broker, tunnel, or MCP server.
- Emits a nonfatal Codex commentary warning that local tools are unavailable for the selected effort.

### `full`

- Exposes the same single model and effort list; Light through Extra High are tool-capable, while
  Pro remains read-only.
- ChatGPT uses a custom MCP connector backed by `openai/tunnel-client`.
- Every connector call is bound to one outer Codex turn capability.
- Tool calls and results remain in the same ChatGPT response while Codex executes them locally.

## Browser lifecycle

Playwright CLI is a development/debugging tool and is not part of the runtime. The daemon owns one
long-lived Chrome process. A Codex turn gets a fresh Temporary Chat page; the preceding page is
closed. This prevents transcript leakage without creating a new Chrome window per tool call.

## Installation and service lifecycle

The release artifact is a versioned runtime bundle containing a pinned Bun executable and the
bundled application. It contains the Responses bridge, Playwright client code, MCP server, setup,
doctor, and launchd management; it uses the user's installed Google Chrome and does not download a
second browser. Full mode separately downloads the official pinned `openai/tunnel-client` release
and verifies it against that release's published SHA-256 manifest.

Setup creates a user launchd service for the Responses proxy. Full mode also creates a separate
launchd service that runs `tunnel-client` directly from its generated profile. Both use `RunAtLoad`
and `KeepAlive`; no shell, terminal, tmux session, or manual post-login command owns production
lifecycle. Setup only journals and switches Codex's two integration keys after required services
report healthy and ready.

Setup never restarts an already loaded daemon implicitly. A requested stop, restart, replacement,
or uninstall first calls a private authenticated drain endpoint. The daemon rejects new turns and
reports two independent counters:

- active Responses/compaction HTTP requests;
- active ChatGPT browser sessions, including time spent waiting for local Codex tool results.

The lifecycle operation proceeds only when both counters are zero. If the contract is unavailable,
malformed, or non-idle, the operation fails closed and resumes the old daemon when possible.

## Security invariants

- Bind the Responses proxy and health endpoint to loopback only.
- Store browser state and tunnel credentials under the application home with mode `0600`.
- Protect lifecycle control endpoints with a random application-owned bearer token.
- Never place secret values in command-line arguments, logs, generated profiles, or Git.
- Serialize browser turns and reject unsupported models or efforts explicitly.
- Do not retry or switch modes to evade product usage limits.

See the complete [security model](security-model.md).
