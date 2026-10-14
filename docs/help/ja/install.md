# CodeNomad のインストール

ローカルのデスクトップホストを選ぶか、[スタンドアロンサーバー](server.md)を実行します。どちらの場合も、共有ネイティブサービスと履歴は OpenCode が管理します。

## デスクトップ版のダウンロード {#desktop-downloads}

1. [最新リリース](https://github.com/NeuralNomadsAI/CodeNomad/releases/latest)を開きます。
2. お使いの OS とプロセッサーに合うビルドを選びます。
3. ZIP を展開するか、プラットフォーム用パッケージをインストール／実行し、CodeNomad を起動します。

| プラットフォーム | Electron リリース | Tauri リリース | 注意事項 |
| --- | --- | --- | --- |
| macOS | ZIP、Intel または Apple Silicon | ZIP、Intel または Apple Silicon | 同梱ランタイムには macOS 13.5 以降が必要です。 |
| Windows | ZIP、x64 | インストーラー、x64 | Windows 10 以降。Tauri は WebView2 を使用します。 |
| Linux | Debian パッケージ、x64 | AppImage、x64 | Ubuntu 24.04 でビルド・テスト済み。古いディストリビューションとの互換性は保証されません。 |

デスクトップリリースには、バックエンドと OpenCode インストーラーに必要なランタイムリソースが含まれるため、別途 Node.js/npm をインストールする必要はありません。Git は同梱されません。ネイティブのブラウザー自動操作は Electron と Windows Tauri でサポートされ、その他の Tauri 環境は iframe プレビューを使用します。

確認済みのダウンロードが起動時にブロックされる場合は、[プラットフォーム別のトラブルシューティング](troubleshooting.md#desktop-launch)を参照してください。警告を回避するためだけに、信頼できないアーカイブを実行しないでください。

## Linux へのインストール {#linux-install}

ダウンロードしたリリースがあるフォルダーで、実際のバージョンとファイル名に置き換えて実行します。

```sh
sudo apt install ./CodeNomad-Electron-linux-x64-<version>.deb
```

Tauri AppImage の場合：

```sh
chmod +x CodeNomad-Tauri-linux-x64-<version>.AppImage
./CodeNomad-Tauri-linux-x64-<version>.AppImage
```

FUSE が利用できない場合は、AppImage の展開・実行モードを使用します。

```sh
./CodeNomad-Tauri-linux-x64-<version>.AppImage --appimage-extract-and-run
```

Electron の Debian インストールでは Chromium のサンドボックスを設定します。インストールの回避策としてサンドボックスを無効にしないでください。Linux Tauri のグラフィックス問題には、[対象を限定した WebKit の回避策](troubleshooting.md#desktop-launch)があります。

## 要件 {#requirements}

| 要件 | 必要な場所 | 現在の要件 |
| --- | --- | --- |
| OpenCode CLI | 該当する場合は選択した WSL ディストリビューションを含む、選択した実行ホスト | 最低 **2.0.27**。推奨／検証済みの対象は **2.0.29**。新しいバージョンやカスタム版は、未テストという理由で禁止せず、契約を検証します。 |
| Git | CodeNomad バックエンドのアカウントの `PATH` | リポジトリの識別、Git 操作、ワークツリーに必要です。 |
| Node.js/npm | スタンドアロンサーバーおよびソースビルドのホスト | Node.js 24 LTS。再現可能なソースビルドは `.node-version`（**24.20.0**）を使用します。デスクトップのランタイム／インストールリソースに同梱されています。 |
| ワークスペースフォルダー | バックエンドからアクセスできるディスク | 明示的に開いた物理フォルダー。リモートブラウザーから推測した端末ローカルのフォルダーではありません。 |

Windows では、コマンドライン／サードパーティーからのアクセスを有効にして [Git for Windows](https://gitforwindows.org/) をインストールしてください。ユーザーが書き込めるユーザー単位のインストールで十分です。macOS/Linux では、[Git のプラットフォーム別手順](https://git-scm.com/downloads)を使用してください。

`PATH` を変更した後は、デスクトップアプリを完全に終了して再起動するか、意図したアカウントでスタンドアロンバックエンドを再起動します。ブラウザーを再読み込みしても、バックエンドの環境は更新されません。WSL 内だけにある Git では、Windows バックエンドの Git 要件を満たせません。

Git がなくても、物理フォルダーを開き、エージェントにインストールの支援を頼むなど、ディレクトリ専用の会話を利用できます。リポジトリ／ワークツリー操作は利用できず、セッションへのアクセスはそのフォルダーのみに制限されます。CodeNomad は、プロンプト／カスタムコマンドの前にバックエンドの Git 利用可否をエージェントへ伝え、復旧後はその通知を取り除きます。エージェントの実行ホストとバックエンドホストは異なる場合があるため、エージェントのシェルだけでなく、バックエンド用に Git をインストールしてください。

## 初回起動時に OpenCode を選ぶ {#first-launch}

1. セットアップで、互換性のある既存の実行ファイルを選ぶか、提示された OpenCode のインストール操作を使用します。
2. プロジェクトを開く前にランタイムの状態を確認します。
3. 実行ファイル、インストール、共有サービスを個別に管理するには、**設定 → OpenCode** を開き直します。

CodeNomad は、互換性のある `PATH` 上の実行ファイルを優先し、明示的に選択した実行ファイルもサポートします。CLI をインストール／更新しても、実行中の共有サービスが無断で再起動されることはありません。再起動／再読み込みの影響、WSL、セッション環境については、[OpenCode のセットアップ](opencode.md)を参照してください。

## ブラウザーを使う {#browser-install}

サーバーホストに Node.js/npm、Git、OpenCode をインストールし、[サーバーの起動手順](server.md)を使用します。表示されたアドレス、設定した認証、信頼された証明書を使用して接続してください。ブラウザー／PWA には稼働中のバックエンドが必要であり、プロジェクトのオフラインコピーではありません。

ポート、バインド、TLS については、[直接アクセス](remote-access.md)を参照してください。受信ポートを開かずに端末をペアリングするには、[リモートコントロール](remote-control.md)を使用します。開発やパッケージ化のコマンドは、[ソースビルド](support.md#build-from-source)を参照してください。
