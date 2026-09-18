# Homebrewでインストールする

このリポジトリ自身をtapとして利用します。別の公開リポジトリを作らず、private設定を維持します。

## 初回

GitHubへSSH接続でき、このリポジトリへの読取権限があるMac/Linuxで実行します。

```sh
brew tap moto-taka/jev-orchestrator \
  ssh://git@github.com/moto-taka/jev-orchestrator.git
brew install moto-taka/jev-orchestrator/jvo
jvo setup
```

Homebrewの2引数形式は任意のGit URLを指定できます。1引数の `brew tap moto-taka/jev-orchestrator` は、別名の `homebrew-jev-orchestrator` リポジトリを探すため使いません。完全修飾したformula名で、このtapの `jvo` だけを選択します。

formulaはNode.js 24を依存として導入し、その実体パスで起動します。ご自身のnvm/VoltaなどのNode設定を切り替える必要はありません。既存のcoding CLI、ログイン情報、Jevキーはインストール時に変更しません。

```sh
jvo --version
jvo demo                 # APIキー不要。隔離したローカルのデモ
cd /path/to/your/project
jvo trust
jvo
```

## 更新・削除

```sh
brew update
brew upgrade moto-taka/jev-orchestrator/jvo

# プログラムだけを削除します。作業場・履歴・キーは自動削除しません。
brew uninstall moto-taka/jev-orchestrator/jvo
brew untap moto-taka/jev-orchestrator
```

現行formulaはアプリケーション **0.1.0 / commit `6a122bff5506d521a1230eb78379e3d0dccc13a3`** に固定されています。未検証のmainへ勝手に更新しません。次のリリース時にformulaの `revision`（Git commit指定）と `version` を一緒に更新します。formulaの `revision:` と、Homebrewパッケージ再ビルド番号の `revision 1` は別物です。

## 認証で失敗した場合

```sh
# 読取権限とSSH設定の確認。ファイルの変更はしません。
git ls-remote ssh://git@github.com/moto-taka/jev-orchestrator.git HEAD
```

`Permission denied (publickey)` はSSH認証、`Repository not found` はURLまたは権限を確認してください。キーやトークンをformulaへ埋め込みません。tapのcloneとアプリケーションソースのfetchの**両方**に認証が必要です。

HTTPSを使う場合はGitのcredential helperを先に設定し、同じリポジトリだけに対してSSH→HTTPSを書き換える方法があります。これは任意の手動設定であり、jvoが実行するものではありません。

```sh
# ghを既に利用している環境の例。必要なら先にgh auth loginを行います。
gh auth setup-git
git config --global \
  url."https://github.com/moto-taka/jev-orchestrator.git".insteadOf \
  ssh://git@github.com/moto-taka/jev-orchestrator.git
```

その後、上の通常のtap/install手順を使います。元へ戻すには、上記の同じ設定キーに対して `git config --global --unset-all` を実行します。すべてのGitHub URLを書き換える設定は不要です。

以前npmでインストール済みで `jvo` が競合する場合は、`which -a jvo` で実体を確認してください。npm版の削除を希望する場合だけ `npm uninstall -g jev-orchestrator` を実行します。formulaは `--overwrite` や他のインストール元の自動削除を行いません。

## ビルドとテストの範囲

`Formula/jvo.rb` は、固定commitをGitで取得し、Node標準のtype strippingで `dist/` を生成します。ビルド中にnpmパッケージを取得せず、Jev API・worker・プロジェクトのsetupを呼びません。実行ファイルは `jvo`、資料はHomebrewの `share/jvo` へ配置します。

```sh
brew test moto-taka/jev-orchestrator/jvo
```

formula testは、version/help、実際のGit・SQLite・子プロセスを通す隔離デモ、2回目の同一session修正、最終状態、journalの整合性を確認します。デモのJev判断とworkerはfixtureであり、実APIの成功を示すものではありません。

`.github/workflows/homebrew.yml` はmacOS上で本物の `brew tap` / `brew install` / `brew test` を実行します。privateソースの資格情報を配布しないため、CIではcheckout済みのGit履歴を同じ固定commitのローカルミラーにします。利用者のSSH認証、Linux版Homebrew、実CLI認証はこのCIでは検証しません。CIの実結果はActionsを確認してください。

## 一次資料

- [Homebrew Taps](https://docs.brew.sh/Taps)
- [Formula Cookbook](https://docs.brew.sh/Formula-Cookbook)
- [node@24](https://formulae.brew.sh/formula/node@24)
