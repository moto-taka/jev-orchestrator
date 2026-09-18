# 0.3.0での変更

- `src/engine.ts` / `storage.ts` / `types.ts`: 実Jev判断を元にした限定的なruntime継続権限、A2A配送、修正、レビュー担当維持、合格後統合。旧runの動作は明示更新まで保持。
- `src/decision/questions.ts`: 行動とモデル適性の独立質問、初回評価の集約、合否の重複確認廃止。
- `src/report-triage.ts` / `triage-command.ts`: 任意の報告仕分け、通常報告の保存、保守的な注意対象選別、許可モデルへのまとめた助言依頼。常駐司令塔は追加しない。
- `test/lean.test.ts` / `triage.test.ts`: 回数の経路比較、モデルの拮抗、古い権限、最終試験の環境変化、通常/重要/秘匿報告の区別。

詳しくは[判断削減](lean-decisions.md)と[報告仕分け](report-triage.md)。以下は原設計への過去の対応記録です。0.2.0の配送ごとのJev承認は、新規runでは通常コードへ移しています。

---

# 0.2.0での拡張

- `src/models/catalog.ts` / `picker.ts` / `setup.ts`: CLI別モデル一覧・複数許可。tier入力なし、Jevがモデルと役割を選択。詳しくは[モデル設定](models.md)。
- `src/messaging/mailbox.ts` / `engine.ts`: 外部ツール不要のnative peer通信、Jevによる配送承認、宛先・返信の相関、元session/cwdの継続、上限、復旧。詳しくは[通信仕様](agent-messaging.md)。
- `test/models.test.ts` / `messaging.test.ts`: metadataとCLI形式のfixtureを使った実子プロセス試験。

以下の表は0.1.0時点の基盤に関する対応記録です。追加されたモデル設定・通信については上記が優先します。

---

# 設計と実装の対応

原設計書は [design.md](design.md) にそのまま保存しています。この文書は原設計を完了扱いに書き換えるものではなく、実装位置、確認方法、外部検証の境界を対応付けるものです。

## 構成

単一のTypeScriptパッケージにまとめています。実行単位はTUI/CLIとrun supervisorで分離し、型を共有します。原設計のモノレポのパッケージ分割は、概念上の境界として `src/` の各モジュールへ対応させています。

```text
bin/jvo.mjs                 Nodeの版確認・CLI起動
src/cli.ts                  コマンド、開始、接続、読取専用出力
src/setup.ts                キー・CLI・リポジトリ信頼の初回設定
src/tui/                    軽量な差分描画、入力、進捗と展開パネル
src/ipc.ts                  private socket、認証、supervisor、detach
src/engine.ts               Jevの仲介、候補、工程、レビュー、統合
src/decision/               型付き評価・正規化・質問版・再試行
src/adapters/               検出、版の照合、既存CLIの構造化出力
src/workspaces.ts           task worktree、snapshot、統合、明示反映
src/context.ts              関連文脈、skill選択、根拠の実抜粋
src/contracts.ts            worker最終報告・計画グラフの検査
src/storage.ts              SQLite、transactional outbox、lease、artifact
src/telemetry.ts            provider別usage・観測カバレッジ
src/security.ts             制御キー除去、除外、表示の無害化
src/eval.ts                 副作用なしのラベル付き判断評価
src/demo.ts                 明示的な隔離デモ（本番の代替ではない）
```

## 原設計の項目別対応

