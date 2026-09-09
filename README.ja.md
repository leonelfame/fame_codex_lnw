<h1 align="center">Codex 用 ChatGPT Web</h1>

<p align="center">
  <strong>ChatGPT Web（Pro を含む）を Codex のネイティブモデルとして使用。</strong><br>
  モデルの利用枠を切り替えて、いつものワークフローを維持できます。
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <a href="TROUBLESHOOTING.md">トラブルシューティング</a> · <a href="SECURITY.md">セキュリティ</a> · <a href="CONTRIBUTING.md">コントリビューション</a>
</p>

<p align="center">
  <a href="https://github.com/leonelfame/fame_codex_lnw/actions/workflows/ci.yml"><img src="https://github.com/leonelfame/fame_codex_lnw/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT ライセンス"></a>
  <img src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-black?logo=apple" alt="macOS arm64 および x64">
  <img src="https://img.shields.io/badge/Windows-x64-0078d4?logo=windows11" alt="Windows x64">
  <img src="https://img.shields.io/badge/Linux-x64-fcc624?logo=linux&logoColor=black" alt="Linux x64">
  <img src="https://img.shields.io/badge/Free_AI-no_API_fees-10a37f" alt="API 料金なしの AI">
</p>

Free および Go アカウントでは、Codex のネイティブモデル選択画面に
**ChatGPT Web — Luna** が追加されます。reasoning セレクターが表示されるアカウントでは、
サブスクリプションで利用可能な **Instant**、**Medium**、**High**、**Extra High**、**Pro** を使用できます。
ブリッジは、コンパイル済みの現在の Codex タスクコンテキストを新しい ChatGPT 一時チャットへ送り、
画像を添付し、表示される reasoning、ツールアクティビティ、Markdown を同じ Codex タスクへストリーミングします。

<p align="center">
  <img src="assets/demo.gif" alt="ネイティブ Codex ハーネスを使用する ChatGPT Web ターン" width="960">
</p>

```text
Codex タスク ──Responses + SSE──▶ codex-chatgpt-web ──内蔵ブラウザー──▶ ChatGPT
      ▲                                  │                              │
      └──── ネイティブ UI、コンテキスト、画像、トレース、ツールライフサイクル ────┘
```

Codex はネイティブのタスク、コンテキストライフサイクル、UI、ツールハーネスを維持します。
ローカル Responses ブリッジは、選択されたモデルのタスクだけをタスクに紐付いた ChatGPT 一時チャットへルーティングします。
Full モードでは、次のコンパクション境界まで、MCP が ChatGPT を同じ Codex タスクのツールへ接続します。

> [!TIP]
> ChatGPT/Codex の音声をローカル環境でほぼリアルタイムに変換するアプリです。
> アカウント、ブラウザーセッション、ChatGPT リクエストには一切触れないため、
> 使用によってアカウントがブロックされるリスクはありません。気に入っていただけたら、ぜひお試しください。

## 免責事項

これは独立したソフトウェアであり、OpenAI との提携や OpenAI による推奨を受けたものではありません。
ご自身のアカウントで、適用される[利用規約](https://openai.com/policies/terms-of-use/)と
ワークスペースポリシーに従って使用してください。認証やアクセス制御を回避するものではありません。
