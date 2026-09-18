# CLI別の許可モデル一覧（0.2.0）

利用者が選ぶのは **使用を許可するCLIと、そのCLIが公開するモデルの集合** です。fast / standard / deep / reviewの用途入力は不要です。Jevがタスクの難易度と根拠から、許可済みモデルと作業の役割を組にして選びます。

```sh
brew update
brew upgrade moto-taka/jev-orchestrator/jvo
jvo --version  # 0.2.0
jvo models     # Jevキーは再入力不要
```

既存runは開始時の設定を保持します。runを更新する場合は、先にTUIで `/pause` → `/exit` を実行してから、`jvo models`、`jvo resume <run-id> --refresh-policy` の順に実行します。設定変更によって、既存の検証・レビューや変更されたモデルのsessionは再確認対象になります。手元のファイルは消しません。

## 選択画面

CLIを選ぶと、そのCLIのモデル一覧を取得して順番に表示します。↑↓で移動、Spaceでチェック、文字入力で絞り込み、Ctrl+Aで表示中を全選択/解除、Enterで確定します。0件で確定したCLIは除外します。検索で非表示になったチェックは保持します。Ctrl+Cで中止した場合、旧設定を上書きしません。

初回設定ではPiの `enabledModels` に一致する項目を、見つかった範囲で初期チェックします。Piの設定そのものは変更しません。二回目以降はjvoの前回の許可を優先してチェックします。

同一CLIに複数モデルを選べます。同じモデル名でもproviderが異なる場合は別候補です。たとえばPiの `provider-a/model-x` と `provider-b/model-x` は、別々のprofile IDを持ち、実行時には `--provider` と `--model` をそれぞれ渡します。

保存形式では互換性のため `profiles` 配列を使いますが、一要素は「CLI/provider/modelの許可項目」です。新しい画面はtierを設定せず、全役割を許可します。Jevが `START_TASK` / `REQUEST_PLAN` / `REQUEST_SCOUT` / `REQUEST_REVIEW` 等の行動とprofileを選ぶため、人が役割をモデルに固定しません。

## 一覧の取得元

| CLI | 使用するメタデータ経路 |
|---|---|
| Codex | `codex app-server` の `initialize` / `model/list`。ページ送りにも対応し、`config/read`から既存providerを保持 |
| Claude Code | CLIのstream-json制御プロトコルの `initialize` に含まれるモデル一覧 |
| Pi | RPCの `get_available_models`。設定済みproviderを含む。RPC取得に失敗した場合は `--list-models` の表を解析 |
| OpenCode | `opencode models` の `provider/model` 一覧 |

モデル一覧の取得は生成プロンプトを送りません。ただし、CLI内部の認証更新・モデルカタログ取得・利用者設定の読込はあり得ます。「ネットワーク通信を一切しない」とは表示しません。CLIが一覧を取得できない場合は警告し、再取得またはスキップします。手元の古い許可項目を表示する場合は「前回設定・未再確認」と明示します。見つからないモデルや実在未確認のモデル一覧を架空に埋めません。

Piのグローバル拡張で登録されたproviderを利用する場合は、設定時にその読込を許可します。これは利用者がインストールした拡張コードの実行です。対応Piの `--no-approve` と `--no-context-files` でプロジェクト側を無視し、グローバルproviderは一覧取得時と実行時に一致させます。これらの制御を確認できないPiではグローバル拡張を自動許可しません。既存authやmodels.jsonのproviderはPi自身が読みます。

Claudeの `opusplan` は、Jev以外が役割によってモデルを切り替えるため候補から除外しています。`default` がCLIに提示され、利用者がそれを許可した場合だけ、CLI既定への委任を認めます。固定モデルIDとは区別してください。

## 検証

モデル一覧・ページング・provider重複・中止時の設定保持・全役割生成を自動テストしています。PTY上でも、通常の質問→チェックリスト→通常の質問→次CLIのチェックリストを実際に操作して確認しました。metadata試験はテスト用CLIであり、利用者のログイン済み環境を実測したものではありません。

参照した一次資料:
- [Codex app-server](https://developers.openai.com/codex/app-server)
- [Claude Agent SDK Python control protocol](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py)
- [Pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [Pi list-models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/cli/list-models.ts)
- [OpenCode CLI models](https://opencode.ai/docs/cli/#models)
