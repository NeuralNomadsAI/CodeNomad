# スタンドアロンサーバー

プロジェクトとツールがある場所で CodeNomad を実行し、ローカルまたはリモートからブラウザー UI を使います。バックエンドはファイルシステムへのアクセス、Git 操作、認証、イベント配信を提供します。会話と実行は OpenCode の共有サービスが管理し、ブラウザー切断時に停止する子サーバーではありません。

同じ UI で、[複数プロジェクトタブとワークツリー](projects.md)、[会話ファミリーとバックグラウンドのアクティビティ](conversations.md)、[範囲制限付きの履歴読み込み、検索、タイムライン移動](history.md)、[コマンドパレットとショートカット](shortcuts.md)、[ミッション](missions.md)を利用できます。ブラウザーやタブレットからアクセスしても、実行はホストから移りません。

## ホストを準備する {#prerequisites}

1. Node.js 24 LTS と npm をインストールします。リポジトリの固定ビルドランタイムは 24.20.0 です。デスクトップパッケージには Node/npm が含まれます。
2. **バックエンドプロセスの PATH** に Git を配置します。WSL 内だけの Git では Windows バックエンドの要件を満たしません。
3. OpenCode をインストールまたは選択します。必須の最低バージョンは **2.1.2**、推奨検証対象は **2.1.4** です。新しい／カスタムビルドは、テスト済みバージョンの許可リストではなく、互換性チェックを受けます。[OpenCode のセットアップ](opencode.md)を参照してください。
4. サーバーを起動するフォルダーを選ぶか、`--workspace-root` を明示します。

Git がない場合、会話は明示的に開いた物理フォルダー内だけで利用でき、Git とワークツリー操作は失敗します。Git をインストールし、PATH 変更後にバックエンドを再起動してください。ワークスペースルートは開く／参照する範囲の制限であり、エージェント実行の制限ではありません。[セキュリティ](security.md)を参照してください。

## 実行・インストール {#run}

インストール方法を 1 つ選びます。以下の初回起動例は、シェル履歴にパスワードを残さず、ローカル初期設定を使います。

### npx で実行する {#npx}

```sh
npx @neuralnomads/codenomad --generate-token --launch
```

### グローバルにインストールする {#global-install}

```sh
npm install -g @neuralnomads/codenomad
codenomad --generate-token --launch
```

### プロジェクトにインストールする {#local-install}

```sh
npm install @neuralnomads/codenomad
npx codenomad --generate-token --launch
```

`npx codenomad` は、プロジェクトにインストール済みのバイナリがあればそれを使用します。パッケージをそのプロジェクトにインストールしますが、設定や OpenCode ストレージがプロジェクトローカルになるわけ **ではありません**。

1. ホストで、表示された **Local Connection URL** を開きます。[ローカル初期設定](security.md)を完了し、永続的なサーバーパスワードを保存します。まだ HTTPS の信頼を設定していない場合に使える、ループバック専用 HTTP の初期設定方法も含まれています。
2. 以後の起動では `--generate-token` を省くか、毎回 `CODENOMAD_SERVER_PASSWORD` を指定します。
3. `codenomad --help` で、インストール済み CLI のオプションを確認します。

コマンドはフォアグラウンドで実行します。ターミナルを閉じるか Ctrl+C を送ると、そのバックエンドとリモートコントロール接続が停止します。`--launch` はブラウザーを開くだけで、サーバーをデーモン化しません。無人で利用可能にするには、設定、作業ディレクトリ、環境、再起動ポリシーを明示して、OS のプロセス／サービス管理機能から同じコマンドを実行してください。サービスログや公開されたユニットファイルに秘密情報を入れないでください。

ブラウザーを閉じても、別に稼働するスタンドアロンバックエンドは停止しません。プロジェクトタブを閉じるとそのプロジェクトの CodeNomad 接続は削除されますが、セッションは OpenCode で続き、プロジェクトを開き直すと再び確認できます。CodeNomad がネイティブの Location を解放することはありません。ウィンドウ全体を閉じる、終了する、再読み込みする場合は、復元のためにプロジェクト接続が保持されます。バックエンドの終了時も同様に OpenCode サービスは稼働したままです。CodeNomad が戻るまで、バックエンド依存の機能は利用できません。独立したネイティブのスケジュールの寿命は、[ミッション](missions.md)を参照してください。

