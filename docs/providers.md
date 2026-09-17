# Jev provider契約

確認日: 2026-09-18。jvoは型付き評価を使用し、自由文を生成するチャットモデルを司令塔として呼びません。

## TypeSafe公式

- `POST https://api.typesafe.ai/v1/systemone`
- Bearer認証。`model`, `state`, `questions` を送信。
- `boolean` 内部型を公式の `noul` へ変換。
- Choiceは候補・分布・confidence、Scoreは段階順・legend・分布・confidenceを保持。
- usageの `input_tokens` / `output_tokens` を正規化。
- `jev-latest` は可変alias。可変aliasではrunをまたぐ判断memoを共有しない。

根拠: [API](https://docs.typesafe.ai/api)、[Models](https://docs.typesafe.ai/models)、[Confidence](https://docs.typesafe.ai/confidence)、[State](https://docs.typesafe.ai/concepts/state)。

## Vercel AI Gateway

既定のHTTP transportは、公式SDKのevaluation実装に対応します。

```text
POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model
Authorization: Bearer <key>
ai-evaluation-model-specification-version: 4
ai-model-id: typesafe-ai/jev
ai-gateway-auth-method: api-key
ai-gateway-protocol-version: 0.0.1

{ state, questions, providerOptions }
```

- 質問は `choice` / `score` / `boolean`。
- Boolean回答は `probability`。
- confidenceは `providerMetadata.typesafe.confidence[questionId]` を、存在するときだけ取得。
- `inputTokens` / `outputTokens` を正規化。
- metadataから取れないconfidenceを最大確率で偽装しない。
- OpenAI互換・Anthropic互換チャットendpointは使用しない。

根拠:

- [Gateway Evaluation](https://vercel.com/docs/ai-gateway/modalities/evaluation)
- [Jev公開告知](https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway)
- `vercel/ai` の `packages/gateway/src/gateway-evaluation-model.ts`、確認時blob `5d0cea70603520ad1ca4578dcdc73ef5d6336be8`
- `packages/gateway/src/gateway-provider.ts`、確認時blob `1d5281297b3e4526f51e97378f202ffc59a65393`
- `packages/ai/src/evaluate/evaluate.ts`、確認時blob `40ccb9079b1b4779ad019a5bd59ba1ddad93e8bf`

`decision.transport = "sdk"` は任意の明示選択です。`ai` の `experimental_evaluate` と `@ai-sdk/gateway` の `createGateway().evaluationModel()` が必要です。設計時の公開案内はAI SDK 7.0.105以降でした。この経路の依存SDKは通常インストールに含めず、対応SDKの事前導入がない場合は明確なエラーで停止します。ローカル検証はHTTP経路の契約を対象としています。

## 共通の安全ルール

HTTP成功だけで回答を採用しません。回答ID、型、有限数、確率範囲、分布の合計、Choice候補、Scoreの範囲とlegendを検査します。質問の意味はIDだけに隠さずinstructionsにも書きます。

複数質問は同一stateに対して独立です。難易度評価の回答に依存する担当選択は、別のstate・リクエストへ分けます。

429/529等は期限・回数・run予算内で再試行します。認証失敗を無限再試行しません。SDK内部retryは0で、runtimeとの二重retryを避けます。Jevが利用不能でも汎用LLMへ黙って切り替えません。

confidenceは実際の正解率ではありません。confidenceがないときの選択supportは候補分布として扱い、confidence欄はunknownのままです。採用には独立した実測テスト・snapshot・レビューのハードゲートも必要です。閾値は初期値であり、校正済み性能値ではありません。

送信上限、secret検査、除外、stateの不変hash、質問版、policy hashを記録します。プロジェクト情報を送信しないsetup接続試験も、API利用として明示的な許可を求めます。
