# 安装 CodeNomad

选择本地桌面宿主，或运行[独立服务器](server.md)。两种情况下，共享原生服务和历史记录都由 OpenCode 管理。

## 桌面下载 {#desktop-downloads}

1. 打开[最新版本](https://github.com/NeuralNomadsAI/CodeNomad/releases/latest)。
2. 选择与你的操作系统和处理器匹配的构建。
3. 解压 ZIP，或安装/运行对应平台的软件包，然后启动 CodeNomad。

| 平台 | Electron 发行包 | Tauri 发行包 | 平台说明 |
| --- | --- | --- | --- |
| macOS | ZIP，Intel 或 Apple Silicon | ZIP，Intel 或 Apple Silicon | 随附运行时要求 macOS 13.5 或更高版本。 |
| Windows | ZIP，x64 | 安装程序，x64 | Windows 10 或更高版本；Tauri 使用 WebView2。 |
| Linux | Debian 软件包，x64 | AppImage，x64 | 在 Ubuntu 24.04 上构建和测试；不保证兼容更早的发行版。 |

桌面发行包包含后端和 OpenCode 安装程序所需的运行时资源，无需另行安装 Node.js/npm。不附带 Git。Electron 和 Windows Tauri 支持原生浏览器自动化；其他 Tauri 平台使用 iframe 预览。

已验证的下载若在启动时被阻止，请参阅[平台故障排查](troubleshooting.md#desktop-launch)。切勿仅为绕过警告而运行不可信的压缩包。

## 在 Linux 上安装 {#linux-install}

在下载的发行包所在文件夹中，替换为实际版本和文件名：

```sh
sudo apt install ./CodeNomad-Electron-linux-x64-<version>.deb
```

对于 Tauri AppImage：

```sh
chmod +x CodeNomad-Tauri-linux-x64-<version>.AppImage
./CodeNomad-Tauri-linux-x64-<version>.AppImage
```

如果 FUSE 不可用，请使用 AppImage 的解压运行模式：

```sh
./CodeNomad-Tauri-linux-x64-<version>.AppImage --appimage-extract-and-run
```

Electron Debian 安装过程会配置 Chromium 沙箱。不要通过禁用沙箱来解决安装问题。Linux Tauri 图形问题有[针对性的 WebKit 解决方法](troubleshooting.md#desktop-launch)。

## 要求 {#requirements}

| 要求 | 必须可用的位置 | 当前要求 |
| --- | --- | --- |
| OpenCode CLI | 所选执行主机，适用时包括所选 WSL 发行版 | 最低 **2.1.2**；建议/已验证目标为 **2.1.4**。更新版本或自定义版本会接受契约验证，而非因未经测试就被禁止。 |
| Git | CodeNomad 后端账户的 `PATH` | 仓库身份识别、Git 操作和工作树必需。 |
| Node.js/npm | 独立服务器和源码构建主机 | Node.js 24 LTS；可重现的源码构建使用 `.node-version`（**24.20.0**）。桌面运行时/安装资源已随附。 |
| 工作区文件夹 | 后端可访问的磁盘 | 显式打开的物理文件夹，而非远程浏览器推断出的设备本地文件夹。 |

Windows 上，请安装 [Git for Windows](https://gitforwindows.org/)，并启用命令行/第三方访问。用户可写的按用户安装即可。macOS/Linux 上，请使用 [Git 平台说明](https://git-scm.com/downloads)。

更改 `PATH` 后，请完全退出并重新启动桌面应用，或以目标账户重启独立后端。重新加载浏览器不会更新后端环境。仅在 WSL 内可用的 Git 不满足 Windows 后端的 Git 要求。

没有 Git 时，仍可打开物理文件夹并使用仅目录模式的对话，包括请智能体协助安装。仓库/工作树操作仍不可用；会话访问仅限该文件夹。CodeNomad 会在提示词/自定义命令之前告知智能体后端 Git 的可用性，并在恢复后移除该提示。智能体执行主机可能不同于后端主机，因此应为后端安装 Git，而非仅为智能体的 Shell 安装。

## 首次启动时选择 OpenCode {#first-launch}

1. 在设置流程中，选择兼容的现有可执行文件，或使用提供的 OpenCode 安装操作。
2. 打开项目前确认运行时状态。
3. 返回**偏好设置 → OpenCode**，分别管理可执行文件、安装和共享服务。

CodeNomad 优先使用 `PATH` 中兼容的可执行文件，也支持显式选择。如果 `PATH` 启动的是较旧的 OpenCode，设置流程会在确认后替换通过 npm 安装的 OpenCode 1.x；对于以其他方式安装的版本，则会在其旁边为 CodeNomad 安装 OpenCode 2，且绝不修改原安装；参阅 [OpenCode 设置](opencode.md#select-cli)。安装/更新 CLI 不会静默重启已运行的共享服务。重启/重新加载的影响、WSL 和会话环境请参阅 [OpenCode 设置](opencode.md)。

## 改用浏览器 {#browser-install}

在服务器主机上安装 Node.js/npm、Git 和 OpenCode，然后按[服务器启动流程](server.md)操作。使用打印的地址、配置的认证和可信证书连接。浏览器/PWA 需要运行中的后端；它不是项目的离线副本。

端口、绑定和 TLS 请参阅[直接访问](remote-access.md)。无需开放入站端口即可配对设备，请使用[远程控制](remote-control.md)。开发和打包命令请参阅[源码构建](support.md#build-from-source)。
