# 0.3.0 追加検証

2026-09-18: ローカルで型チェック、107件中105件成功、実APIの2件は明示skip。ビルド、インストール用パッケージのofflineインストール、隔離デモも成功。

新しいテストは、同じfixtureでの旧経路9回/新経路3回、モデル候補8個の拮抗、memoの変動分離、実行直前のscope変更拒否、同一commitの最終テスト失敗の拒否、報告6件の原文保持・重要4件の強制選別・曖昧2件のbatch化を含みます。Jev本番の精度・料金・速度・token削減率を測定した値ではありません。

GitHub ActionsとHomebrewのリリース別の結果は、それぞれの実行runで確認してください。ローカル試験成功を未実行の遠隔CI成功とは扱いません。

---

# 0.2.0 追加検証

2026-09-18: 型チェック、94件中92件の自動テスト成功、実APIの2件はキー未設定で明示skip。0.2.0配布パッケージのインストール・起動・隔離デモも成功。モデル選択のPTY操作も実行しました。

追加のテストは、4種類のCLIのモデル一覧メタデータ、Codexのページング、Piの同名モデル/provider分離、用途を固定しない複数選択、中止時の設定保護、native peer通信、相互待ち、部分返答、範囲・期限、配送拒否、読取専用違反と復旧です。

モデル一覧とA2Aの外部CLIはfixtureです。プロセス・Git・SQLite・TUIの実動を確認していますが、ユーザーの実ログイン環境、本番Jev API、実運用でのモデル品質やキャッシュ改善幅は未測定です。GitHub Actionsの結果は、対応commitの実行ログを参照してください。

以下は0.1.0時点の既存の検証記録です。

---

# 検証記録

確認日: 2026-09-18。対象は、このリポジトリの 0.1.0 実装です。

## 実施した検証

| 検証 | 結果 | 実際に通した経路 |
| --- | --- | --- |
| TypeScript strict型チェック | 成功 | `npm run typecheck` |
| 自動テスト | 81件中79件成功、2件は明示的にskip | `npm test`。通常試験はAPI課金なし |
| 単一タスクの統合試験 | 成功 | 実際のGit worktree、SQLite、子プロセス。初回の不具合をテストで検出し、同一sessionへ差し戻して再検証・独立レビュー・統合 |
| 並列計画 | 成功 | 計画のDAG検査、依存関係、複数task worktree、Jev選択fixture、全体検証 |
| 統合競合 | 成功 | 実際のGit競合を作り、専用の修正タスクで解消して再テスト・再レビュー |
| CLI接続の結合試験 | 成功 | 実行可能なCodexプロトコルfixture、stdin、JSONL解析、session再開、版更新後の拒否 |
| supervisor・IPC | 成功 | 実CLIエントリーからprivate socketへ接続、ローカルHTTP評価fixture、子プロセス、再開・終了 |
| ソースからの配布・インストール | 成功 | `npm run test:package`。pack後、新しいprefixへオフラインglobal install。実際のインストール済み `jvo --version` と `jvo demo --json` が成功 |
| TUIの端末実行 | 成功 | 実PTY、112×34から88×30へのサイズ変更、`/agents`、`/usage`、Esc、Ctrl+Dによる正常終了 |
| TUIの表示確認 | 実施 | デモ実行中の実際の `renderScreen` 出力を `tui.svg` へ記録。DEMO・fixtureと明示 |

インストール試験の出力は `installedVersion: 0.1.0`、`runtimeDependencies: 0`、`status: ready_for_user_apply`、`journalValid: true` でした。ソースのTypeScriptをnode_modulesから直接起動できない問題をこの試験で検出し、配布時のJavaScriptビルドへ修正しています。

ローカル実行環境はLinux、Node.js 22.16.0、npm 10.9.2、TypeScript 5.8.3です。ローカルで利用できたNode型定義は25.1.0であり、宣言した開発用依存の22.15.30との一致はCIで別途確認する対象です。GitHub ActionsにはUbuntuのNode 22.16.0・24、macOSのNode 22.16.0を設定しています。CIの結果はActionsの該当commitを確認してください。設定があるだけで各環境の成功を意味するものではありません。

## 障害・安全性の試験

古いsnapshotや判断の拒否、同じ操作IDの二重実行拒否、workerの成功申告と実測テスト失敗の区別、レビュー中の変更検出、消失したworktree、dirtyな元checkoutの保護、index保持、未知の終了の確認待ち、プロセスとleaseの照合、Jev停止中の進行保留、予算上限、制御キーの環境継承防止、symlinkとパス逸脱、不正な型付き回答、CLI更新後の再承認、累積usageの重複計上防止を試験しています。

判断の再現に必要な入力stateとquestionsを不変artifactとして保存し、厳密memoの実入力と記録が一致することを確認しています。replayはチェックポイント済みDBをimmutable/read-onlyで開き、ファイル更新やAPI呼出しを行いません。書込中のWALがある場合には拒否します。

## 未実施の検証

**TypeSafe公式とVercel AI Gatewayの本番接続試験は、キーがないため未実施です。** `test/live.test.ts` の2件を明示的にskipしています。通常のHTTP契約試験はfixtureであり、本番サービスへ接続した結果ではありません。

**各社CLIの実際のログイン状態・有料モデル・サブスクリプションを使う往復は未確認です。** ネイティブアダプターのコマンド構築、構造化出力、再開、失敗判定は試験していますが、それを実認証済み製品の動作保証には置き換えません。更新時は `jvo doctor` と再承認が必要です。

利用者のmacOSでのKeychain、端末固有の日本語入力・フォント、実運用の判断品質、課金額、キャッシュヒット率や時間の削減幅も未測定です。通常のworktreeはsandboxではなく、同一OSユーザーの全副作用を隔離したことの証明はしていません。

## 再現方法

```sh
npm install
npm run check
npm run test:package
node bin/jvo.mjs demo --json
```

実接続試験は、費用が発生し得ることを了承してキーを設定した場合だけ実行します。

```sh
JVO_LIVE_TESTS=1 TYPESAFE_API_KEY=... npm run test:live
JVO_LIVE_TESTS=1 AI_GATEWAY_API_KEY=... npm run test:live
```

実タスクの品質・性能比較には、独立した受け入れ条件と正誤ラベルを用意し、失敗runを含む総消費で比較してください。`export-eval` は実際に記録した判断入力を出力しますが、正解ラベルを自動で作りません。`eval` はラベルのない入力を、課金APIを呼ぶ前に拒否します。
