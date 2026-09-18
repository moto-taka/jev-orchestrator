# Homebrewでインストールする

このリポジトリ自身をtapとして利用します。インストールのためにリポジトリの公開範囲や資格情報を変更しません。

## 初回

GitHubへSSH接続でき、このリポジトリへの読取権限があるMac/Linuxで実行します。

```sh
brew tap moto-taka/jev-orchestrator \
  ssh://git@github.com/moto-taka/jev-orchestrator.git
brew install moto-taka/jev-orchestrator/jvo
jvo setup
```

2引数のtapで実際のGit URLを指定します。1引数だけの `brew tap moto-taka/jev-orchestrator` は別名の `homebrew-jev-orchestrator` を探すので使いません。

Node.js 24は依存として入り、jvo専用の実体パスで起動します。nvm/Volta等の設定、既存CLIやログイン情報は変更しません。インストール中にJevへ通信しません。

```sh
jvo --version
jvo demo
cd /path/to/your/project
jvo trust
jvo
```

## 0.3.0への更新

```sh
brew update
brew upgrade moto-taka/jev-orchestrator/jvo
jvo --version  # 0.3.0
```

モデルを選び直す場合は `jvo models` です。APIキーの再入力は不要です。新規runは通常配送・限定した修正等をコードで処理します。旧runを新しい制御へ移行する場合だけ、TUIで `/pause` → `/exit` 後に次を実行します。

```sh
jvo resume <run-id> --refresh-policy
```

既存ファイルは保持し、古いテスト・レビュー・継続権限を再確認します。[変更内容](lean-decisions.md)

現行formulaは **0.3.0 / commit `31fed1465a8bf66b61b977ab66889906397f6930`** に固定されています。未検証のmainを自動実行する構成ではありません。次のリリースはFormulaのGit `revision:` と `version` を更新します。

## 認証・競合

```sh
git ls-remote ssh://git@github.com/moto-taka/jev-orchestrator.git HEAD
```

SSH認証や読取権限をここで確認できます。tapのcloneとアプリケーションソース取得の両方に同じGit認証が必要です。キーやトークンをformulaに埋め込みません。

HTTPS認証へ切り替える場合は、Gitのcredential helperを設定した後、このリポジトリだけのURL書換えを任意で設定できます。jvoが自動変更するものではありません。

```sh
gh auth setup-git
git config --global \
  url."https://github.com/moto-taka/jev-orchestrator.git".insteadOf \
  ssh://git@github.com/moto-taka/jev-orchestrator.git
```

npm版と重複する場合は `which -a jvo` で実体を確認してください。不要なnpm版だけ、利用者の判断で `npm uninstall -g jev-orchestrator` を実行します。自動上書きや自動削除は行いません。

## 検証・削除

```sh
brew test moto-taka/jev-orchestrator/jvo
brew uninstall moto-taka/jev-orchestrator/jvo
brew untap moto-taka/jev-orchestrator
```

brew testはversion/help、隔離したGit・SQLite・子プロセスを通す修正デモ、API不要の報告仕分けを確認します。実Jev API、利用者のSSH環境、認証済み各社CLIの成功を意味しません。macOS CIはcheckoutした同じGit履歴をローカルミラーにして、本物のbrew install/testを行います。

アンインストールで作業場、履歴、APIキーは自動削除しません。