## アドレスとポート {#addresses}

起動時に **Local Connection URL**、利用可能なら **Remote Connection URL**、該当する場合は **Other Accessible URLs** を表示します。推測したアドレスではなく、表示されたスキームとポートを使用してください。ループバック URL はそのマシンからしか到達できず、表示された LAN アドレスも経路とファイアウォールの許可が必要です。

HTTPS は **9898**、HTTP は **9899** を優先します。ポート指定がなく優先ポートが使用中なら、OS 割り当てポートにフォールバックします。ゼロ以外のポートを明示した場合はフォールバックせず、`0` は OS 割り当てを要求します。ポートは 0〜65535 の整数を受け付けます。

バックエンドは、ミッションなど自身の OpenCode プラグインのために、ランダムな `127.0.0.1` ポートで、通知されない認証付きの HTTP リスナーを開く場合もあります。このリスナーは表示されず、クライアントの接続先アドレスではありません。

リスナー公開、証明書、VPN/SSH、リバースプロキシは、[直接リモートアクセス](remote-access.md)を参照してください。受信ポートなしのアクセスには、[リモートコントロール](remote-control.md)を使用します。

## 公開 CLI リファレンス {#cli-reference}

フラグは対応する環境変数より優先します。値を取るフラグには表示した引数を指定し、スイッチには指定しません。HTTPS/HTTP の値は、大文字小文字を区別せず `1`、`true`、`yes`、`y`、`on` を有効と認識します。明確にするため `true`／`false` を明示してください。UI 自動更新は `1`、`true`、`yes` を認識します。

**厳密なブール値を取る環境変数**（`CLI_UNRESTRICTED_ROOT`、`CLI_UI_NO_UPDATE`、`CLI_LAUNCH`、`CODENOMAD_GENERATE_TOKEN`、`CODENOMAD_SKIP_AUTH`）は、`1`、`true`、`yes`、`on` でスイッチを有効にします。大文字・小文字と前後の空白は無視されます。`0`、`false`、`no`、`off`、空または空白のみの値、未定義の変数ではスイッチは無効のままです。それ以外の値では、対応する CLI フラグを指定してもサーバーは起動しません。CLI フラグは、有効な無効化値より優先してスイッチを有効にします。それ以外の場合は下表の既定値 `false` が適用されます。

