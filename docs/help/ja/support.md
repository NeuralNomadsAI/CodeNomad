# サポートとソースビルド

不具合報告、最新リリース、貢献にはリポジトリを使用します。問題を報告する前の安全な復旧方法は、[トラブルシューティングガイド](troubleshooting.md)を参照してください。

## 不具合を報告する {#report-a-bug}

1. **設定 → 情報 → 診断** を開きます。
2. **バグを報告** を選んで GitHub の Issue フォームを開きます。
3. 事前入力されたバージョン／クライアント情報を確認します。最小の再現手順、期待する動作、実際の結果を追加し、GitHub から送信します。

この操作は、CodeNomad／OpenCode のバージョン、OS、範囲を限定したクライアント／ランタイム情報を事前入力します。リスナーアドレス、ワークスペースパス、認証情報、会話テキストは事前入力しません。フォームを開くことは、Issue の送信ではありません。

より詳しい診断が必要なら、**クリップボードにコピー** または **.txt をダウンロード** で別のレポートを作れます。詳細レポートはローカルパスとネットワークアドレスを含む場合があるため、添付前に確認して伏せ字にしてください。自動診断レポートが認証の秘密情報を除いていても、スクリーンショットやログ抜粋には秘密が含まれる場合があります。

GitHub フォームに互換性のないフィールドがある場合は、同じレポート情報を付けた通常の Issue を開きます。フォーム読み取りの一時的な失敗は、フォームを開く妨げにはなりません。いつでも手動で [Issue 一覧](https://github.com/NeuralNomadsAI/CodeNomad/issues)を使用できます。

## コミュニティとリリース {#community}

| リソース | 用途 |
| --- | --- |
| [CodeNomad リポジトリ](https://github.com/NeuralNomadsAI/CodeNomad) | ソース、プロジェクトの活動、ドキュメント。 |
| [Issue](https://github.com/NeuralNomadsAI/CodeNomad/issues) | 再現可能な不具合や機能要望を投稿する前に、既存の報告を検索します。 |
| [プルリクエスト](https://github.com/NeuralNomadsAI/CodeNomad/pulls) | 提案された変更のレビューや、貢献の調整。 |
| [最新リリース](https://github.com/NeuralNomadsAI/CodeNomad/releases/latest) | 安定版のダウンロード資産。 |
| [全リリース](https://github.com/NeuralNomadsAI/CodeNomad/releases) | 公開済みプレビューとリリースノート。 |
| [Neural Nomads](https://github.com/NeuralNomadsAI) | プロジェクト組織。 |
| [MIT ライセンス](../../../LICENSE) | ライセンス条項。 |

CodeNomad の操作ではなく、OpenCode ネイティブ設定の問題は、[OpenCode ドキュメント](https://opencode.ai/v2/docs/)と[上流リリース](https://github.com/anomalyco/opencode/releases)を参照してください。

## ソースからビルドする {#build-from-source}

`.node-version` に固定された Node.js **24.20.0**、npm、Git、互換性のある OpenCode CLI を使用します。開発用チェックアウトから実行します。

```sh
git clone --branch dev https://github.com/NeuralNomadsAI/CodeNomad.git
cd CodeNomad
npm ci --workspaces --include=optional
npm run dev
```

`npm run dev` は Electron 開発ホストを起動します。Tauri を使う場合は、まず Rust ツールチェーンを含む[プラットフォームのビルド前提条件](https://v2.tauri.app/start/prerequisites/)をインストールし、次を実行します。

```sh
npm run dev:tauri
```

開発上の変更は開発ホストに影響しますが、独立して動く OpenCode デーモンのインストール済みバージョンには影響しません。ネイティブのパッケージ化には対象に合ったツールが必要です。対象 OS 上のビルドを優先してください。

### ビルドと検証 {#build-and-validate}

| リポジトリルートから実行するコマンド | 目的 |
| --- | --- |
| `npm run build` | Electron アプリケーションのリソースをビルド。 |
| `npm run build:tauri` | ネイティブの前提条件を使用して Tauri アプリをビルド。 |
| `npm run build:ui` | ブラウザー UI をビルド。 |
| `npm run build --workspace @neuralnomads/codenomad` | スタンドアロンサーバーと同梱資産をビルド。 |
| `npm run build:linux --workspace @neuralnomads/codenomad-electron-app` | Electron の Debian リリースをパッケージ化。 |
| `npm exec --workspace @codenomad/tauri-app -- tauri build --bundles appimage` | Linux Tauri AppImage をパッケージ化。 |
| `npm run typecheck` | ルートで設定された TypeScript ワークスペースをチェック。 |
| `npm run test:help` | 公開ヘルプの全言語とリンクを検証。 |
| `npm run build:help` | スタンドアロンの公開ヘルプを `dist/help` にビルド。 |

ヘルプのビルドに、稼働中の CodeNomad や OpenCode サービスは不要です。パッケージ化の詳細は [BUILD.md](../../../BUILD.md)、対象を絞った検証と PR の規約は [CONTRIBUTING.md](../../../CONTRIBUTING.md) を参照してください。対象パッケージに実際に存在するスクリプトを使用します。

## パッケージ構成と貢献 {#contribute}

| パッケージ | 役割 |
| --- | --- |
| `packages/server` | ワークスペース／API／Git の制御、OpenCode 接続、認証、イベント、音声。 |
| `packages/ui` | SolidJS のワークスペース、操作 UI、翻訳、ブラウザーヘルプの入口。 |
| `packages/electron-app` | Electron のウィンドウ、ネイティブ連携、パッケージ化。 |
| `packages/tauri-app` | Tauri のウィンドウ、プラットフォーム連携、パッケージ化。 |
| `packages/remote-tunnel` | バックエンド側の OpenTunnel 通信ランタイム。 |

1. 重複する作業を実装する前に、関連 Issue で範囲を相談します。
2. `dev` からブランチを作り、変更を絞ります。
3. 影響範囲のチェックを実行し、動作とともにユーザーヘルプも更新し、PR の宛先を `dev` にします。

公開ヘルプのソースは `docs/help/<locale>/` にあります。各言語で英語見出しの明示的な ID、レベル、順序を保持してください。見出しの翻訳でディープリンクを壊してはいけません。厳格な完全性チェックと静的公開パイプラインは、[ヘルプ保守の契約](../../../dev-docs/USER_HELP.md)で説明しています。
