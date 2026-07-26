# Repository guidance

- Keep this repository focused on the ChatGPT web-backed Codex models. Do not add generic LLM providers.
- Model selection is explicit. Never silently fall back to another model or reasoning level.
- Full mode exposes local tools only through the outer Codex tool registry and the official MCP tunnel.
- Pro-only mode must never create a broker capability or attach an MCP connector.
- Never commit browser state, API keys, tunnel IDs, cookies, Codex history, or absolute user paths.
- Use `bun run verify` before handoff.
- Use `apply_patch` for targeted source edits.
