# 0.3.0 リリース記録

アプリケーション: `31fed1465a8bf66b61b977ab66889906397f6930`
検証したソースtree: `3e99ef4bdb955eebaaac16192183d2e540acab9d`

ローカルで型チェック、107テスト中105成功・実API用2件skip、offlineパッケージインストール、隔離デモを確認しました。GitHub上でも同じtreeの一致確認、型チェック、テスト、デモ、パッケージ試験を完了してからアプリケーションをcommitしています。

[GitHub側のソース一致・検証run](https://github.com/moto-taka/jev-orchestrator/actions/runs/35336641746)

一時的な変更適用用workflowとpatchはアプリケーションcommit内で削除しました。通常のインストールや実行にpatch適用、追加の書込権限、GitHub tokenは必要ありません。

Homebrew formulaは上記アプリケーションcommitへ固定しています。通常の3構成CIとmacOS Homebrewの結果は、formula更新commitに対するActionsで確認してください。

- [判断削減と既存runの移行](lean-decisions.md)
- [任意の報告仕分け・まとめ読み](report-triage.md)
- [更新方法](homebrew.md)

回数の比較はfixtureによる制御経路の試験です。実モデルの品質、APIの速度や料金、記事のtoken削減率を再現測定したものではありません。