| フラグ | 環境変数 | 既定値と効果 |
| --- | --- | --- |
| `-h, --help` | — | ヘルプを表示して終了。 |
| `-v, --version` | — | インストール済みパッケージのバージョンを表示して終了。 |
| `--host <host>` | `CLI_HOST` | `127.0.0.1`。`localhost` は IPv4 ループバックに正規化。IPv6 ゾーン識別子は拒否。[バインド表](remote-access.md)を参照。 |
| `--https <enabled>` | `CLI_HTTPS` | `true`。HTTPS リスナー。 |
| `--http <enabled>` | `CLI_HTTP` | `false`。HTTP リスナー。最低 1 つのリスナーを有効にする必要があります。 |
| `--https-port <number>` | `CLI_HTTPS_PORT` | `9898` を優先。`0` は自動。 |
| `--http-port <number>` | `CLI_HTTP_PORT` | `9899` を優先。`0` は自動。 |
| `--tls-key <path>` | `CLI_TLS_KEY` | 未設定。PEM 秘密鍵。`--tls-cert` が必要。 |
| `--tls-cert <path>` | `CLI_TLS_CERT` | 未設定。PEM 証明書。`--tls-key` が必要。 |
| `--tls-ca <path>` | `CLI_TLS_CA` | 未設定。指定証明書用の任意の PEM CA チェーン。 |
| `--tlsSANs <list>` | `CLI_TLS_SANS` | 未設定。生成証明書用の追加 DNS 名／IP をカンマ区切りで指定。 |
| `--workspace-root <path>` | `CLI_WORKSPACE_ROOT` | プロセスの作業ディレクトリ。ワークスペースを開くルート。 |
| `--unrestricted-root` | `CLI_UNRESTRICTED_ROOT` | `false`。ファイルシステム全体の参照を許可。エージェントのサンドボックス設定ではありません。 |
| `--config <path>` | `CLI_CONFIG` | 解決される有効な既定値は `~/.config/codenomad/config.yaml`。明示配置にはディレクトリまたは YAML ファイルを指定可能。 |
| `--log-level <level>` | `CLI_LOG_LEVEL` | `info`。文書化されたレベルは `trace`、`debug`、`info`、`warn`、`error`。 |
| `--log-destination <path>` | `CLI_LOG_DESTINATION` | `stdout`。それ以外は指定ファイルに書き込み。 |
| `--username <username>` | `CODENOMAD_SERVER_USERNAME` | `codenomad`。実行時認証ユーザー名。実行時パスワードで上書きされなければ、保存済み認証ファイルは保存済みユーザー名を保持。 |
| `--password <password>` | `CODENOMAD_SERVER_PASSWORD` | 未設定。実行時のみのパスワード。管理対象の認証ファイルより優先。 |
| `--auth-cookie-name <name>` | `CODENOMAD_AUTH_COOKIE_NAME` | `codenomad_session`。英数字、`_`、`-` 以外の文字は `_` に置換。 |
| `--generate-token` | `CODENOMAD_GENERATE_TOKEN` | `false`。使い捨てで 60 秒有効のローカル初期設定トークンを表示。 |
| `--dangerously-skip-auth` | `CODENOMAD_SKIP_AUTH` | `false`。直接リスナーの認証を無効化。危険：[セキュリティ](security.md)を参照。リモートコントロールには引き続き端末のペアリングが必要。 |
| `--ui-dir <path>` | `CLI_UI_DIR` | パッケージの `public` ディレクトリ。明示指定するとリモート UI 解決ではなく、その UI を配信。 |
| `--ui-dev-server <url>` | `CLI_UI_DEV_SERVER` | 未設定。HTTP リスナー経由で UI をプロキシ。開発には `--https=false --http=true` を使用。HTTPS リスナーは開発 UI をプロキシしません。 |
| `--ui-no-update` | `CLI_UI_NO_UPDATE` | `false`。自動更新を上書きし、利用可能なキャッシュ／同梱 UI を使用。 |
| `--ui-auto-update <enabled>` | `CLI_UI_AUTO_UPDATE` | `true`。起動時に互換性のあるリモート UI を確認。 |
| `--ui-manifest-url <url>` | `CLI_UI_MANIFEST_URL` | `https://ui.codenomad.neuralnomads.ai/version.json`。リモート UI マニフェスト。 |
| `--launch` | `CLI_LAUNCH` | `false`。起動後にローカル UI をブラウザーで開く。 |
| `--upgrade [version]` | — | 既定では更新なし。要求時は `@neuralnomads/codenomad@latest` または指定バージョンをグローバルインストールして終了。 |

公開リファレンスはユーザー向けオプションを列挙しています。デスクトップホストは非公開の起動調整を自ら管理します。

### 追加の配備用環境変数 {#deployment-environment}

| 変数 | 既定値と範囲 |
| --- | --- |
| `CODENOMAD_GITHUB_REPO` | `NeuralNomadsAI/CodeNomad`。リリース提示の問い合わせ先リポジトリ。 |
| `CODENOMAD_REMOTE_CONTROL_API` | 未設定ならホスト型 OpenTunnel API。セルフホストのリレー配備には API オリジンを指定。 |
| `NODE_EXTRA_CA_CERTS` | Node の任意の追加 CA ファイル。OpenCode デーモンがないため起動する際、許可された起動環境とともに渡します。既に稼働中のデーモンは変更しません。 |

プロバイダー固有の使用量認証情報は、[プロバイダー](providers.md)で説明しています。デスクトップのデータプロファイル選択は[デスクトップ](desktop.md)を参照してください。リリースフィードで制御するものではありません。

## 設定とストレージの管理元 {#storage}

