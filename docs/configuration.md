# 設定と復旧

## 保存先

既定は `~/.local/state/jvo/config.json`、`JVO_HOME` があればその配下です。キーは含めません。

```text
<home>/config.json
<home>/resources/state.sqlite          共有資源のlease
<home>/repos/<repo-id>/state.sqlite    run・task・decision・outbox
<home>/repos/<repo-id>/artifacts/      内容hashで保存した不変データ
<home>/repos/<repo-id>/workspaces/     タスクと固定snapshot用worktree
<home>/repos/<repo-id>/sessions/       CLIの継続情報
<home>/repos/<repo-id>/logs/           上限付き構造化ログ
```

実際のworktree配置はrun/task識別子から作成します。元リポジトリのtrackedファイルへ状態を混ぜません。Git worktreeは元リポジトリのobject storeを共有するため、元リポジトリを消す前に必要な変更を反映・保存してください。

## 設定を作る

通常は `jvo setup` と `jvo trust` を使います。設定の正確な初期形は `examples/config.example.json`、検証規則は `src/config.ts` にあります。

profileはCLI実体・版・機能指紋・モデル・役割・設定をまとめたものです。wizardで複数のモデルprofileを追加できます。tierは `fast` / `standard` / `deep` / `review`。Jevは難易度評価の後、許可されたprofileから選びます。指定していないAPIや未契約サービスへ自動変更しません。

書き込めるローカル設定を持つ利用者自身は安全境界の管理者です。リポジトリ内の設定を読み込んでグローバルの安全性を緩める機能はありません。例のbinary/version/capabilityHashを架空値のまま実行せず、wizardで実体を検出してください。

## 既存runへの設定変更

run開始時の設定・信頼・モデル条件をsnapshotとして保持します。グローバル設定を編集しただけでは、進行中のrunへ黙って適用しません。

```text
/pause
/exit
```

```sh
jvo setup
jvo trust  # 必要な場合
jvo resume <run-id> --refresh-policy
```

設定更新は明示承認として記録し、テストとレビューを再実行します。CLI・モデル・役割・skillが変わったsessionを、同じものとして無理に再開しません。作業ファイルは保持し、次の担当決定をJevへ戻します。

停止中のTUIで `/refresh` も使用できます。新しい環境変数は既存supervisorへ自動注入されないため、キーやproviderを環境変数で変更する場合は一度 `/exit` してCLIから再開してください。

## 不明な実行の復旧

通常の停止は `/resume`。プロセス消失、途中のGit操作、未知のCLI終了などは確認が必要です。

```sh
jvo replay <run-id>
# 保持されている差分・作業場・ログを確認
jvo recover <run-id> --acknowledge
jvo resume <run-id>
```

生存している可能性があるworker/プロセス群は自動的に二重起動しません。消失したworktree、未解消merge、変更された元checkoutを勝手に復元・破棄・上書きしません。必要な手動修正を行ってから再度照合してください。

replayがlive WALを理由に停止した場合は、先に既存TUIの `/exit` でsupervisorを閉じます。クラッシュしたDBに対して暗黙の書込復旧を行うのではなく、通常の `resume/recover` が必要な場合を区別します。

## 比較と校正

```sh
jvo metrics <run-id> > metrics.json
jvo export-eval <run-id> > cases.json
# cases[].labels に独立して確認した正誤ラベルを記入
jvo eval cases.json --allow-api
```

`export-eval` は**実際に送ったstateと質問**を不変artifactから取り出します。空のlabelsではAPI評価を開始しません。評価用入力には元のコード等が含まれ得るため、出力の取扱いと送信先には注意してください。

`examples/eval-cases.json` は動作確認用の人工例です。実タスクの判断品質、キャッシュ効果、性能の証明ではありません。調整用と最終評価用のデータを分離し、失敗runの費用も含めて比較してください。
