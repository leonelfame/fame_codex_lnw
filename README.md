<h1 align="center">Fame Codex</h1>

<p align="center"><strong>Personal Codex launcher สำหรับใช้งาน ChatGPT Web ผ่าน native Codex workflow</strong></p>

<p align="center"><img src="assets/fame-codex-ui.png" alt="Fame Codex desktop launcher" width="960"></p>

Copyright (c) 2026 Fame Codex. Distributed under the MIT License.

> [!IMPORTANT]
> โครงการ Fame Codex สำหรับใช้งาน ChatGPT Web ผ่าน native Codex workflow และไม่ใช่ผลิตภัณฑ์อย่างเป็นทางการของ OpenAI

## จุดแตกต่าง

- แยก App ID, NSIS GUID, Install directory และ AppData จาก Codex Web GPT
- Runtime home: `%USERPROFILE%\.fame-codex`
- Launcher data: `%APPDATA%\Fame Codex`
- Responses API: `http://127.0.0.1:17842/v1`
- Connector: `Fame Codex Native2`
- DEV connector: `Fame Codex Native2 DEV`
- Updater ใช้ repository `leonelfame/fame_codex_lnw`
- คง logic หลักของ Responses bridge, Browser, Tunnel และ MCP

## ความต้องการระบบ

Building from source requires Bun 1.4.0.

- Windows 10 1809 ขึ้นไป
- Codex และบัญชี ChatGPT ที่พร้อมใช้งาน
- [Bun 1.4.0](https://bun.sh/docs/installation) สำหรับ Build จาก source

## ติดตั้งบน Windows

### จาก GitHub Release

เมื่อมี Release ที่เผยแพร่ installer และ `checksums.txt` แล้ว:

```powershell
irm https://github.com/leonelfame/fame_codex_lnw/releases/latest/download/install-launcher.ps1 | iex
```

หรือดาวน์โหลด `fame-codex-<version>-win-x64.exe` จาก Releases แล้วเลือก **Only for me**

ตำแหน่งที่ติดตั้งและเก็บข้อมูล:

```text
%LOCALAPPDATA%\Programs\Fame Codex
%APPDATA%\Fame Codex
%USERPROFILE%\.fame-codex
```

### Build Installer เอง

```powershell
git clone https://github.com/leonelfame/fame_codex_lnw.git
cd fame_codex_lnw
bun install --frozen-lockfile
bun install --cwd launcher --frozen-lockfile
bun run --cwd launcher package:win
```

Installer อยู่ที่ `launcher\artifacts\fame-codex-<version>-win-x64.exe` ปิด Fame Codex ก่อนติดตั้งทับเวอร์ชันเดิม

## เริ่มใช้งาน

1. เปิด Fame Codex และลงชื่อเข้าใช้ ChatGPT
2. กด **Run browser smoke test**
3. กด **Install models**
4. ปิด Codex ทุก process แล้วเปิดใหม่
5. เลือกโมเดล ChatGPT Web จาก model picker

Route ที่ติดตั้ง:

```toml
openai_base_url = "http://127.0.0.1:17842/v1"
```

พอร์ต `4178` เป็น Vite UI สำหรับ Development ไม่ใช่ Responses API

## ตรวจสอบ Runtime

เปิด Fame Codex ค้างไว้แล้วรัน:

```powershell
Test-NetConnection 127.0.0.1 -Port 17842
Invoke-RestMethod http://127.0.0.1:17842/healthz
Invoke-RestMethod http://127.0.0.1:17842/v1/models
```

`/healthz` ควรมี `status: ok`, `service: fame-codex`, `port: 17842` และ `accepting_turns: true`

## MCP / Tunnel

1. สร้าง OpenAI Tunnel และ API key ตามหน้า MCP
2. เชื่อม local harness
3. เปิด Developer Mode ใน ChatGPT
4. สร้าง Connector ชื่อ `Fame Codex Native2`
5. เลือก Tunnel และ Authentication ตามคำแนะนำ
6. กด **Verify runtime**

เก็บ Master connector `Codex Native2` ไว้โดยไม่ rename หรือ refresh

## ใช้ร่วมกับ Master

สองแอปติดตั้งพร้อมกันได้ แต่ Codex integration ใน `%USERPROFILE%\.codex\config.toml` ใช้งานได้ทีละตัว

1. เปิดแอปที่เป็นเจ้าของ route แล้วกด **Remove Codex integration**
2. เปิดอีกแอปแล้วกด **Install models**
3. ปิด Codex ทุก process แล้วเปิดใหม่

อย่าคอมเมนต์เฉพาะ `openai_base_url` เพราะ journal, model settings และ Interrupt hook ต้อง restore พร้อมกัน

| Launcher | Connector | Responses URL |
| --- | --- | --- |
| Codex Web GPT Master | `Codex Native2` | `http://127.0.0.1:17841/v1` |
| Fame Codex | `Fame Codex Native2` | `http://127.0.0.1:17842/v1` |

## Development

```powershell
bun run app
bun run launcher:typecheck
bun run launcher:test
bun run launcher:build
```

`bun run app` เปิด Vite/Electron DEV แบบ Tunnel-only และไม่ได้เปิด Responses API บนพอร์ต `4178`

## Security และ License

ห้าม commit API keys, Tunnel keys, cookies หรือ browser profile ดู [SECURITY.md](SECURITY.md), [TROUBLESHOOTING.md](TROUBLESHOOTING.md) และ [docs/security-model.md](docs/security-model.md)

พัฒนาต่อยอดภายใต้ MIT License: [LICENSE](LICENSE), [FAME_CODEX_NOTICE.md](FAME_CODEX_NOTICE.md), [Third-party notices](LICENSES/)
