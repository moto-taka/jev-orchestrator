# Agent-to-agent通信の追加設計

**状態: 設計提案。現行0.1.0にメッセージバスや外部A2A Protocolの実装はありません。**

現在はJevがworkerを呼び分け、報告・レビュー・差し戻しを仲介します。`questions` はworkerの最終報告に含められますが、宛先付き質問・返信スレッド・配送確認として管理されていません。ここを別機能として拡張する案です。本文の新コマンドは実装済みとは扱いません。

## 1. 結論

**エージェント同士は会話できます。ただし、会話する権限と進行を決める権限を分けます。**

質問・返答・発見・争点はworkerが書きます。Jevは宛先・関連性・配送の採否・追加調査・scope変更の採否を選びます。通常のruntimeが保存・配送・再試行・通知を担当します。Jevに返答文を生成させず、workerにタスク完了承認や他worker起動の権限を与えません。

前提の「全てJevが仲介」を保つため、意味のあるメッセージごとにJevが配送候補を選ぶstrictモードを最初の仕様にします。ネットワークheartbeat、永続化ACK、tokenの表示は通常コードで扱います。将来の会話単位の事前承認を、初期実装で黙って代用しません。

## 2. 一次資料から確認した比較

確認日: 2026-09-18。これは各ツールとの実際の接続試験ではありません。

