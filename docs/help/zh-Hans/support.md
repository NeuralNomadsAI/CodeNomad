# 支持与源码构建

通过仓库报告错误、查看当前版本和贡献。[故障排查指南](troubleshooting.md)介绍报告问题前的安全恢复。

## 报告错误 {#report-a-bug}

1. 打开**设置 → 信息 → 诊断**。
2. 选择**报告错误**打开 GitHub 问题表单。
3. 检查预填版本/客户端信息。添加最小复现、预期行为和实际结果，然后通过 GitHub 提交。

该操作会预填 CodeNomad 和 OpenCode 版本（包括与已安装版本不同时的运行中 OpenCode 服务版本）、你的操作系统、客户端类型（在网页浏览器中还包括浏览器的用户代理）以及服务器的操作系统。不会预填监听地址、工作区路径、凭据或对话文本。打开表单不等于提交问题。

如需更多诊断，**复制到剪贴板**或**下载 .txt**会生成单独报告。该完整报告可能包含本地路径和网络地址：附件前请检查并脱敏。即使自动诊断报告排除了认证秘密，截图或日志片段仍可能包含秘密。

GitHub 表单字段不兼容时，CodeNomad 会打开包含相同报告信息的普通问题。临时读取表单失败不会阻止打开。你也可以随时手动使用[问题列表](https://github.com/NeuralNomadsAI/CodeNomad/issues)。

## 社区与版本 {#community}

| 资源 | 用途 |
| --- | --- |
| [CodeNomad 仓库](https://github.com/NeuralNomadsAI/CodeNomad) | 源码、项目活动和文档。 |
| [问题](https://github.com/NeuralNomadsAI/CodeNomad/issues) | 提交可复现错误或功能请求前，先搜索已有报告。 |
| [拉取请求](https://github.com/NeuralNomadsAI/CodeNomad/pulls) | 审查提议更改或协调贡献。 |
| [最新版本](https://github.com/NeuralNomadsAI/CodeNomad/releases/latest) | 稳定下载产物。 |
| [所有版本](https://github.com/NeuralNomadsAI/CodeNomad/releases) | 已发布预览和发行说明。 |
| [Neural Nomads](https://github.com/NeuralNomadsAI) | 项目组织。 |
| [MIT 许可证](../../../LICENSE) | 许可条款。 |

若问题涉及原生 OpenCode 配置而非 CodeNomad 控件，请参阅 [OpenCode 文档](https://opencode.ai/v2/docs/)和[上游版本](https://github.com/anomalyco/opencode/releases)。

## 从源码构建 {#build-from-source}

使用 `.node-version` 固定的 Node.js **24.20.0**、npm、Git 和兼容 OpenCode CLI。在开发检出目录运行：

```sh
git clone --branch dev https://github.com/NeuralNomadsAI/CodeNomad.git
cd CodeNomad
npm ci --workspaces --include=optional
npm run dev
```

`npm run dev` 启动 Electron 开发宿主。使用 Tauri 时，先安装其[平台构建前提条件](https://v2.tauri.app/start/prerequisites/)，包括 Rust 工具链，然后运行：

```sh
npm run dev:tauri
```

开发更改影响开发宿主，而非独立运行的 OpenCode 守护进程已安装版本。原生打包需要相应目标工具；优先在目标操作系统构建。

### 构建与验证 {#build-and-validate}

| 命令，在仓库根目录运行 | 用途 |
| --- | --- |
| `npm run build` | 构建 Electron 应用资源。 |
| `npm run build:tauri` | 使用原生前提条件构建 Tauri 应用。 |
| `npm run build:ui` | 构建浏览器界面。 |
| `npm run build --workspace @neuralnomads/codenomad` | 构建独立服务器和随附资源。 |
| `npm run build:linux --workspace @neuralnomads/codenomad-electron-app` | 打包 Electron Debian 发行包。 |
| `npm exec --workspace @codenomad/tauri-app -- tauri build --bundles appimage` | 打包 Linux Tauri AppImage。 |
| `npm run typecheck` | 检查根目录配置的 TypeScript 工作区。 |
| `npm run test:help` | 验证所有公共帮助语言和链接。 |
| `npm run build:help` | 将独立公共帮助构建到 `dist/help`。 |

帮助构建不需要运行 CodeNomad 或 OpenCode 服务。打包详情参阅 [BUILD.md](../../../BUILD.md)，范围验证和 PR 约定参阅 [CONTRIBUTING.md](../../../CONTRIBUTING.md)；请使用目标软件包实际存在的脚本。

## 软件包分工与贡献 {#contribute}

| 软件包 | 职责 |
| --- | --- |
| `packages/server` | 工作区/API/Git 控件、OpenCode 连接、认证、事件和语音。 |
| `packages/ui` | SolidJS 工作区、控件、本地化和浏览器帮助入口。 |
| `packages/electron-app` | Electron 窗口、原生集成和打包。 |
| `packages/tauri-app` | Tauri 窗口、平台集成和打包。 |
| `packages/remote-tunnel` | 后端 OpenTunnel 传输运行时。 |

1. 实现重叠工作之前，先在相关问题中讨论范围。
2. 从 `dev` 创建分支，保持更改集中。
3. 运行受影响区域的检查，随行为更新用户帮助，并以 `dev` 为 PR 目标。

公共帮助源码位于 `docs/help/<locale>/`。翻译时保留每个英语标题的显式 ID、层级和顺序；翻译标题不得破坏深链接。[帮助维护契约](../../../dev-docs/USER_HELP.md)说明严格完整性检查和静态发布流程。
