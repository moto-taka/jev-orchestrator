# Review Gate・Handoff・Effort

jvoはJevを文章生成ではなく、境界の判定に使います。

## 最終承認: Jev Review Gate

実装workerの「完了」報告だけでは承認しません。固定snapshotに対して、次の情報を一つのReview Gate stateとしてJevへ送ります。

- 承認済み要件・acceptance
- 現在snapshotのdiff
- 実際に実行した検証結果
- 独立reviewerの結果
- 未解決finding

hard gateは `evidenceAdequate`、`requirementsMet`、`diffRequirementFit`、`testsProtectBehavior`、`scopePreserved`、correctness、security、compatibilityです。Security/compatibilityは関係がなければ `not_applicable` を選べます。

maintainabilityはadvisoryです。低いmaintainability scoreだけを理由に、要件を満たした変更をrejectしたり、scope外のリファクタを開始しません。

Review Gateは、従来の「証拠を評価した後にもう一度acceptを選ばせる」二重判断を復活させません。Gateが通れば、その同じ判定記録からdeterministicなaccept transitionを行います。

## Agent間の引継ぎ: Handoff Packer

A2Aの短い質問・返答はそのまま配送します。既存sessionへの返答も、そのsessionへ差分だけ追加します。

新しいAgent/sessionへ作業を渡す場合だけ、recipient別のHandoff Bundleを作ります。

```text
sender
  ↓
task / acceptance / snapshot
  + context / evidence candidates
  ↓
Handoff Packer
  ├─ exact      実内容をそのまま渡す
  ├─ reference  読んだ場所・hashだけ渡し、必要なら再取得
  └─ drop       recipientには不要
  ↓
recipient
```

候補が4件以下ならJevを呼ばず、原則exactで渡します。候補が多い場合だけ、Jevが `exact / reference / drop` を選びます。低い確信度でのdropは採用せずexactへ戻します。

これは会話compactionではありません。ユーザー文やworker履歴をJevが要約文へ書き換えることはありません。task specとacceptanceは構造化したまま、必要な証拠は原文のまま渡します。workerがすでに作ったsummaryは補助情報として使用できます。

独立reviewerへは過去のreview artifactをhandoffしません。

## Model + Effort

利用者は `jvo models` で使ってよいモデル集合を選びます。CLIのmetadataからreasoning effortを確認できる場合、jvoはそのモデルが対応するEffortだけを候補にします。

現在のnative mapping:

- Codex: `model_reasoning_effort`
- Pi: `--thinking`
- Claude Code / OpenCode: 対応をmetadata/protocolで確認できないEffort flagは追加しない

Jevは「action」「model + effort」を同じ評価requestの独立質問として決めます。Effortのためだけに別のJev requestは送りません。等しく適任なmodel/effortが複数あることを、task自体が不確実な理由にはしません。

一度sessionが始まった後のrepair・A2A continuationは、modelだけでなくEffortも維持します。変更が必要なら明示的なreassignmentとして扱います。

## 記録

- Jevによるhandoff選別は通常のdecisionとして記録
- Handoff Bundleはcontent-addressed artifactとして保存
- TUIのagent footer / agent streamに選択Effortを表示
- deterministicな配送・session継続はJev判定として偽装しない

本番Jevの判定品質・token削減率・コスト改善率は、fixtureテストとは別に実測が必要です。
