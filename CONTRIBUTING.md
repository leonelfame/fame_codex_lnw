# Contributing

Keep the project narrow: ChatGPT web-backed Codex models only. Generic providers and unrelated
OpenCodex product surfaces are out of scope.

Before opening a pull request:

1. Run `bun install --frozen-lockfile` and `bun run verify` on macOS.
2. Add a focused regression test for protocol, compaction, MCP, browser parsing, or installer changes.
3. Do not commit cookies, browser state, tunnel ids, API keys, local absolute paths, or generated logs.
4. Preserve fail-closed behavior. A UI selector failure must not pick another model or claim success.
5. Keep Terms/trademark claims factual and never market the project as quota or rate-limit bypass.

Browser UI changes should include the exact observed DOM evidence and a reproducible test fixture.
Do not broaden selectors speculatively.
