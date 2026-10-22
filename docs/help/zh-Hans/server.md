# 独立服务器

在项目和工具所在位置运行 CodeNomad，然后在本地或远程使用浏览器界面。后端提供文件系统访问、Git 操作、认证和事件交付。OpenCode 共享服务管理对话和执行；它不是浏览器断开后就应停止的子服务器。

同一界面支持[多个项目标签页和工作树](projects.md)、[对话族和后台活动](conversations.md)、[有界历史加载、搜索和时间线导航](history.md)、[命令面板和快捷键](shortcuts.md)，以及[任务](missions.md)。浏览器和平板访问不会将执行移离主机。

## 准备主机 {#prerequisites}

1. 安装 Node.js 24 LTS 和 npm；仓库固定构建运行时为 24.20.0。桌面包包含 Node/npm。
2. 将 Git 加入**后端进程的 PATH**。仅 WSL 内的 Git 不满足 Windows 后端。
3. 安装或选择 OpenCode：必需最低版本为 **2.1.2**，推荐验证目标为 **2.1.3**。更新或自定义构建会接受兼容检查，而非已测试版本白名单。参阅 [OpenCode 设置](opencode.md)。
4. 选择启动服务器的文件夹，或显式传入 `--workspace-root`。

没有 Git 时，对话仅在显式打开的物理文件夹内可用；Git 和工作树操作失败。安装 Git，更改 PATH 后重启后端。工作区根目录限制打开/浏览，而非智能体执行：参阅[安全](security.md)。

## 运行或安装 {#run}

选择一种安装方式。以下首次运行示例使用本地初始化，而非将密码写入 Shell 历史：

### 使用 npx 运行 {#npx}

```sh
npx @neuralnomads/codenomad --generate-token --launch
```

### 全局安装 {#global-install}

```sh
npm install -g @neuralnomads/codenomad
codenomad --generate-token --launch
```

### 在项目中安装 {#local-install}

```sh
npm install @neuralnomads/codenomad
npx codenomad --generate-token --launch
```

存在项目安装的二进制时，`npx codenomad` 会使用它。这将软件包安装到该项目；**不会**使配置或 OpenCode 存储变为项目本地。

1. 在主机打开打印的 **Local Connection URL**。完成[本地初始化](security.md)，然后保存持久服务器密码。如果尚未配置 HTTPS 信任，该流程也包含仅回环 HTTP 设置选项。
2. 后续启动省略 `--generate-token`；也可每次启动都提供 `CODENOMAD_SERVER_PASSWORD`。
3. 使用 `codenomad --help` 查看已安装 CLI 选项。

命令在前台运行。关闭终端或发送 Ctrl+C 会停止该后端及其远程控制连接。`--launch` 仅打开浏览器；不会让服务器成为守护进程。需要无人值守可用性时，在操作系统进程/服务管理器下运行同一命令，并显式指定配置、工作目录、环境和重启策略。不要将秘密写入服务日志或公开 unit 文件。

关闭浏览器不会停止单独运行的独立后端。关闭项目标签页会在 CodeNomad 中关闭该项目，CodeNomad 不再跟踪该连接。OpenCode Location 不会卸载，会话继续运行；重新打开项目即可再次找到。关闭后端同样让 OpenCode 服务继续运行。依赖后端的功能会在 CodeNomad 返回前不可用；独立的原生调度生命周期参阅[任务](missions.md)。

## 地址与端口 {#addresses}

启动时打印 **Local Connection URL**，可用时还打印 **Remote Connection URL**，适用时另有 **Other Accessible URLs**。请使用打印的协议和端口，不要猜地址。回环 URL 仅在该机器可达；打印的局域网地址仍需要路由和防火墙访问。

HTTPS 首选端口 **9898**，HTTP 首选 **9899**。没有端口覆盖时，首选端口被占用会回退到操作系统分配端口。显式非零端口不回退；`0` 请求操作系统分配。端口接受 0 至 65535 的整数。

后端还可能在随机的 `127.0.0.1` 端口上打开一个不公布、需认证的 HTTP 监听器，供其自身的 OpenCode 插件（如任务）使用。它不会被打印，也不是客户端地址。

监听器暴露、证书、VPN/SSH 和反向代理请参阅[直接远程访问](remote-access.md)。无需入站端口的访问请使用[远程控制](remote-control.md)。

## 公共 CLI 参考 {#cli-reference}

标志覆盖对应环境变量。带值标志使用所示参数；开关不带值。HTTPS/HTTP 值不区分大小写，将 `1`、`true`、`yes`、`y` 和 `on` 识别为启用；为清晰起见请显式使用 `true`/`false`。界面自动更新识别 `1`、`true` 和 `yes`。