| 原設計の項目 | 実装 | 主な確認・境界 |
| --- | --- | --- |
| 0–2 判断専用Jev・実行コア・CLIの分離 | `types`, `engine`, `decision`, `adapters` | Jevは許可済み候補IDのみ選択。CLIは報告・計画案のみ提出。安全拒否はruntimeが強制 |
| 3 初回設定・キー・CLI検出 | `setup`, `config`, `adapters/registry` | version/helpの無課金probe、実体と機能指紋を保存。認証は未確認を維持 |
| 4 公式/Gateway・型・confidence | `decision/provider` | 両経路のHTTP契約テスト。不正型、未知候補、分布・legend不一致、欠落を拒否。本番接続は明示opt-in |
| 5 profile・難易度・担当維持 | `types/Profile`, `setup`, `engine` | 6軸評価の後に候補選択。fast/standard/deep/reviewは利用者がCLI・モデルに割当 |
| 6 計画提案・採否 | `contracts`, `engine/adoptPlan` | DAG、未定義依存、予算、パス、親の書込範囲を検査。採用もJev。並列グラフの結合テスト |
| 7 意味的状態・判断・outbox | `storage`, `engine` | 対象タスク/依存/利用者scopeの版で鮮度確認。無関係なheartbeatでは無効化しない。実行直前も再照合 |
| 8 実際の証拠・不変artifact | `context`, `storage`, `engine` | 依頼・diff・生の試験結果・レビューをsnapshotへ結付け。省略/切詰めを表示。判断時の実state/questionsもhashで保存 |
| 9 差し戻し・独立レビュー・停滞 | `engine`, `adapters/native` | 同じsession/cwdへ差分追加。固定snapshotの別sessionレビュー。自己申告だけで指摘を閉じない。試行上限あり |
| 10 task worktree・統合・dirty保護 | `workspaces`, `engine`, global resource store | 単一writer。明示資源ロック。競合は新しい修正タスク。元checkout更新時はapply拒否。dirty/in-placeテスト |
| 11 三種類のcache・usage | `storage/memo`, `telemetry`, `engine` | 厳密一致のみ。CLI/model間KV共有は仮定しない。Codex/Anthropic等の会計差を正規化。重複・累積を二重計上しない |
| 12 TUI・操作・軽量描画 | `tui`, `cli`, `ipc` | 会話中心、エージェントツリー、展開表示、日本語幅、貼付け、履歴。差分描画と上限付きログ。想像した進捗率なし |
| 13 追加調査・skill・指摘・リスク | `context`, `engine`, `eval` | 文脈/skillの関連性選択、同一snapshotの指摘重複判定、争点と根拠保持、重要領域の追加レビュー、記録入力の評価用出力 |
| 13.7 画像 | worker側の能力を使用 | Jevへ画像を送信しない。binaryを文脈テキストに変換しない。画像確認は対応workerの観測として扱い、Jevが見たとは表示しない |
| 14 永続化・復旧・予算 | `storage`, `ipc`, `engine` | WAL/FULL、outbox、PID生成時刻とプロセス群照合。unknownは確認待ち。継続的課金fallbackなし。回数/時間/並列を制限 |
| 15 安全性 | `security`, `config`, `workspaces`, `process` | キー環境継承防止、private state、危険パス、symlink、hook除外、repo信頼。OS sandboxではない点を明示 |
| 16 モジュール・アダプター契約 | `types`, `adapters`, `process` | 開始/再開/終了/失敗/usageを共通化。unknown版を無条件Managed扱いしない |
| 17 設定 | `config`, `setup` | JSON。wizardが作成。API keyは別。変更はrunへ黙って反映せず `/refresh` または `--refresh-policy` で再承認 |
| 18 完成判定・試験 | `test/`, CI, `docs/verification` | ローカルの自動・障害・統合試験を実施。実API・実認証CLI・モデル判断品質・性能改善の最終実測は未確認として区別 |

## 明示している実装上の選択

**TUI:** Inkではなく、Nodeの標準入出力とANSI差分描画を使用しています。見た目の参考はOpenClaudeの会話とagent progressです。既存の大きなエージェント実装やブランド資産を移植していません。

**Gateway:** 既定は公式Gatewayソースで確認したv4 evaluation wireです。原設計例のAI SDK経路も明示選択できますが、チャット互換クライアントへの差替えではありません。依存や実行時エラーを隠れて別経路へ切り替えません。

**隔離レベル:** 標準CLIは `trusted-local` です。構造化プロトコル、版、CLIの制限設定、snapshotの事後照合はありますが、同一OSユーザーのすべての副作用を防ぐsandboxとしては認定していません。厳格なsandbox要件を満たしたという表示をしません。

**読取専用replay:** SQLiteの通常のread-onlyがWAL sidecarを作る場合も避けるため、チェックポイント済みのDBをimmutable/read-onlyで開きます。書き込み中のWALがある場合、暗黙にcheckpointせず、先にsupervisorを閉じるよう要求します。

**費用:** 本番provider/サブスクの請求残量が観測不能な場合に、厳密な円・ドル上限が保証できるとは扱いません。観測された費用とunknownを区別し、API回数、worker起動、turn指定可能なCLI、timeout、並列数を制限します。

## 追加確認が必要な外部条件

実際のJevキーでの公式/Gateway接続、各CLIの実認証・実モデルの往復、利用するmacOS端末でのKeychain・端末描画、実タスク集合の判断品質と総消費の比較は、利用者環境での確認対象です。fixtureテストをこれらの成功の証明として扱いません。

## 配布ビルド

Nodeはnode_modules配下のTypeScriptを直接実行しないため、インストール・pack時に `scripts/build.mjs` で自社のソースだけをJavaScriptへ変換します。Node標準のtype strippingをビルド時だけ使い、実行時は `dist/` の通常のJavaScriptです。追加のコンパイラ取得や実行時npm依存はありません。型検査は別途 `tsc --noEmit` で行います。ビルド出力はNodeの版で変化し得るため、CIの対象版ごとに試験します。
