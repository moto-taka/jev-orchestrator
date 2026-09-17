# CLIアダプターと対応境界

## 検出と認証は別です

`jvo doctor` は、既知コマンドの実体、`--version`、機械向け出力に関係するヘルプをタイムアウト付きで確認します。カレントリポジトリの同名実行ファイルを検出目的で無条件実行しません。自動インストール、ログイン、ブラウザー起動、課金付きのタスクは行いません。

承認したbinary/version/help指紋はprofileに保存します。実行直前に一致を確認し、更新された場合は `jvo setup` とrunの明示的な設定更新を要求します。実認証・残り利用枠・すべての将来版との互換性は仮定しません。

## 標準アダプター

| CLI | 起動・再開 | 進捗・使用量 | 制限と検証境界 |
| --- | --- | --- | --- |
| Codex | `exec --json` / `exec resume <session>` | thread/item/turnイベント、入力totalに含まれるcached input | configでmulti-agentを無効化。sandbox設定。実認証での往復は別途確認 |
| Claude Code | `-p --output-format stream-json` / `--resume` | system/assistant/stream/result、累積usageの二重加算防止 | Agent/Task禁止、明示tool/MCP設定。user設定やOS境界まで完全隔離したとは扱わない |
| Pi | `--print --mode json --session <固定ファイル>` | session/message/tool/agent_end | extension/skill等の自動読込を抑止。読取用toolと実装用toolを分離。bashのOS隔離は別問題 |
| OpenCode | `run --format json` / `--session` | text/tool/step_finish、cache・費用 | task/external_directory等の権限設定を付与。設定統合を強いOS sandboxとみなさない |

すべてプロンプトはstdinで渡し、shell文字列やプロセス引数へ秘密を載せる方法を避けます。利用者が指定したモデル・provider・thinking設定を保持します。観測できない実モデル名はunknownです。

Codex・Pi等で全turn数を外部から確実に制限する共通フラグは仮定しません。対応CLIの上限指定に加え、全CLIにtimeoutと起動数上限を課します。

## 最終報告

workerにはJSONの最終報告を要求します。

```json
{
  "summary": "行ったこと",
  "claims": ["確認できたこと"],
  "questions": [],
  "findings": []
}
```

計画workerは `plan` を付加し、依存・変更範囲・合格条件を提案します。レポートが不正、完了イベントなし、非JSONプロトコル混入、sessionの変化、終了状態不明の場合は合格にしません。CLIの終了コード0と、タスクの意味的な合格は別です。

新しいCLIの出力形式が変わった場合は停止して確認します。画面の見た目を文字列検索し「たぶん成功」と推測するfallbackはありません。

## 管理レベル

- `trusted-local`: 利用者が実体・版・ローカル実行を承認し、構造化入出力を利用する通常の実行レベル。
- `assisted` / `unavailable`: 自動工程には使用しない。
- `managed`: 型として予約していますが、標準アダプターを未検証のままこのレベルへ自動昇格させません。

既存CLI自身が内部shellや拡張を利用できるため、悪意のあるworkerをプロンプトだけで完全制御できるとは主張しません。強い権限制約が必要な環境では、別ユーザー・コンテナ・VM等を含むsandboxを検証してください。

## 根拠

- [Codex non-interactive](https://developers.openai.com/codex/noninteractive)
- [Claude Code headless](https://code.claude.com/docs/en/headless)
- [OpenCode CLI](https://opencode.ai/docs/cli/)
- `earendil-works/pi` の `packages/coding-agent/docs/usage.md`、確認時blob `88ada91ba9bb8b2630fa75b8f97373a3c395577d`

テストは記録形式の契約fixtureと実際の子プロセスfixtureを使用します。これらを実ユーザー認証や本番モデルの成功と取り違えないでください。