**严格布尔环境变量**（`CLI_UNRESTRICTED_ROOT`、`CLI_UI_NO_UPDATE`、`CLI_LAUNCH`、`CODENOMAD_GENERATE_TOKEN` 和 `CODENOMAD_SKIP_AUTH`）在值为 `1`、`true`、`yes` 或 `on` 时启用相应开关，忽略大小写及两端空白。`0`、`false`、`no`、`off`、空值、仅含空白的值或未设置的变量均让开关保持关闭。任何其他值都会阻止服务器启动，即使指定了对应的 CLI 标志。CLI 标志可覆盖有效的关闭值并启用开关；否则使用下列 `false` 默认值。

| 标志 | 环境变量 | 默认值与影响 |
| --- | --- | --- |
| `-h, --help` | — | 打印帮助并退出。 |
| `-v, --version` | — | 打印已安装软件包版本并退出。 |
| `--host <host>` | `CLI_HOST` | `127.0.0.1`；`localhost` 规范化为 IPv4 回环。拒绝 IPv6 区域标识符。参阅[绑定矩阵](remote-access.md)。 |
| `--https <enabled>` | `CLI_HTTPS` | `true`；HTTPS 监听器。 |
| `--http <enabled>` | `CLI_HTTP` | `false`；HTTP 监听器。至少启用一个监听器。 |
| `--https-port <number>` | `CLI_HTTPS_PORT` | 首选 `9898`；`0` 自动。 |
| `--http-port <number>` | `CLI_HTTP_PORT` | 首选 `9899`；`0` 自动。 |
| `--tls-key <path>` | `CLI_TLS_KEY` | 未设置；PEM 私钥，要求 `--tls-cert`。 |
| `--tls-cert <path>` | `CLI_TLS_CERT` | 未设置；PEM 证书，要求 `--tls-key`。 |
| `--tls-ca <path>` | `CLI_TLS_CA` | 未设置；所提供证书的可选 PEM CA 链。 |
| `--tlsSANs <list>` | `CLI_TLS_SANS` | 未设置；为生成证书添加的逗号分隔 DNS 名/IP。 |
| `--workspace-root <path>` | `CLI_WORKSPACE_ROOT` | 进程工作目录；打开工作区的根目录。 |
| `--unrestricted-root` | `CLI_UNRESTRICTED_ROOT` | `false`；允许浏览整个文件系统。不是智能体沙箱设置。 |
| `--config <path>` | `CLI_CONFIG` | 解析后的活动默认值：`~/.config/codenomad/config.yaml`。接受目录或 YAML 文件以显式指定位置。 |
| `--log-level <level>` | `CLI_LOG_LEVEL` | `info`；文档级别：`trace`、`debug`、`info`、`warn`、`error`。 |
| `--log-destination <path>` | `CLI_LOG_DESTINATION` | `stdout`；否则写入指定文件。 |
| `--username <username>` | `CODENOMAD_SERVER_USERNAME` | `codenomad`；运行时认证用户名。没有运行时密码覆盖时，已存储认证文件保留其用户名。 |
| `--password <password>` | `CODENOMAD_SERVER_PASSWORD` | 未设置；仅运行时密码，优先于受管理认证文件。 |
| `--auth-cookie-name <name>` | `CODENOMAD_AUTH_COOKIE_NAME` | `codenomad_session`；字母、数字、`_` 和 `-` 之外的字符变为 `_`。 |
| `--generate-token` | `CODENOMAD_GENERATE_TOKEN` | `false`；打印一次性、有效 60 秒的本地初始化令牌。 |
| `--dangerously-skip-auth` | `CODENOMAD_SKIP_AUTH` | `false`；禁用直接监听器认证。危险：参阅[安全](security.md)。远程控制仍要求设备配对。 |
| `--ui-dir <path>` | `CLI_UI_DIR` | 软件包的 `public` 目录；显式覆盖时提供该界面，而非解析远程界面。 |
| `--ui-dev-server <url>` | `CLI_UI_DEV_SERVER` | 未设置；通过 HTTP 监听器代理界面。开发时使用 `--https=false --http=true`；HTTPS 监听器不代理开发界面。 |
| `--ui-no-update` | `CLI_UI_NO_UPDATE` | `false`；覆盖自动更新，使用可用的缓存/随附界面。 |
| `--ui-auto-update <enabled>` | `CLI_UI_AUTO_UPDATE` | `true`；启动时检查兼容远程界面。 |
| `--ui-manifest-url <url>` | `CLI_UI_MANIFEST_URL` | `https://ui.codenomad.neuralnomads.ai/version.json`；远程界面清单。 |
| `--launch` | `CLI_LAUNCH` | `false`；启动后在浏览器打开本地界面。 |
| `--upgrade [version]` | — | 默认不升级。请求时，全局安装 `@neuralnomads/codenomad@latest` 或所提供版本，然后退出。 |

