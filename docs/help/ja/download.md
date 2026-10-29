# CodeNomad をダウンロード

Windows、macOS、Linux 向けの無料のオープンソース（MIT）デスクトップアプリです。お使いの OpenCode サービスに接続します。まず[要件](install.md#requirements)を確認してください。

## デスクトップアプリ {#desktop}

{{release}}

{{download-button}}

| プラットフォーム | Tauri（推奨） | Electron |
| --- | --- | --- |
| Windows 10 以降 | [インストーラー、x64](release:tauri-windows-x64) | [ZIP、x64](release:electron-windows-x64) |
| macOS 13.5 以降 | [ZIP、Apple Silicon](release:tauri-macos-arm64) · [ZIP、Intel](release:tauri-macos-x64) | [ZIP、Apple Silicon](release:electron-macos-arm64) · [ZIP、Intel](release:electron-macos-x64) |
| Linux x64（Ubuntu 24.04 でテスト済み） | [AppImage、x64](release:tauri-linux-x64) | [Debian パッケージ、x64](release:electron-linux-x64) |

どちらのビルドも同じワークスペースを提供します。Tauri はアプリ内から更新をインストールできます。Electron は新しいリリースをダウンロードして更新し、すべてのプラットフォームでネイティブのブラウザー自動操作をサポートします（Tauri は Windows のみ）。[ビルドを比較する](install.md#desktop-downloads)。

## パッケージマネージャー {#package-managers}

Windows では、winget で Tauri ビルドがインストールされます。

```sh
winget install NeuralNomadsAI.CodeNomad
```

CodeNomad をスタンドアロンサーバーとして実行してブラウザーで使うには、Node.js 24 があるホストで npm を使って起動します。

```sh
npx @neuralnomads/codenomad --generate-token --launch
```

[スタンドアロンサーバー](server.md#run)のページでは、初回ログイン、グローバルインストール、アドレス、認証を説明しています。[要件](install.md#requirements)には Node.js、Git、OpenCode が記載されています。

## インストールと初回起動 {#verify-and-install}

ダウンロードはこのページまたは[公式リリース](https://github.com/NeuralNomadsAI/CodeNomad/releases)からのみ行い、警告を回避するためだけに信頼できないアーカイブを実行しないでください。

- **Linux**：AppImage を実行可能にするか、Debian パッケージをインストールします。[Linux へのインストール](install.md#linux-install)を参照してください。
- **macOS**：macOS が初回起動をブロックする場合は、[macOS の隔離属性](troubleshooting.md#macos-quarantine)を参照してください。
- **すべてのプラットフォーム**：[要件](install.md#requirements)に記載された Git と互換性のある OpenCode CLI をインストールし、[初回起動時に OpenCode を選びます](install.md#first-launch)。その他の起動の問題は[トラブルシューティング](troubleshooting.md#desktop-launch)で説明しています。

## 開発を支援する {#support-development}

CodeNomad は無料で、ボランティアが自分の時間で保守しています。あなたやチームの役に立っているなら、支援は CodeNomad の保守と、新しい OpenCode リリースとの互換性の維持に役立ちます。支援金の使い道は[CodeNomad を支援する](sponsor.md)のページで説明しています。

{{funding}}