| 仕組み | 何を行うか | jvoに取り入れる部分 |
| --- | --- | --- |
| [agmsg](https://github.com/fujibee/agmsg) | vendorの異なるCLIセッション間でSQLite経由のメッセージ。hook/monitor/bridgeで通知 | 宛先、履歴、質問・返答、ターン境界配送。DBへの直接書込み権限は取り込まない |
| [Orca CLI](https://www.onorca.dev/docs/cli/reference) | 端末への入力、出力のcursor読取、待機、worktree管理。[orchestration](https://www.onorca.dev/docs/cli/orchestration)で追跡付き委任 | 既存sessionへの到達性、差分読取、待ち状態。端末の文字を成功証拠にはしない |
| [Herdr automation](https://herdr.dev/docs/agent-automation/) | 認識したagentへのprompt、状態待機、出力読取。paneとagentを区別 | 実行中agentの識別、到達性、ターン終了前後の扱い。idle/doneを要求完了と混同しない |
| [Pi Messenger](https://github.com/nicobailon/pi-messenger) | 在席、DM、feed、ファイル予約、Piのsteering通知、crew | 会話パネルと必要な通知。crewの自律schedulerは二重に導入しない |
| [A2A Protocol](https://a2a-protocol.org/latest/specification/) | ネットワーク越しのagent発見、Message/Task/Artifact、状態更新を標準化 | 外部agent連携が必要な場合の別アダプター。ローカル会話機能とは別物 |

agmsg・Orca・Herdrが、いずれも同じA2A ProtocolのAPIを話すという意味ではありません。小文字のa2a（agent間連携）と標準仕様のA2A Protocolを区別します。

## 3. 実行例

```text
Codex / API担当
  「認証切れは401を返す想定ですが、UI側の契約と合いますか」
       ↓ propose(message)
jvo: sender・run・snapshot・予算・宛先候補を検査
       ↓
Jev: 関連するUI担当へ送る / 保留 / 範囲変更として確認 / 拒否
       ↓
Claude / UI担当の次の安全なターンへ質問だけを追記
  「UIは401を想定しています。型定義の該当箇所は…」
       ↓ reply(message-id)
Jev: 返答の関連性と配送可否を確認
       ↓
Codexの元sessionへ返答のみ追記
       ↓
通常の実装・独立レビュー・Jev承認を継続
```

「相手が賛成した」ことは、API契約の変更承認やタスク完了の代わりになりません。明示的な契約変更は新しいscope版に結び付け、関連テストとレビューを無効化して取り直します。

## 4. 制御面と通信面

既存のprivate supervisor IPCは利用者のpause/apply等を扱います。その認証をworkerへ渡すと、会話のために管理権限まで渡してしまいます。別の狭いworker APIを設けます。

```text
利用者 ── 管理用IPC ── supervisor ── Jev
                             │
worker A ── 制限付きpeer API ─┤
worker B ── 制限付きpeer API ─┤
                             └─ SQLite / outbox / messages / delivery receipts
```

worker側へ与える操作は `peers.list`、`message.propose`、`message.reply`、`inbox.pull`、`delivery.ack` などに限定します。run作成、task開始、apply、権限変更、Jevキー取得は不許可です。

認証はrun・task・invocationに束縛した失効可能な権限にし、本文の `from` や見た目のagent名を信用しません。終了したinvocationの権限は再利用できません。SQLiteはsupervisorだけが書き、workerは制御DBを直接操作しません。ただし通常の同一OSユーザー実行だけで悪意あるworkerから完全に秘密を隔離できる、という主張はしません。強い境界は別sandboxが必要です。

## 5. メッセージ契約

```ts
// 追加予定の契約。現行exportではありません。
interface PeerMessage {
  id: string;
  runId: string;
  threadId: string;
  senderInvocationId: string; // runtimeが認証情報から確定
  senderTaskId: string;
  recipientTaskId: string;
  kind: 'question' | 'answer' | 'observation' | 'dispute';
  replyTo?: string;
  snapshot: string;
  scopeVersion: number;
  bodyArtifact: string;
  evidenceArtifacts: string[];
  expiresAt: string;
  decisionId?: string;
}
```

本文サイズ、宛先数、スレッド往復数、run全体のメッセージ数に上限を設けます。Jevへは本文と判断に必要な実際の抜粋を送り、hashだけで中身を理解したことにしません。秘密情報と除外対象の検査を、外部Jev送信前・peer配送前の両方で行います。

`message.id` の再送は同じ配送として扱います。別snapshotの似た質問は別物です。返信は有効な `replyTo` と参加者に限定し、ACKへACKを返すループや自己送信を防ぎます。

## 6. 配送状態を偽らない

```text
proposed → Jev-approved → queued → submitted-to-adapter
                    └→ rejected / expired / stale
submitted-to-adapter → consumed-at-turn（観測できる場合だけ）
                    → reply-recorded → closed
                    → unknown（送信中の障害）
```

DBに保存できたこと、stdin/socketへ書き込めたこと、モデルの当該ターンに取り込まれたこと、回答が返ったことはそれぞれ別状態です。CLIが取り込みを確認できない場合は「既読」にしません。送信直後に落ちて副作用が分からない場合は、確認前に別sessionへ同じ依頼を送り直しません。

## 7. 先にターン境界、次にlive steering

現行native adapterはheadless実行・最終報告・session再開が主経路です。stdinを閉じた既存プロセスへ後から入力できるものとは扱いません。

最初の実装対象は **ターン境界の永続キュー** です。質問側がチェックポイントでyieldし、同じsession/cwdを保持したまま待機します。相手が作業中なら、次の安全な境界で質問を追記します。質問側は応答を受けて元sessionを再開します。

live steeringはCLIごとのRPC/SDK/hookで、入力IDとターン取り込みを確認できたものだけ追加します。画面へのEnter送信を、全CLI共通の確実なメッセージ配送として扱いません。Orca/Herdr経由で既存sessionへ届ける経路も、対象の実体・状態・CLI版を確認する独立アダプターにします。

## 8. 並列実行・worktree・デッドロック

メッセージは作業場を共有する理由にはしません。同じ変更taskのwriterは一人のまま、他のagentは固定snapshot/成果物を参照して回答します。worker Aがworker Bの作業場を直接編集しません。

全workerが返答待ちのまま実行slotを保持すると停止します。`waiting-for-peer` はCPU/modelの実行slotを解放し、workspaceの所有関係は維持します。A→B→Aなど待機の循環を検出し、Jevへ「要点をまとめて再照会」「専門家」「利用者確認」「停止」の候補を提示します。終了したtaskのsessionを再開する場合も、その時点のscopeとsnapshotを再確認します。

独立レビュー担当へ実装者の会話履歴を丸ごと渡しません。レビューの質問には必要な根拠だけを返し、変更したレビュー対象には再レビューが必要です。

## 9. キャッシュと費用

メッセージ配送自体は通常のプログラムで行いますが、Jevの配送判断とworkerが返答する推論には消費が発生します。「直接会話すれば無料」「必ずキャッシュ改善」とは表示しません。

同じsession・model・cwd・system指示を保ち、受信した質問・回答だけを末尾へ追記します。全員へ全会話をbroadcastする方式や、全履歴を司令塔が長文で再要約する方式は避けます。同じ宛先・snapshotの小さい通知はまとめ、既に解決した質問は再生成しません。

初期案は一つの争点につき2往復まで。それ以上はJevが続行の必要性を判断します。メッセージ数だけでなく、追加のworker起動数・入力token・総待機時間・受け入れ済みtask当たり総消費で評価します。

## 10. TUI

既存の会話中心の画面を維持し、通常は「誰が誰に質問中か」と待ち理由だけ表示します。展開した通信パネルで、スレッド、質問と返答、配送状態、参照snapshot、Jevの判断を確認します。

```text
Agents
  Codex / API     UI担当への質問の返答待ち
  Claude / UI     質問をキュー済み・現在の編集が終了次第受信

Messages（追加予定）
  API → UI    認証切れ時の401応答で合いますか   [queued]
  UI  → API   401で一致します。根拠: …        [reply-recorded]
```

既存0.1.0にはこのMessagesパネルや `jvo msg` コマンドはありません。

## 11. 外部連携

agmsgへのbridgeを付ける場合、専用team・対応する公認CLI/script経由で読み書きし、そのDB内部を直接変更しません。jvoからの送信はJev承認後、受信は未信頼の提案として取り込みます。既存のagmsg team全体を自動的に管理対象にしたり、古い履歴を全送信したりしません。

Orca/Herdr連携は実行場所と到達性のbridgeです。jvoのTUIを捨てる必要はありません。標準A2A Protocolは別の外部gatewayで実装します。AgentCard、対応バージョン、Task/Message/Artifact、認証、取消し・状態対応を仕様に合わせて契約試験して初めて「A2A対応」と表記します。外部からの仕事受付は既定無効、明示した相手・scope・費用上限だけ許可します。

## 12. 追加実装の受け入れ条件

- 異なる2種類のCLIが、実際の質問→Jev配送判断→相手の返答→元session継続を完了すること。
- 送信者偽装、別run宛て、秘密の流出、期限切れ、古いscope/snapshot、無限ping-pongを拒否すること。
- 重複配送・ACK、送信中のcrash、相手終了、全slot返答待ち、相互待ちのケースで暴走しないこと。
- 会話だけでtask accepted/apply/権限変更にならず、Jevの通常の検証ゲートが保たれること。
- TUIがqueued/submitted/consumed/answered/unknownを区別し、観測できない既読を表示しないこと。
- 既存のsession/worktree/usage/replayの回帰テストが維持されること。

Homebrew対応とは独立した追加開発です。未実装の通信機能を、インストール対応に含まれる完成機能とは扱いません。