公共参考列出面向用户的选项；桌面宿主管理自身私有启动协调。

### 其他部署环境 {#deployment-environment}

| 变量 | 默认值与范围 |
| --- | --- |
| `CODENOMAD_GITHUB_REPO` | `NeuralNomadsAI/CodeNomad`；查询发行版本的仓库。 |
| `CODENOMAD_REMOTE_CONTROL_API` | 未设置：托管 OpenTunnel API。自托管中继部署时设置 API 来源。 |
| `NODE_EXTRA_CA_CERTS` | Node 可选额外 CA 文件；启动缺失的 OpenCode 守护进程时与允许的启动环境一起传递。不改变已运行守护进程。 |

提供商专用用量凭据见[提供商](providers.md)。桌面数据配置文件选择见[桌面](desktop.md)，不受发布通道控制。

## 配置与存储归属 {#storage}

以下默认路径使用后端用户主目录。显式 `--config` 目录改变配置根目录；YAML 文件名选择该文件及同级状态/存储。每个部署请有意识地使用一个配置身份，并用操作系统权限保护整个目录。

| 所有者/数据 | 默认位置或规则 |
| --- | --- |
| 稳定 CodeNomad 偏好 | `~/.config/codenomad/config.yaml` |
| 可变 CodeNomad 状态 | `~/.config/codenomad/state.yaml` |
| CodeNomad 实例元数据 | `~/.config/codenomad/instances/` |
| 密码哈希 | 活动 YAML 配置旁的 `auth.json`；应用管理。 |
| 生成的 TLS 证书和私钥 | 配置根目录下的 `tls/`。 |
| 远程控制路由、启用选择和设备哈希 | 配置根目录下的 `remote-control-devices.json`。 |
| 临时工作区注册表和文件夹 | 该根目录下的 `temporary-workspaces.json` 和 `temporary-workspaces/`。 |
| 已安装面板扩展和权限回执 | 该根目录下的 `panel-extensions/` 和 `permission-receipts/`。 |
| 下载界面缓存 | `~/.config/codenomad/ui/`；即使用自定义 `--config`，CLI 界面解析器仍使用此基于主目录的缓存。 |
| OpenCode 对话、消息、服务注册和提供商连接 | 执行主机上 OpenCode 自身的全局存储，而非 CodeNomad 实例目录。 |
| 桌面恢复状态 | 默认 `~/.codenomad/client-state/v2/`；配置文件/窗口范围参阅[桌面](desktop.md)。 |

CodeNomad 连接现有共享守护进程，缺失时启动。启动环境仅影响新启动的守护进程。另行配置的完整会话环境会在每条提示词、自定义命令或会话 Shell 请求前应用，而非仅查看或编辑偏好时。参阅 [OpenCode 设置](opencode.md)。

## 事件与重新连接 {#events}

后端消费共享原生 OpenCode 事件流，使用服务器发送事件向浏览器客户端复用传输工作区和 CodeNomad 事件。交付是实时、易失的：**不保证事件重放**。

重新连接后，界面重新获取权威会话和待处理请求状态；文件/配置失效也触发新读取。重新连接不意味着允许重复回复丢失的发送、删除、回答或其他修改操作。请先检查结果状态。恢复不完整时保留已知待处理请求和草稿；参阅[权限](permissions.md)和[故障排查](troubleshooting.md)。

## 预览包与维护 {#maintenance}

显式试用预览 CLI 软件包：

```sh
npx @neuralnomads/codenomad-dev --generate-token --launch
```

需要隔离 CodeNomad 设置时，请有意使用独立配置；选择软件包不会隔离共享 OpenCode 存储。**设置 → 信息 → 更新 → 更新通道**控制提供的版本，而非后端数据身份或已安装软件包。

`codenomad --upgrade` 使用检测到的 npm/pnpm/bun 管理器更新全局稳定 CLI 包（未检测到时使用 npm）。不会重启运行中的服务器，也不会更新 OpenCode。对于项目本地或预览安装，请显式更新对应 npm 软件包。更新后有意识地重启受管理 CodeNomad 进程；重新检查打印地址。

桌面维护参阅[更新](updates.md)，源码构建命令参阅[支持](support.md)，提供商计划用量参阅[提供商](providers.md)。