以下の既定パスはバックエンドユーザーのホームを使用します。`--config` でディレクトリを明示すると設定ベースが変わり、YAML ファイル名を指定すると、そのファイルと隣接する状態／ストレージが選ばれます。1 つの配備には意図した 1 つの設定識別を使用し、ディレクトリ全体を OS 権限で保護してください。

| 管理元／データ | 既定の場所または規則 |
| --- | --- |
| 安定した CodeNomad 設定 | `~/.config/codenomad/config.yaml` |
| 可変の CodeNomad 状態 | `~/.config/codenomad/state.yaml` |
| CodeNomad インスタンスのメタデータ | `~/.config/codenomad/instances/` |
| パスワードハッシュ | アクティブな YAML 設定の隣の `auth.json`。アプリ管理。 |
| 生成 TLS 証明書と秘密鍵 | 設定ベース配下の `tls/`。 |
| リモートコントロールのルート、有効化の選択、端末ハッシュ | 設定ベース配下の `remote-control-devices.json`。 |
| 一時ワークスペースの登録簿とフォルダー | 同ベース配下の `temporary-workspaces.json` と `temporary-workspaces/`。 |
| インストール済みパネル拡張機能と権限の記録 | 同ベース配下の `panel-extensions/` と `permission-receipts/`。 |
| ダウンロードした UI キャッシュ | `~/.config/codenomad/ui/`。独自の `--config` でも、CLI の UI リゾルバーはこのホーム基準のキャッシュを使用。 |
| OpenCode の会話、メッセージ、サービス登録、プロバイダー接続 | CodeNomad インスタンスディレクトリではなく、実行ホスト上の OpenCode 自身のグローバルストレージ。 |
| デスクトップの復元状態 | 既定は `~/.codenomad/client-state/v2/`。プロファイル／ウィンドウの範囲は[デスクトップ](desktop.md)を参照。 |

CodeNomad は既存の共有デーモンに接続し、なければ起動します。起動環境は新たに起動したデーモンだけに影響します。これとは別に、設定した完全なセッション環境は、各プロンプト、カスタムコマンド、セッションシェルリクエストの前に適用されます。設定を表示・編集するだけでは適用しません。[OpenCode のセットアップ](opencode.md)を参照してください。

## イベントと再接続 {#events}

バックエンドは共有の OpenCode ネイティブイベントストリームを受信し、Server-Sent Events でワークスペースと CodeNomad のイベントをブラウザークライアントに多重配信します。配信はライブかつ一時的で、**イベントの再生は保証されません**。

再接続後、UI は正規のセッションと保留リクエストの状態を再取得します。ファイル／設定の無効化通知も、新たな読み取りを起こします。再接続は、応答が消失した送信、削除、回答、その他の変更操作を繰り返す許可ではありません。まず結果の状態を確認してください。復旧が不完全なら、既知の保留リクエストと下書きを保持します。[権限](permissions.md)と[トラブルシューティング](troubleshooting.md)を参照してください。

## プレビューパッケージと保守 {#maintenance}

プレビュー CLI パッケージを明示的に試すには：

```sh
npx @neuralnomads/codenomad-dev --generate-token --launch
```

CodeNomad 設定を分離する必要がある場合は、意図的に別の設定を使用してください。パッケージの選択では共有 OpenCode ストレージは分離されません。**設定 → 情報 → 更新 → アップデートチャネル** が制御するのは、提示されるリリースであり、バックエンドのデータ識別やインストール済みパッケージではありません。

`codenomad --upgrade` は、検出した npm/pnpm/bun（検出できなければ npm）で、グローバルの安定版 CLI パッケージを更新します。稼働中のサーバーの再起動や OpenCode の更新はしません。プロジェクトローカルやプレビューのインストールでは、その正確な npm パッケージを明示的に更新します。更新後は、管理している CodeNomad プロセスを意図的に再起動し、表示アドレスを再確認してください。

デスクトップの保守は[更新](updates.md)、ソースビルドコマンドは[サポート](support.md)、プロバイダープランの使用量は[プロバイダー](providers.md)を参照してください。
