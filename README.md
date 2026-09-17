# Jev Orchestrator

**Jev decides. Your CLIs build.**

`jvo` は、Jevを判断専用の仲介役として、インストール済みの Codex / Claude Code / Pi / OpenCode を連携するローカルオーケストレーターです。OpenClaude風の会話中心TUIで、各エージェントの進捗、差分、判断記録、使用量を確認できます。

Jevはコードや計画文を生成しません。難易度評価、担当選択、計画の採否、レビュー、差し戻し、統合・完了承認を型付きの選択として返します。実作業は既存CLIが行います。

## インストール

Node.js 22.16.0以降とGitが必要です。macOS / Linux / WSLが対象です。

```sh
git clone https://github.com/moto-taka/jev-orchestrator.git
cd jev-orchestrator
npm install -g .
jvo setup
```

通常のHTTP接続とTUIに実行時npm依存はありません。このリポジトリがprivateの場合は、clone時にご自身のGitHub認証が必要です。

```sh
cd /path/to/your/project
jvo trust
jvo
```

`jvo setup` でTypeSafe公式またはVercel AI GatewayのJevキーと、使用するCLIを選びます。worker側の認証・契約は各CLIがそのまま管理します。APIキーはOSの秘密情報ストアまたは環境変数を使用し、設定JSONやworker環境へ保存・転送しません。

## 操作

```sh
jvo run "不具合を修正し、回帰テストを追加してください" --json
jvo resume
jvo replay
jvo doctor
jvo demo --json
```

TUIでは `/agents`、`/tasks`、`/diff`、`/why`、`/usage`、`/pause`、`/resume`、`/apply` を使用できます。通常はタスク別worktreeで実行し、差し戻しでは同じsessionと作業場を維持します。元の作業ツリーへの反映には `/apply` が必要です。リモートへのpushやdeployは行いません。

## 安全性と検証

承認は、対象snapshotに結び付いた実測テスト、独立レビュー、Jevの判断に基づきます。workerの「完了しました」だけでは承認しません。状態はSQLiteとハッシュ付きイベント履歴へ保存します。古い判断、二重実行、不明な終了、消失したworktreeは自動的に成功扱いしません。

worktreeはOSのセキュリティsandboxではありません。既存CLIと承認済み検証コマンドは同じOSユーザーで動きます。CLI検出はインストールと機械向け出力の確認であり、認証や最新バージョンの実接続保証ではありません。

`jvo demo` は、判断とCLIを明示したテスト用fixtureへ置き換え、実際のGit・検証コマンド・SQLiteを動かします。APIは呼びません。デモ結果と、実際のJev／各CLIへの接続試験は区別してください。キャッシュ改善率や費用削減率を測定済みとして主張するものではありません。

## 開発

```sh
npm install
npm run check
```

設計、対応範囲、検証手順は `docs/` を参照してください。
