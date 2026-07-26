# Release checklist

This project automates a consumer ChatGPT web session. OpenAI's current Terms of Use prohibit
programmatic extraction of Output and circumvention of rate limits or restrictions. A public
release therefore requires an explicit maintainer decision and, ideally, written confirmation
from OpenAI that the intended interoperability pattern is permitted.

Before making the repository public:

- [ ] Obtain a terms/policy review for browser automation and subscription-backed model access.
- [ ] Never market the project as quota bypass, rate-limit bypass, or an unofficial ChatGPT API.
- [ ] Confirm that the user supplies and controls their own ChatGPT and Platform accounts.
- [ ] Keep concurrency at one browser turn and surface all upstream usage-limit errors unchanged.
- [ ] Confirm `openai/tunnel-client` availability for the intended users and organizations.
- [ ] State the current ChatGPT plan/admin limits for full MCP write/modify actions.
- [ ] Run `bun run verify` on the supported macOS arm64 and Intel targets.
- [ ] Build release binaries in GitHub Actions and publish SHA-256 checksums.
- [ ] Run a clean-home Pro install/login/turn/uninstall test on both supported architectures.
- [ ] Run a clean-home full-mode tunnel/connector/multi-tool/uninstall test on both architectures.
- [ ] Verify setup, restart, stop, and uninstall refuse while a browser/tool turn is active.
- [ ] Run a secret scan and inspect the source archive manually.
- [ ] Review `LICENSES/NOTICE.md`, trademark wording, bundled npm licenses, and Bun/JSC LGPL
      relinking obligations.
- [ ] Configure Developer ID signing and notarization, or document the unsigned alpha decision
      explicitly.
