# 下载 CodeNomad

免费开源（MIT）的桌面应用，支持 Windows、macOS 和 Linux。它连接到你的 OpenCode 服务；请先查看[要求](install.md#requirements)。

## 桌面应用 {#desktop}

{{release}}

{{download-button}}

| 平台 | Tauri（推荐） | Electron |
| --- | --- | --- |
| Windows 10 或更高版本 | [安装程序，x64](release:tauri-windows-x64) | [ZIP，x64](release:electron-windows-x64) |
| macOS 13.5 或更高版本 | [ZIP，Apple Silicon](release:tauri-macos-arm64) · [ZIP，Intel](release:tauri-macos-x64) | [ZIP，Apple Silicon](release:electron-macos-arm64) · [ZIP，Intel](release:electron-macos-x64) |
| Linux x64（在 Ubuntu 24.04 上测试） | [AppImage，x64](release:tauri-linux-x64) | [Debian 软件包，x64](release:electron-linux-x64) |

两种构建提供相同的工作区。Tauri 可在应用内安装更新；Electron 通过下载新版本更新，并在所有平台上支持原生浏览器自动化（Tauri 仅在 Windows 上支持）。[比较两种构建](install.md#desktop-downloads)。

## 软件包管理器 {#package-managers}

在 Windows 上，winget 安装的是 Tauri 构建：

```sh
winget install NeuralNomadsAI.CodeNomad
```

若要将 CodeNomad 作为独立服务器运行并在浏览器中使用，请在装有 Node.js 24 的主机上通过 npm 启动：

```sh
npx @neuralnomads/codenomad --generate-token --launch
```

[独立服务器](server.md#run)页面介绍首次登录、全局安装、地址和认证；[要求](install.md#requirements)列出了 Node.js、Git 和 OpenCode。

## 安装与首次启动 {#verify-and-install}

请仅从本页或[官方发行版本](https://github.com/NeuralNomadsAI/CodeNomad/releases)下载，切勿仅为绕过警告而运行不可信的压缩包。

- **Linux**：为 AppImage 添加可执行权限，或安装 Debian 软件包；参阅[在 Linux 上安装](install.md#linux-install)。
- **macOS**：如果 macOS 阻止首次启动，请参阅 [macOS 隔离](troubleshooting.md#macos-quarantine)。
- **所有平台**：按[要求](install.md#requirements)中所列安装 Git 和兼容的 OpenCode CLI，然后[在首次启动时选择 OpenCode](install.md#first-launch)。其他启动问题请参阅[故障排查](troubleshooting.md#desktop-launch)。

## 支持开发 {#support-development}

CodeNomad 免费，由志愿者利用业余时间维护。如果它对你或你的团队有用，赞助有助于持续维护它，并保持与新版 OpenCode 的兼容。[赞助 CodeNomad](sponsor.md)页面说明了赞助的用途。

{{funding}}
