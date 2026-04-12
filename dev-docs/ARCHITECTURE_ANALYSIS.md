# CodeNomad 项目分析报告

> 更新时间: 2026-04-09
> 源码仓库: https://github.com/NeuralNomadsAI/CodeNomad
> 版本: v0.13.3

---

## 目录

1. [项目概述](#1-项目概述)
2. [整体架构设计](#2-整体架构设计)
3. [OpenCode 生命周期](#3-opencode-生命周期)
4. [前后端交互机制](#4-前后端交互机制)
5. [CodeNomad 与 OpenCode 交互](#5-codenomad-与-opencode-交互)
6. [状态监控机制](#6-状态监控机制)
7. [Server 模块详解](#7-server-模块详解)
8. [UI 模块详解](#8-ui-模块详解)
9. [Desktop Shell 架构](#9-desktop-shell-架构)
10. [OpenCode 插件系统](#10-opencode-插件系统)
11. [数据流全景](#11-数据流全景)
12. [安全模型](#12-安全模型)
13. [错误处理策略](#13-错误处理策略)
14. [远程访问架构](#14-远程访问架构)
15. [Session 与 Message 数据模型](#15-session-与-message-数据模型)
16. [Desktop Bootstrap 握手](#16-desktop-bootstrap-握手)
17. [语音模式端到端流程](#17-语音模式端到端流程)
18. [UI 远程包解析与自动更新](#18-ui-远程包解析与自动更新)
19. [开发模式架构](#19-开发模式架构)
20. [构建系统](#20-构建系统)
21. [键盘快捷键与命令系统](#21-键盘快捷键与命令系统)
22. [其他说明](#22-其他说明)
23. [关键文件索引](#23-关键文件索引)
24. [超限文件告警](#24-超限文件告警)

---

## 1. 项目概述

### 1.1 项目定位

**CodeNomad** 是 **OpenCode** 的桌面增强客户端，由 Neural Nomads 团队开发。它将 OpenCode 从终端工具升级为"AI 编程驾驶舱"，为长时间使用 AI 编程的开发者提供更好的控制、速度和清晰度。

> OpenCode gives you the engine. CodeNomad gives you the cockpit.

### 1.2 核心功能

| 功能 | 说明 |
|------|------|
| **多实例工作区** | 同时管理多个 AI 编程会话 |
| **远程访问** | 支持浏览器远程连接开发 |
| **会话管理** | 智能管理编程会话 |
| **语音输入** | 支持语音交互 (STT/TTS) |
| **Git Worktrees** | 集成 Git 工作树管理 |
| **命令面板** | 快捷命令操作 |
| **文件浏览器** | 内置文件系统浏览与模糊搜索 |
| **主题支持** | 自定义界面主题 (亮/暗/跟随系统) |
| **国际化** | 7 种语言支持 (en/es/fr/ru/ja/zh-Hans/he) |
| **通知系统** | 系统级通知推送 |
| **Sidecar 服务** | 端口化的辅助服务管理 |
| **后台进程** | 每工作空间的长运行 Shell 命令 |

### 1.3 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Node.js + Fastify |
| 前端 | SolidJS + Vite + TailwindCSS |
| 桌面 | Electron (主) + Tauri (Rust, 实验) |
| 通信 | SSE + HTTP Proxy |
| 进程管理 | Node child_process |
| 构建 | npm workspaces (Monorepo) |
| 类型安全 | TypeScript (全栈) |

### 1.4 Monorepo 包依赖关系

```
electron-app ──► server (file:../server)
             ──► ui (file:../ui)

tauri-app ──► ui (via build scripts, bundles server binary)

server ──► opencode-config (copies config at build)

ui ──► server/src/api-types.ts (imports types directly via relative path)

cloudflare ──► ui dist (hosts built UI)
```

### 1.5 代码规模统计

| Package | 文件数 | 总行数 | 语言 |
|---------|--------|--------|------|
| **server** | 62 | ~10,465 | TypeScript |
| **ui** | ~388 | ~64,714 | TSX/TS/CSS |
| **electron-app** | 9 | ~2,094 | TypeScript |
| **tauri-app** | 2 | ~1,916 | Rust |
| **opencode-config** | 5 | ~664 | TypeScript |
| **cloudflare** | 1 | ~26 | TypeScript |
| **合计** | ~467 | ~79,879 | |

### 1.6 Packages 完整结构

```
packages/
├── server/                      # 后端核心服务 (@neuralnomads/codenomad)
│   └── src/
│       ├── index.ts             # CLI 入口 (572行)
│       ├── bin.ts               # Shebang 可执行入口
│       ├── loader.ts            # 自定义 ESM 模块解析器
│       ├── logger.ts            # Pino 日志系统
│       ├── api-types.ts         # 共享类型契约 (410行)
│       ├── opencode-config.ts   # OpenCode 配置模板目录解析
│       ├── auth/                # 认证管理 (6 files)
│       │   ├── manager.ts       #   AuthManager 中心认证类
│       │   ├── auth-store.ts    #   持久化凭证存储
│       │   ├── http-auth.ts     #   HTTP 认证辅助
│       │   ├── session-manager.ts #  会话跟踪
│       │   ├── token-manager.ts #   一次性 Bootstrap Token
│       │   └── password-hash.ts #   密码哈希 (node-forge)
│       ├── server/              # HTTP 服务器 (5 files + routes/)
│       │   ├── http-server.ts   #   Fastify 核心 (1193行)
│       │   ├── tls.ts           #   TLS 证书管理
│       │   ├── network-addresses.ts # LAN IP 解析
│       │   └── routes/          #   模块化路由 (14 files)
│       │       ├── workspaces.ts
│       │       ├── worktrees.ts
│       │       ├── settings.ts
│       │       ├── storage.ts
│       │       ├── filesystem.ts
│       │       ├── events.ts
│       │       ├── meta.ts
│       │       ├── speech.ts
│       │       ├── sidecars.ts
│       │       ├── background-processes.ts
│       │       ├── remote-servers.ts
│       │       ├── plugin.ts
│       │       ├── auth.ts
│       │       └── auth-pages/  #   静态 HTML 认证页面
│       ├── events/              # 事件总线 (1 file)
│       │   └── bus.ts           #   EventBus (49行, 继承 EventEmitter)
│       ├── workspaces/          # 工作空间管理 (6 files)
│       │   ├── manager.ts       #   WorkspaceManager (488行)
│       │   ├── runtime.ts       #   WorkspaceRuntime 进程管理 (487行)
│       │   ├── instance-events.ts # InstanceEventBridge (226行)
│       │   ├── git-worktrees.ts #   Git worktree 操作
│       │   ├── worktree-map.ts  #   会话到 worktree 映射
│       │   └── opencode-auth.ts #   OpenCode 实例认证
│       ├── settings/            # 配置服务 (6 files)
│       │   ├── service.ts       #   SettingsService (YAML 配置)
│       │   ├── yaml-doc-store.ts #  原子 YAML 读写
│       │   ├── binaries.ts      #   BinaryResolver 二进制解析
│       │   ├── migrate.ts       #   JSON → YAML 配置迁移
│       │   ├── merge-patch.ts   #   JSON Merge Patch (RFC 7396)
│       │   └── public-config.ts #   公开配置过滤
│       ├── config/              # 配置 Schema (2 files)
│       │   ├── schema.ts        #   Zod 校验模式
│       │   └── location.ts      #   配置文件路径解析
│       ├── filesystem/          # 文件浏览 (4 files)
│       │   ├── browser.ts       #   FileSystemBrowser
│       │   ├── search.ts        #   Fuzzy 文件搜索 (fuzzysort)
│       │   └── search-cache.ts  #   搜索缓存 (TTL)
│       ├── clients/             # 客户端连接 (1 file)
│       │   └── connection-manager.ts # ClientConnectionManager
│       ├── plugins/             # 插件系统 (3 files)
│       │   ├── channel.ts       #   PluginChannelManager (SSE)
│       │   ├── handlers.ts      #   插件事件处理
│       │   └── voice-mode.ts    #   VoiceModeManager
│       ├── sidecars/            # Sidecar 服务 (1 file)
│       │   └── manager.ts       #   SideCarManager (256行)
│       ├── speech/              # 语音服务 (2 files)
│       │   ├── service.ts       #   SpeechService (STT/TTS 代理)
│       │   └── providers/       #   语音提供商
│       │       └── openai-compatible.ts # OpenAI 兼容 TTS/STT
│       ├── background-processes/ # 后台进程 (1 file)
│       │   └── manager.ts       #   BackgroundProcessManager (519行)
│       ├── storage/             # 实例存储 (1 file)
│       │   └── instance-store.ts #  每工作空间 JSON 数据存储
│       ├── releases/            # 发布监控 (2 files)
│       │   ├── dev-release-monitor.ts #  开发频道监控
│       │   └── release-monitor.ts     #  通用发布监控
│       └── ui/                  # 远程 UI 解析 (2 files)
│           └── remote-ui.ts     #   UI 包解析 (bundled/downloaded/dev)
│
├── ui/                          # 前端 UI (@codenomad/ui)
│   └── src/
│       ├── main.tsx             # 应用入口 (66行)
│       ├── App.tsx              # 根组件 (637行)
│       ├── components/          # UI 组件 (63 entries)
│       │   ├── folder-selection-view.tsx
│       │   ├── instance/        #   实例相关组件
│       │   │   ├── instance-tabs.tsx
│       │   │   ├── instance-shell2.tsx
│       │   │   └── session/
│       │   │       └── session-sidebar.tsx
│       │   ├── instance/shell/  #   实例 Shell 细节
│       │   │   └── right-panel/
│       │   │       └── RightPanel.tsx
│       │   ├── message-block.tsx
│       │   ├── message-section.tsx
│       │   ├── message-timeline.tsx
│       │   ├── message-item.tsx
│       │   ├── message-part.tsx
│       │   ├── prompt-input.tsx
│       │   ├── command-palette.tsx
│       │   ├── settings/        #   设置子组件 (7 files)
│       │   ├── tool-call.tsx    #   工具调用渲染
│       │   │   └── renderers/   #     工具渲染器 (13 files)
│       │   ├── session-list.tsx
│       │   └── ...              #   模态框/对话框等
│       ├── stores/              # 状态管理 (31 files)
│       │   ├── instances.ts     #   实例生命周期
│       │   ├── sessions.ts      #   会话列表
│       │   ├── session-api.ts   #   会话 API 操作
│       │   ├── session-events.ts #  SSE 事件处理
│       │   ├── session-state.ts #   会话状态追踪
│       │   ├── message-v2/      #   消息存储 v2
│       │   │   ├── instance-store.ts
│       │   │   └── bridge.ts
│       │   ├── preferences.tsx  #   偏好设置
│       │   ├── app-tabs.ts      #   标签管理
│       │   ├── sidecars.ts      #   Sidecar 状态
│       │   ├── worktrees.ts     #   Git worktree 状态
│       │   ├── speech.ts        #   语音状态
│       │   └── conversation-speech.ts # 会话语音合成
│       ├── lib/                 # 核心库 (42 entries)
│       │   ├── api-client.ts    #   HTTP API 客户端
│       │   ├── sse-manager.ts   #   SSE 连接管理
│       │   ├── sdk-manager.ts   #   OpenCode SDK 客户端管理
│       │   ├── runtime-env.ts   #   运行时环境检测
│       │   ├── storage.ts       #   设置持久化
│       │   ├── markdown.ts      #   Markdown 渲染 (Shiki)
│       │   ├── theme.tsx        #   主题提供者
│       │   ├── server-events.ts #   服务端事件信号
│       │   ├── i18n/            #   国际化系统
│       │   │   ├── index.tsx    #     i18n 核心
│       │   │   └── messages/    #     7 种语言, 每种 17 个消息分片
│       │   ├── native/          #   原生功能抽象
│       │   │   ├── native-functions.ts
│       │   │   ├── electron/functions.ts
│       │   │   └── tauri/functions.ts
│       │   ├── hooks/           #   自定义 Hooks (7 files)
│       │   ├── shortcuts/       #   快捷键定义 (4 files)
│       │   └── monaco/          #   Monaco 编辑器 (3 files)
│       ├── types/               # 类型定义 (10 files)
│       │   ├── attachment.ts
│       │   ├── diff.ts
│       │   ├── global.ts
│       │   ├── instance.ts
│       │   ├── message.ts
│       │   ├── permission.ts
│       │   ├── question.ts
│       │   ├── session.ts
│       │   └── ...
│       └── styles/              # CSS 架构
│           ├── tokens.css       #   设计令牌 (CSS 自定义属性)
│           ├── utilities.css    #   工具类
│           ├── controls.css     #   控件聚合入口
│           ├── markdown.css     #   Markdown 样式
│           ├── messaging.css    #   消息样式聚合入口
│           ├── panels.css       #   面板样式聚合入口
│           ├── components/      #   可复用 UI 模式 (11 files)
│           ├── messaging/       #   消息/输入/工具调用样式 (10 files)
│           └── panels/          #   面板/布局/标签样式 (6 files)
│
├── electron-app/                # Electron 桌面应用 (@neuralnomads/codenomad-electron-app)
│   └── electron/
│       ├── main/                # 主进程 (7 files)
│       │   ├── main.ts          #   应用入口 (669行)
│       │   ├── process-manager.ts # CLI 进程管理 (703行)
│       │   ├── ipc.ts           #   IPC 处理 (160行)
│       │   ├── menu.ts          #   应用菜单
│       │   ├── permissions.ts   #   媒体权限
│       │   ├── storage.ts       #   存储路径
│       │   └── user-shell.ts    #   用户 Shell 解析
│       ├── preload/             # 预加载脚本 (1 file)
│       │   └── index.cjs        #   contextBridge 暴露 electronAPI
│       └── resources/           # 资源文件
│           ├── cli-supervisor.cjs # CLI 进程监控脚本
│           ├── server/          #   捆绑的服务器副本
│           └── ...              #   图标/entitlements
│
├── tauri-app/                   # Tauri 桌面应用 (@codenomad/tauri-app, Rust)
│   └── src-tauri/src/
│       ├── main.rs              # Tauri 应用入口 (722行)
│       └── cli_manager.rs       # CLI 进程管理 (1194行)
│
├── opencode-config/             # OpenCode 配置插件 (@codenomad/opencode-config)
│   ├── opencode.jsonc           # OpenCode 配置模板
│   └── plugin/
│       ├── codenomad.ts         # 插件入口 (62行)
│       └── lib/
│           ├── client.ts        # HTTP+SSE 客户端
│           ├── request.ts       # HTTP 请求辅助
│           └── background-process.ts # 后台进程工具定义
│
└── cloudflare/                  # Cloudflare Worker (@codenomad/ui-host-worker)
    └── src/
        └── index.ts             # UI 静态资源托管 (26行)
```

---

## 2. 整体架构设计

### 2.1 分层架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Desktop App (Electron/Tauri)                  │
├─────────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────┐      ┌───────────────────────────────┐  │
│  │   Renderer (SolidJS)  │      │   Main Process               │  │
│  │   - UI Components     │      │   - CLI Process Manager       │  │
│  │   - State (Signals)   │◄────►│   - IPC Bridge               │  │
│  │   - SSE Connection    │      │   - Native Dialogs           │  │
│  └───────────┬───────────┘      └───────────────────────────────┘  │
│              │                                                       │
│              │ SSE + HTTP API                                       │
└──────────────┼─────────────────────────────────────────────────────┘
               │
┌──────────────┼─────────────────────────────────────────────────────┐
│              ▼                  CodeNomad Server (Node.js)           │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌─────────┐  ┌────────┐  │  │
│  │  │ HTTP Server │  │ Workspace    │  │ Event   │  │ Auth   │  │  │
│  │  │ (Fastify)   │──│ Manager      │──│ Bus     │  │ Manager│  │  │
│  │  └─────────────┘  └──────────────┘  └─────────┘  └────────┘  │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌─────────┐  ┌────────┐  │  │
│  │  │ Settings    │  │ Speech       │  │ Sidecar │  │ Plugin │  │  │
│  │  │ Service     │  │ Service      │  │ Manager │  │ Channel│  │  │
│  │  └─────────────┘  └──────────────┘  └─────────┘  └────────┘  │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                              │                                      │
│                    HTTP Proxy │ Forward                              │
└──────────────────────────────┼──────────────────────────────────────┘
                               │
┌──────────────────────────────┼──────────────────────────────────────┐
│                              ▼                                       │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    OpenCode Instances                           │  │
│  │                                                               │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │  │
│  │  │ OpenCode #1 │  │ OpenCode #2 │  │ OpenCode #N │            │  │
│  │  │ (进程 A)    │  │ (进程 B)    │  │ (进程 N)    │            │  │
│  │  │ :随机端口   │  │ :随机端口   │  │ :随机端口   │            │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘            │  │
│  │                                                               │  │
│  │  每个 Workspace 对应一个 OpenCode 实例，独立进程                │  │
│  │  通过 Basic Auth + 环境变量注入认证                             │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 组件关系

| 组件 | 位置 | 关系 |
|------|------|------|
| **UI (前端)** | 浏览器/SolidJS | 1 个页面，多个工作区标签 |
| **Server (后端)** | Node.js 服务 | 1 个进程，管理多个 Workspace |
| **OpenCode 实例** | 子进程 | 每个 Workspace 1 个独立进程 |
| **Desktop Shell** | Electron/Tauri | 管理 Server 进程，提供原生能力 |

### 2.3 架构特点

1. **解耦设计**: Server、UI、Desktop Shell 完全分离，通过标准化 API 和 SSE 通信
2. **事件驱动**: 基于 EventBus 的发布-订阅模式，实现松耦合
3. **状态管理**: 使用 SolidJS 的细粒度响应式 Signals，高效更新
4. **工作空间隔离**: 每个 OpenCode 实例运行在独立进程中
5. **Worktree 支持**: Git worktree 集成，支持多分支并行开发
6. **认证安全**: Bootstrap token + Session cookie 的双层认证
7. **多 Shell 架构**: UI 运行时无关，通过 `runtime-env.ts` 检测 Electron/Tauri/Web
8. **依赖注入**: 所有主要类通过构造器选项接口接收依赖，无 DI 框架
9. **共享类型契约**: `api-types.ts` 定义 HTTP/SSE 规范，UI 直接 import 保证类型安全
10. **插件桥接**: OpenCode 实例加载 CodeNomadPlugin，建立双向 SSE 通道
11. **CSS 设计系统**: Token 层 → 工具层 → 组件层三层分离

### 2.4 核心架构模式

| 模式 | 实现方式 | 典型位置 |
|------|---------|---------|
| **事件驱动** | `EventBus extends EventEmitter` | `server/src/events/bus.ts` |
| **构造器注入** | 接口选项对象传入依赖 | 所有 Manager/Service 类 |
| **反向代理** | Fastify `reply.from()` 转发 | `server/src/server/http-server.ts` |
| **响应式状态** | SolidJS `createSignal`/`createStore` | `ui/src/stores/*.ts` |
| **模块化路由** | `registerXxxRoutes(app, deps)` 函数 | `server/src/server/routes/*.ts` |
| **原生抽象** | `native-functions.ts` 分派到平台实现 | `ui/src/lib/native/` |
| **原子配置** | YAML 文件读写 + merge-patch | `server/src/settings/yaml-doc-store.ts` |
| **惰性加载** | i18n locale 动态 `import()` | `ui/src/lib/i18n/index.tsx` |

---

## 3. OpenCode 生命周期

### 3.1 启动流程

**Server 端入口**: `packages/server/src/index.ts` (572行)

```typescript
// 主要启动步骤
1. parseCliOptions()          // 解析 CLI 参数 (Commander)
2. createLogger()             // 创建 Pino 日志系统
3. new EventBus()             // 初始化事件总线
4. new SettingsService()      // 加载 YAML 配置 (config.yaml + state.yaml)
5. BinaryResolver             // 解析 OpenCode 二进制路径
6. new WorkspaceManager()     // 创建工作空间管理器
7. new SideCarManager()       // 创建 Sidecar 管理器
8. new BackgroundProcessManager() // 创建后台进程管理器
9. new SpeechService()        // 创建语音服务
10. createHttpServer()        // 创建 Fastify HTTP 服务器 + 注册路由
11. 启动监听                  // 注册信号处理 (SIGINT/SIGTERM)
```

**关键启动参数**:
- `--host`: 绑定地址 (`127.0.0.1` 或 `0.0.0.0`)
- `--https`/`--http`: 协议选择
- `--workspace-root`: 工作空间根目录
- `--generate-token`: 生成一次性引导令牌
- `--dangerously-skip-auth`: 跳过认证

### 3.2 工作空间创建流程

**文件**: `packages/server/src/workspaces/manager.ts`

```typescript
async function create(folder: string, name?: string): Promise<WorkspaceDescriptor> {
  // 1. 生成唯一 ID
  const id = `${Date.now().toString(36)}`

  // 2. 解析二进制路径
  const resolvedBinaryPath = this.resolveBinaryPath(binary.path)

  // 3. 创建 OpenCode 认证
  const { username, password, authorization } = this.generateOpencodeAuth()

  // 4. 准备环境变量
  const environment = {
    OPENCODE_CONFIG_DIR: this.opencodeConfigDir,
    CODENOMAD_INSTANCE_ID: id,
    CODENOMAD_BASE_URL: this.options.getServerBaseUrl(),
    [OPENCODE_SERVER_USERNAME_ENV]: username,
    [OPENCODE_SERVER_PASSWORD_ENV]: password,
  }

  // 5. 启动进程 (WorkspaceRuntime.launch)
  const { pid, port, exitPromise } = await this.runtime.launch({
    workspaceId: id,
    folder: workspacePath,
    binaryPath: resolvedBinaryPath,
    environment,
  })

  // 6. 等待就绪
  await this.waitForWorkspaceReadiness({ port, exitPromise })

  // 7. 发布事件
  this.options.eventBus.publish({ type: "workspace.started", workspace: descriptor })
}
```

### 3.3 进程运行时

**文件**: `packages/server/src/workspaces/runtime.ts`

```typescript
async launch(options: LaunchOptions): Promise<{ pid, port, exitPromise }> {
  // 1. 验证目录
  this.validateFolder(options.folder)

  // 2. 构建启动命令
  const args = ["serve", "--port", "0", "--print-logs", "--log-level", logLevel]

  // 3. 生成环境变量
  const env = { ...process.env, ...options.environment }

  // 4. Spawn 子进程
  const child = spawn(spec.command, spec.args, {
    cwd: options.folder,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  })

  // 5. 监听 stdout 提取端口
  child.stdout?.on("data", (data) => {
    const portMatch = line.match(/opencode server listening on http:\/\/.+:(\d+)/i)
    if (portMatch) {
      port = parseInt(portMatch[1], 10)
      resolve({ pid: child.pid, port })
    }
  })

  // 6. 等待退出
  child.on("exit", handleExit)
}
```

### 3.4 销毁流程

```typescript
async shutdown() {
  // 1. 关闭事件桥接
  instanceEventBridge.shutdown()

  // 2. 关闭 SideCar 管理器
  await sidecarManager.shutdown()

  // 3. 关闭所有工作空间
  await workspaceManager.shutdown()

  // 4. 停止 HTTP 服务器
  await Promise.all(servers.map(srv => srv.stop()))

  // 5. 退出进程
  process.exit(0)
}
```

---

## 4. 前后端交互机制

### 4.1 API 设计

**主要 API 路由** (packages/server/src/server/routes/):

| 路由 | 方法 | 描述 |
|------|------|------|
| `/api/workspaces` | GET/POST | 列出/创建工作空间 |
| `/api/workspaces/:id` | GET/DELETE | 获取/删除工作空间 |
| `/api/workspaces/:id/files` | GET | 列出文件 |
| `/api/workspaces/:id/files/search` | GET | 模糊搜索文件 |
| `/api/workspaces/:id/worktrees` | GET/POST | Worktree 管理 |
| `/api/workspaces/:id/worktrees/:slug/instance/*` | ALL | OpenCode 实例代理 |
| `/api/storage/*` | GET/PUT/PATCH | 配置存储 |
| `/api/events` | GET (SSE) | 服务端事件流 |
| `/api/auth/*` | POST | 认证相关 |
| `/api/speech/*` | POST | STT/TTS 语音服务 |
| `/api/sidecars/*` | * | Sidecar 服务管理 |
| `/api/background-processes/*` | * | 后台进程管理 |
| `/api/settings` | GET/PUT | 全局设置 |
| `/api/meta` | GET | 服务器元信息 |
| `/workspaces/:id/plugin/*` | * | 插件通信通道 |

### 4.2 SSE (Server-Sent Events) 通信

**Server 端** (`packages/server/src/server/routes/events.ts`):

```typescript
app.get("/api/events", (request, reply) => {
  // 1. 设置 SSE 头
  reply.raw.setHeader("Content-Type", "text/event-stream")
  reply.raw.setHeader("Cache-Control", "no-cache")
  reply.raw.setHeader("Connection", "keep-alive")
  reply.raw.flushHeaders?.()

  // 2. 订阅事件总线
  const unsubscribe = deps.eventBus.onEvent(send)

  // 3. 心跳保活
  const heartbeat = setInterval(() => {
    reply.raw.write(`event: codenomad.client.ping\ndata: ${ping}\n\n`)
  }, 15000)

  // 4. 发送事件
  const send = (event) => {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  // 5. 清理
  request.raw.on("close", close)
})
```

### 4.3 事件类型

**文件**: `packages/server/src/api-types.ts` (410行 — 共享类型契约)

```typescript
export type WorkspaceEventType =
  | "workspace.created"
  | "workspace.started"
  | "workspace.error"
  | "workspace.stopped"
  | "workspace.log"
  | "instance.event"        // 来自 OpenCode 的事件
  | "instance.eventStatus"  // 连接状态
  | "storage.configChanged"
  | "storage.stateChanged"
  | "sidecar.updated"
```

### 4.4 客户端连接管理

**文件**: `packages/server/src/clients/connection-manager.ts`

```typescript
class ClientConnectionManager {
  // 连接超时: 45秒
  // 扫描间隔: 5秒

  register(input: ClientConnectionRef & { close }) {
    // 1. 生成连接键
    const key = `${clientId}:${connectionId}`

    // 2. 存储连接
    this.connections.set(key, {
      clientId, connectionId,
      connectedAt: now,
      lastSeenAt: now,
    })

    // 3. 返回取消注册函数
    return () => this.disconnect(key)
  }

  pong(input: ClientConnectionRef) {
    // 更新心跳时间
    connection.lastSeenAt = Date.now()
  }

  // 扫描陈旧连接
  private sweepStaleConnections() {
    const cutoff = Date.now() - STALE_CONNECTION_TIMEOUT_MS
    for (const connection of this.connections.values()) {
      if (connection.lastSeenAt < cutoff) {
        this.disconnect(key, "timeout")
      }
    }
  }
}
```

---

## 5. CodeNomad 与 OpenCode 交互

### 5.1 交互环节总览

| 环节 | 触发方 | 目标端点 | 认证 | 用途 |
|------|--------|----------|------|------|
| **进程启动** | Server | `spawn()` | - | 启动 OpenCode 子进程 |
| **端口发现** | Server | stdout 解析 | - | 获取随机分配端口 |
| **健康检查** | Server | `GET /global/health` | Basic Auth | 验证实例可用性 |
| **SSE 事件桥接** | Server | `GET /global/event` | Basic Auth | 消费 OpenCode 事件 |
| **API 代理** | Client | `/workspaces/:id/*/instance/*` | Basic Auth | 转发 SDK 请求 |
| **插件通信** | OpenCode | `POST /workspaces/:id/plugin/*` | Basic Auth | 后台进程管理 |
| **语音状态** | OpenCode | SSE `/workspaces/:id/plugin/events` | Basic Auth | 语音模式通知 |

### 5.2 进程启动交互

**文件**: `packages/server/src/workspaces/runtime.ts`

```typescript
async launch(options: LaunchOptions): Promise<{ pid, port, exitPromise }> {
  // 1. 构建启动参数
  const logLevel = typeof options.logLevel === "string" ? options.logLevel.toUpperCase() : "DEBUG"
  const args = ["serve", "--port", "0", "--print-logs", "--log-level", logLevel]

  // 2. 构建环境变量
  const env = { ...process.env, ...(options.environment ?? {}) }

  // 3. 使用 spawn 启动进程
  const child = spawn(spec.command, spec.args, {
    cwd: options.folder,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    ...spec.options,
  })
}
```

**启动参数**:
- 命令: `opencode serve --port 0 --print-logs --log-level <LEVEL>`
- `--port 0`: 请求随机可用端口
- `--print-logs`: 输出日志到 stdout/stderr
- `--log-level`: 日志级别 (DEBUG/INFO/WARN/ERROR)

**传递的环境变量**:
```typescript
const environment = {
  ...userEnvironment,                    // 用户自定义环境变量
  OPENCODE_CONFIG_DIR: this.opencodeConfigDir,  // OpenCode 配置目录
  CODENOMAD_INSTANCE_ID: id,            // 工作空间 ID
  CODENOMAD_BASE_URL: this.options.getServerBaseUrl(),  // CodeNomad 服务器地址
  NODE_EXTRA_CA_CERTS: <CA证书路径>,    // 可选: TLS 证书
  OPENCODE_SERVER_USERNAME: opencodeUsername,  // 认证用户名
  OPENCODE_SERVER_PASSWORD: opencodePassword,   // 认证密码
}
```

### 5.3 端口发现机制

**文件**: `packages/server/src/workspaces/runtime.ts`

```typescript
// 从 stdout 解析端口
child.stdout?.on("data", (data: Buffer) => {
  const portMatch = line.match(/opencode server listening on http:\/\/.+:(\d+)/i)
  if (portMatch) {
    portFound = true
    const port = parseInt(portMatch[1], 10)
    resolve({ pid: child.pid!, port, exitPromise, getLastOutput })
  }
})
```

**端口可用性检查**:
```typescript
private waitForPortAvailability(port: number, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: "127.0.0.1" }, () => {
      socket.end()
      resolve()
    })
    socket.once("error", () => {
      // 重试逻辑: 每 100ms 重试一次
    })
  })
}
```

### 5.4 健康检查

**文件**: `packages/server/src/workspaces/manager.ts`

```typescript
private async probeInstance(workspaceId: string, port: number): Promise<{ ok: boolean; reason?: string; version?: string }> {
  const url = `http://127.0.0.1:${port}/global/health`

  const headers: Record<string, string> = {}
  const authHeader = this.opencodeAuth.get(workspaceId)?.authorization
  if (authHeader) {
    headers["Authorization"] = authHeader
  }

  const response = await fetch(url, { headers })
  const payload = (await response.json()) as { healthy?: unknown; version?: unknown }

  return {
    ok: payload?.healthy === true,
    version: typeof payload?.version === "string" ? payload.version.trim() : undefined
  }
}
```

**健康检查端点**: `GET http://127.0.0.1:<PORT>/global/health`

### 5.5 API 代理

**文件**: `packages/server/src/server/http-server.ts`

**代理路由注册**:
```typescript
instance.all("/workspaces/:id/worktrees/:slug/instance", proxyBaseHandler)
instance.all("/workspaces/:id/worktrees/:slug/instance/*", proxyWildcardHandler)
```

**请求转发逻辑**:
```typescript
async function proxyWorkspaceRequest(args) {
  // 1. 获取目标端口
  const port = workspaceManager.getInstancePort(workspaceId)

  // 2. 构建目标 URL
  const targetUrl = `http://${INSTANCE_PROXY_HOST}:${port}${normalizedSuffix}${search}`

  // 3. 添加认证头
  const instanceAuthHeader = workspaceManager.getInstanceAuthorizationHeader(workspaceId)

  // 4. 使用 reply.from() 代理请求
  return reply.from(targetUrl, {
    rewriteRequestHeaders: (_originalRequest, headers) => {
      if (instanceAuthHeader) {
        headers.authorization = instanceAuthHeader
      }
      headers["x-opencode-directory"] = encodedDirectory
      return headers
    }
  })
}
```

**代理路径**: UI 请求 → `/workspaces/:id/worktrees/:slug/instance/*` → Server 转发到 `http://127.0.0.1:<端口>/*`

> UI 从不直接访问 OpenCode 实例的随机端口，所有流量通过 Server 统一代理。

### 5.6 SSE 事件桥接

**文件**: `packages/server/src/workspaces/instance-events.ts`

**SSE 消费**:
```typescript
private async consumeStream(workspaceId: string, port: number, signal: AbortSignal) {
  const url = `http://${INSTANCE_HOST}:${port}/global/event`

  const headers = { Accept: "text/event-stream" }
  const authHeader = this.options.workspaceManager.getInstanceAuthorizationHeader(workspaceId)
  if (authHeader) {
    headers["Authorization"] = authHeader
  }

  const response = await fetch(url, { headers, signal, dispatcher: STREAM_AGENT })
  const reader = response.body.getReader()

  while (!signal.aborted) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: true })
    buffer = this.flushEvents(buffer, workspaceId)
  }
}
```

**事件发布**:
```typescript
private processChunk(chunk: string, workspaceId: string) {
  const payload = dataLines.join("\n").trim()
  const parsed = JSON.parse(payload)

  const base = parsed.payload && typeof parsed.payload === "object" ? parsed.payload : parsed

  this.options.eventBus.publish({
    type: "instance.event",
    instanceId: workspaceId,
    event: base
  })
}
```

**OpenCode SSE 端点**: `GET http://127.0.0.1:<PORT>/global/event`

### 5.7 认证交互

**Server 端认证生成** (`opencode-auth.ts`):
```typescript
export const DEFAULT_OPENCODE_USERNAME = "codenomad"

export function generateOpencodeServerPassword(): string {
  return crypto.randomBytes(32).toString("base64url")
}

export function buildOpencodeBasicAuthHeader(params: { username?: string; password?: string }): string | undefined {
  const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64")
  return `Basic ${token}`
}
```

**认证流程**:
1. Server 启动时生成随机用户名/密码对
2. 通过环境变量传递给 OpenCode 进程
3. 所有请求使用 `Basic Auth` 头
4. 插件端从环境变量读取认证信息

### 5.8 通信架构图

```
OpenCode 实例                          CodeNomad Server                      UI Client
     │                                       │                                    │
     │─── SSE /global/event ─────────────────►│                                    │
     │     (所有消息事件)                      │─── 解析 ───► EventBus              │
     │                                       │─── 重发 ───► SSE /api/events ──────►│
     │                                       │                                    │
     │◄── HTTP /plugin/background-processes ◄─│                                    │
     │     (后台进程管理)                      │                                    │
     │                                       │                                    │
     │◄── HTTP Proxy ─────────────────────────│◄── /workspaces/:id/instance/* ─────│
     │     (SDK API 请求)                     │     (代理转发)                      │
```

---

## 6. 状态监控机制

### 6.1 状态定义

**文件**: `packages/server/src/api-types.ts`

```typescript
// 工作区/实例状态
export type WorkspaceStatus = "starting" | "ready" | "stopped" | "error"

// 实例事件流状态
export type InstanceStreamStatus = "connecting" | "connected" | "error" | "disconnected"

// SideCar 状态
export type SideCarStatus = "running" | "stopped"

// 后台进程状态
export type BackgroundProcessStatus = "running" | "stopped" | "error"
```

### 6.2 状态机

```
┌────────────────────────────────────────────────────────────────┐
│                         状态转换图                              │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│   create()                    启动成功                    退出码≠0│
│      │                             │                         │
│      ▼                             ▼                         │
│  ┌─────────┐                 ┌─────────┐              ┌───────┐│
│  │starting │ ──► 错误 ────► │  error  │◄─────────────│ error  ││
│  └────┬────┘                 └─────────┘              └───┬───┘│
│       │                                                  │     │
│       │ 启动成功                                         │     │
│       ▼                                                  │     │
│  ┌─────────┐                                            │     │
│  │  ready  │ ──► delete() / 退出码=0 ────────────────►│     │
│  └────┬────┘                                            │     │
│       │                                                  │     │
│       │ 重启                                             │     │
│       └──────────────────────────────────────────────────┘     │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

### 6.3 状态转换代码

**创建时的状态转换** (`manager.ts`):
```typescript
async create(folder: string, name?: string): Promise<WorkspaceDescriptor> {
  const descriptor: WorkspaceRecord = {
    id, path: workspacePath, name,
    status: "starting",        // 初始状态
    ...
  }
  this.workspaces.set(id, descriptor)
  this.options.eventBus.publish({ type: "workspace.created", workspace: descriptor })

  try {
    // 启动进程...
    descriptor.status = "ready"   // 成功状态
    this.options.eventBus.publish({ type: "workspace.started", workspace: descriptor })
  } catch (error) {
    descriptor.status = "error"   // 错误状态
    this.options.eventBus.publish({ type: "workspace.error", workspace: descriptor })
    throw error
  }
}
```

**进程退出时的状态转换** (`manager.ts`):
```typescript
private handleProcessExit(workspaceId: string, info: { code: number | null; requested: boolean }) {
  const workspace = this.workspaces.get(workspaceId)
  if (!workspace) return

  if (info.requested || info.code === 0) {
    workspace.status = "stopped"     // 正常退出
  } else {
    workspace.status = "error"       // 异常退出
    workspace.error = `Process exited with code ${info.code}`
    this.options.eventBus.publish({ type: "workspace.error", workspace })
  }
}
```

### 6.4 监控机制一览

| 监控项 | 机制 | 详情 |
|--------|------|------|
| **进程退出** | `child.on('exit')` | 直接监听子进程退出事件 |
| **端口可用** | TCP Socket 连接测试 | 每 100ms 重试，超时 5s |
| **健康检查** | HTTP `GET /global/health` | 验证 `{healthy: true}` |
| **启动稳定** | 1.5s 延迟 | 确保进程不立即崩溃 |
| **SSE 重连** | 自动重试 | 断开后每 1s 重连 |
| **客户端心跳** | SSE ping/pong | 每 15s ping，45s 超时 |
| **Sidecar 健康** | TCP 连接探测 | 端口可用性检查 |

### 6.5 启动就绪检测

**文件**: `packages/server/src/workspaces/manager.ts`

启动就绪检测分为三个阶段：

```typescript
private async waitForWorkspaceReadiness(params: {...}): Promise<string | undefined> {
  // 阶段1: 等待端口可用
  await Promise.race([
    this.waitForPortAvailability(params.port),
    params.exitPromise.then((info) => {
      throw this.buildStartupError(params.workspaceId, "exited before becoming ready", info, ...)
    }),
  ])

  // 阶段2: 健康检查
  const version = await this.waitForInstanceHealth(params)

  // 阶段3: 启动稳定性延迟 (1.5秒)
  await Promise.race([
    this.delay(STARTUP_STABILITY_DELAY_MS),  // = 1500ms
    params.exitPromise.then((info) => {
      throw this.buildStartupError(params.workspaceId, "exited shortly after start", info, ...)
    }),
  ])

  return version
}
```

### 6.6 心跳机制

**SSE 客户端心跳** (`events.ts`):
```typescript
const heartbeat = setInterval(() => {
  const ping = { ts: Date.now() }
  reply.raw.write(`event: codenomad.client.ping\ndata: ${JSON.stringify(ping)}\n\n`)
}, 15000)  // 每15秒发送一次 ping
```

**客户端连接超时检测** (`connection-manager.ts`):
```typescript
const STALE_CONNECTION_TIMEOUT_MS = 45000   // 45秒超时
const STALE_SWEEP_INTERVAL_MS = 5000        // 每5秒检查一次

private sweepStaleConnections(): void {
  const cutoff = Date.now() - STALE_CONNECTION_TIMEOUT_MS
  for (const connection of Array.from(this.connections.values())) {
    if (connection.lastSeenAt > cutoff) continue
    this.disconnect(connection.key, "timeout")
  }
}
```

**OpenCode 实例事件流重连** (`instance-events.ts`):
```typescript
const RECONNECT_DELAY_MS = 1000  // 重连延迟 1秒

private async runStream(workspaceId: string, signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      await this.consumeStream(workspaceId, port, signal)
    } catch (error) {
      this.publishStatus(workspaceId, "error", ...)
      await this.delay(RECONNECT_DELAY_MS, signal)  // 自动重连
    }
  }
}
```

### 6.7 事件发布位置

| 事件类型 | 发布位置 | 文件 |
|---------|---------|------|
| `workspace.created` | `WorkspaceManager.create()` | `manager.ts` |
| `workspace.started` | `WorkspaceManager.create()` | `manager.ts` |
| `workspace.error` | `WorkspaceManager.create()` | `manager.ts` |
| `workspace.error` | `WorkspaceManager.handleProcessExit()` | `manager.ts` |
| `workspace.stopped` | `WorkspaceManager.delete()` | `manager.ts` |
| `workspace.stopped` | `WorkspaceManager.handleProcessExit()` | `manager.ts` |
| `workspace.log` | `WorkspaceRuntime.emitLog()` | `runtime.ts` |
| `instance.eventStatus` | `InstanceEventBridge.publishStatus()` | `instance-events.ts` |
| `storage.configChanged` | `SettingsService` | `service.ts` |
| `storage.stateChanged` | `SettingsService` | `service.ts` |
| `sidecar.updated` | `SideCarManager` | `manager.ts` |

---

## 7. Server 模块详解

> Server 包含 62 个 TypeScript 源文件，总计约 10,465 行代码。

### 7.1 HTTP 服务器 (`server/`)

**核心文件**: `http-server.ts` (1193行)

职责:
- 创建 Fastify 实例，注册所有路由模块
- SSE 事件流 (`/api/events`)
- 工作空间 HTTP 代理 (TCP + HTTP)
- UI 静态文件服务 (bundled/downloaded/dev-proxy/override)
- 插件 SSE 通道
- 客户端连接跟踪
- 语音模式聚合

**路由模块** (`routes/`, 14 个文件):

| 模块 | 行数 | 职责 |
|------|------|------|
| `workspaces.ts` | 131 | 工作空间 CRUD |
| `worktrees.ts` | 195 | Git worktree 管理 |
| `auth.ts` | 181 | 登录/登出/Token 认证 |
| `remote-servers.ts` | 166 | 远程服务器探测 |
| `plugin.ts` | 100 | 插件 SSE 通道 |
| `events.ts` | 89 | SSE 事件端点 |
| `background-processes.ts` | 85 | 后台进程管理 |
| `settings.ts` | 84 | 设置 CRUD |
| `speech.ts` | 74 | STT/TTS 代理 |
| `storage.ts` | 66 | 实例存储 |
| `sidecars.ts` | 56 | Sidecar 管理 |
| `filesystem.ts` | 54 | 文件浏览 |
| `meta.ts` | 56 | 服务器元信息 |

**模式**: 路由注册函数 `registerXxxRoutes(app, deps)`，通过类型化依赖对象注入。

### 7.2 认证系统 (`auth/`)

**6 个文件**，双层认证架构：

| 文件 | 行数 | 职责 |
|------|------|------|
| `manager.ts` | 180 | `AuthManager` — 中心认证协调 |
| `auth-store.ts` | 175 | 持久化哈希凭证到 `auth.json` |
| `password-hash.ts` | 49 | node-forge 密码哈希 |
| `token-manager.ts` | 32 | 一次性 Bootstrap Token 生成/消费 |
| `session-manager.ts` | 23 | 内存会话跟踪 |
| `http-auth.ts` | 38 | Cookie 解析、环回地址自动认证 |

**认证模式**: Cookie-based Session Auth (`HttpOnly; SameSite=Lax`) + Bootstrap Token (桌面应用一次性握手)。可完全禁用 (`--dangerously-skip-auth`)。

### 7.3 事件总线 (`events/`)

**`bus.ts`** (49行) — `EventBus extends EventEmitter`

```typescript
// 类型化事件发布
publish(event: WorkspaceEventPayload): void
onEvent(handler: (event: WorkspaceEventPayload) => void): () => void  // 返回 unsubscribe
```

12 种事件类型，全部通过 `WorkspaceEventPayload` 可辨识联合类型定义。

### 7.4 工作空间管理 (`workspaces/`)

| 文件 | 行数 | 职责 |
|------|------|------|
| `manager.ts` | 488 | `WorkspaceManager` — 创建/启动/停止/删除工作空间 |
| `runtime.ts` | 487 | `WorkspaceRuntime` — spawn OpenCode 进程、端口发现 |
| `instance-events.ts` | 226 | `InstanceEventBridge` — 消费 OpenCode SSE 并桥接到 EventBus |
| `git-worktrees.ts` | 241 | Git worktree 列表/创建/验证 |
| `worktree-map.ts` | 129 | 会话到 worktree 映射持久化 |
| `opencode-auth.ts` | 22 | OpenCode 实例 Basic Auth 头生成 |

### 7.5 配置服务 (`settings/`)

| 文件 | 行数 | 职责 |
|------|------|------|
| `service.ts` | 128 | `SettingsService` — YAML 配置管理 |
| `yaml-doc-store.ts` | 110 | 原子 YAML 文件读写 + merge-patch |
| `migrate.ts` | 274 | JSON → YAML 配置迁移 |
| `binaries.ts` | 55 | `BinaryResolver` — OpenCode 二进制路径解析 |
| `merge-patch.ts` | 39 | JSON Merge Patch (RFC 7396) |
| `public-config.ts` | 40 | 过滤敏感配置后再发送给客户端 |

**配置存储**: `~/.config/codenomad/config.yaml` (持久设置) + `state.yaml` (可变状态)

### 7.6 语音服务 (`speech/`)

| 文件 | 行数 | 职责 |
|------|------|------|
| `service.ts` | 106 | `SpeechService` — 提供商无关的 STT/TTS 代理 |
| `providers/openai-compatible.ts` | 234 | OpenAI 兼容语音提供商 (支持流式 TTS) |

### 7.7 Sidecar 管理 (`sidecars/`)

**`manager.ts`** (256行) — `SideCarManager`

管理端口化的辅助服务 (如 Web UI)，通过 TCP 连接探测进行健康检查。

### 7.8 后台进程管理 (`background-processes/`)

**`manager.ts`** (519行) — `BackgroundProcessManager`

Spawn 并追踪每工作空间的长运行 Shell 命令。输出存储在磁盘 (带大小限制)，工作空间停止时自动清理。

### 7.9 文件系统 (`filesystem/`)

| 文件 | 行数 | 职责 |
|------|------|------|
| `browser.ts` | 361 | `FileSystemBrowser` — 目录浏览 (受限/开放模式)，Windows 驱动器枚举 |
| `search.ts` | 184 | Fuzzy 文件搜索 (fuzzysort) |
| `search-cache.ts` | 66 | 每工作空间搜索缓存 (TTL) |

### 7.10 插件系统 (`plugins/`)

| 文件 | 行数 | 职责 |
|------|------|------|
| `channel.ts` | 55 | `PluginChannelManager` — SSE 通信通道 |
| `handlers.ts` | 36 | 插件事件处理 (ping/pong) |
| `voice-mode.ts` | 96 | `VoiceModeManager` — 跨客户端语音模式聚合 |

### 7.11 其他模块

| 模块 | 职责 |
|------|------|
| `clients/connection-manager.ts` (128行) | SSE 客户端连接追踪、陈旧连接清理 |
| `storage/instance-store.ts` (64行) | 每工作空间 JSON 数据存储 |
| `releases/dev-release-monitor.ts` (118行) | GitHub Releases API 开发频道监控 |
| `releases/release-monitor.ts` (149行) | 通用发布监控 |
| `ui/remote-ui.ts` (571行) | UI 包解析 (bundled/downloaded/dev-proxy/override) |
| `logger.ts` (133行) | Pino 日志系统，自定义生命周期过滤 |

---

## 8. UI 模块详解

> UI 包含约 388 个源文件，总计约 64,714 行代码。

### 8.1 入口与启动

**`main.tsx`** (66行) — Bootstrap 流程:

```
1. 加载持久化主题/语言
2. 层级 Provider 包裹:
   ConfigProvider > InstanceConfigProvider > I18nProvider > ThemeProvider > App
```

**`App.tsx`** (637行) — 根组件，管理:
- FolderSelectionView (文件夹选择)
- InstanceTabs (实例标签)
- SettingsScreen (设置界面)
- Sidecar Tabs
- 命令面板/模态框
- 命令注册

### 8.2 组件层级

```
App.tsx (637行)
  ├── FolderSelectionView (1041行)        # 文件夹选择视图
  ├── InstanceTabs                         # 实例标签栏
  │   └── InstanceTab
  │       └── InstanceShell2 (952行)      # 实例外壳
  │           ├── SessionSidebar (185行)   # 会话侧边栏
  │           │   └── RightPanel (995行)  # 右侧面板
  │           │       ├── ChangesTab       # 文件变更
  │           │       ├── GitChangesTab    # Git 变更
  │           │       ├── FilesTab         # 文件浏览
  │           │       └── StatusTab        # 状态信息
  │           └── MessageTimeline (920行) # 消息时间线
  │               └── MessageSection (1272行) # 消息区域
  │                   └── MessageBlock (1615行) # 消息块 (最大组件)
  │                       ├── MessageItem (696行) # 单条消息
  │                       ├── MessagePart  # 消息片段
  │                       └── ToolCall (941行)   # 工具调用
  │                           └── renderers/     # 工具渲染器 (13个)
  │                               ├── apply-patch.tsx
  │                               ├── bash.tsx
  │                               ├── edit.tsx
  │                               ├── read.tsx
  │                               ├── write.tsx
  │                               ├── patch.tsx
  │                               ├── webfetch.tsx
  │                               ├── question.tsx
  │                               ├── task.tsx
  │                               ├── todo.tsx
  │                               └── ...
  ├── PromptInput (773行)                 # 提示词输入
  ├── CommandPalette (322行)              # 命令面板
  ├── SessionList (798行)                 # 会话列表
  ├── SettingsScreen                      # 设置界面
  │   └── settings/ (7 files)             # 设置子组件
  └── Modals/Dialogs                      # 模态框和对话框
```

### 8.3 状态管理 (Stores, 31 files)

**模式**: SolidJS 响应式原语 (`createSignal`, `createStore`)，导出 signals 和 action 函数（非类）。

| Store | 行数 | 职责 |
|-------|------|------|
| `instances.ts` | 1152 | 工作空间/实例生命周期管理 |
| `preferences.tsx` | 882 | 应用偏好设置、配置持久化 |
| `message-v2/instance-store.ts` | 1241 | 每实例消息存储 |
| `session-api.ts` | 780 | 会话 API 操作 (创建、发消息等) |
| `session-state.ts` | 762 | 会话状态追踪 (草稿、加载状态等) |
| `session-events.ts` | 754 | SSE 事件处理 → 会话更新 |
| `message-v2/bridge.ts` | 311 | SSE 事件到消息 Store 桥接 |
| `worktrees.ts` | 394 | Git worktree 状态管理 |
| `app-tabs.ts` | 172 | 标签管理 |
| `sessions.ts` | 141 | 会话列表管理 |
| `sidecars.ts` | 149 | Sidecar 状态 |
| `conversation-speech.ts` | 548 | 会话语音合成 |
| `speech.ts` | 46 | 语音状态 |

**核心 Signals**:

```typescript
// instances.ts
const [instances, setInstances] = createSignal<Map<string, Instance>>(new Map())
const [activeInstanceId, setActiveInstanceId] = createSignal<string | null>(null)
const [permissionQueues, setPermissionQueues] = createSignal<Map<string, PermissionRequestLike[]>>(new Map())
const [questionQueues, setQuestionQueues] = createSignal<Map<string, QuestionRequest[]>>(new Map())
const [activeInterruption, setActiveInterruption] = createSignal<Map<string, ActiveInterruption>>(new Map())

// sessions.ts — 三层 Map 结构
const [sessions, setSessions] = createSignal<Map<string, Map<string, Session>>>(new Map())
const [activeSessionId, setActiveSessionId] = createSignal<Map<string, string>>(new Map())
const [agents, setAgents] = createSignal<Map<string, Agent[]>>(new Map())
const [providers, setProviders] = createSignal<Map<string, Provider[]>>(new Map())

// session-state.ts
const [sessionDraftPrompts, setSessionDraftPrompts] = createSignal<Map<string, string>>(new Map())
const [loading, setLoading] = createSignal({
  fetchingSessions: new Map<string, boolean>(),
  creatingSession: new Map<string, boolean>(),
  deletingSession: new Map<string, Set<string>>(),
  loadingMessages: new Map<string, Set<string>>(),
})
```

### 8.4 核心库 (lib/, 42 entries)

| 模块 | 行数 | 职责 |
|------|------|------|
| `api-client.ts` | 469 | HTTP 客户端 — Fetch 封装所有 Server API |
| `sse-manager.ts` | 231 | SSE 连接管理 — 订阅 `/api/events`，分发类型化事件 |
| `sdk-manager.ts` | 64 | `@opencode-ai/sdk` 客户端管理 — 每实例创建 |
| `runtime-env.ts` | 86 | 运行时检测 (electron/tauri/web + desktop/mobile) |
| `storage.ts` | 261 | 设置持久化到 Server |
| `markdown.ts` | 380 | Markdown 渲染 (Shiki 语法高亮) |
| `theme.tsx` | 224 | 主题提供者 (system/light/dark) |
| `server-events.ts` | 87 | 服务端事件信号管理 |
| `i18n/index.tsx` | 237 | i18n 系统 — `useI18n()` / `tGlobal()` |
| `hooks/` | 7 files | `use-app-lifecycle`, `use-commands`, `use-folder-drop`, `use-global-cache`, `use-instance-metadata`, `use-scroll-cache`, `use-speech` |
| `shortcuts/` | 4 files | 快捷键定义: `agent`, `escape`, `input`, `navigation` |
| `monaco/` | 3 files | Monaco 编辑器配置、语言检测、模型缓存 |

**API 客户端** (`api-client.ts`):

```typescript
const API_BASE = import.meta.env.VITE_CODENOMAD_API_BASE ?? window.__CODENOMAD_API_BASE__

// SSE 连接
connectEvents(onEvent, onError, onPing) {
  const source = new EventSource(url, { withCredentials: true })
  source.onmessage = (event) => onEvent(JSON.parse(event.data))
  source.addEventListener("codenomad.client.ping", (event) => {
    sendClientConnectionPong({ ...identity, pingTs: payload.ts })
  })
  return source
}
```

**SDK 管理器** (`sdk-manager.ts`):

```typescript
class SDKManager {
  private clients = new Map<string, OpencodeClient>()

  createClient(instanceId, proxyPath, worktreeSlug = "root") {
    const key = `${instanceId}:${normalizeProxyPath(proxyPath)}`
    if (existing) return existing
    const baseUrl = buildInstanceBaseUrl(proxyPath)
    const client = createOpencodeClient({ baseUrl })
    this.clients.set(key, client)
    return client
  }

  destroyClientsForInstance(instanceId) {
    // 清理该实例的所有客户端
  }
}
```

### 8.5 国际化 (i18n)

**7 种语言**: `en`, `es`, `fr`, `ru`, `ja`, `zh-Hans`, `he`

- 每种语言有 **17 个消息分片文件**: advancedSettings, app, commands, dialogs, filesystem, folderSelection, index, instance, loadingScreen, logs, markdown, messaging, remoteAccess, session, settings, time, toolCall
- English 为回退语言；其他语言缺失 key 回退到英文，最终回退到 raw key
- 支持 RTL (希伯来语)
- 惰性加载：英文内联打包，其他语言动态 `import()` + 缓存

**API**: `useI18n()` 返回 `t()` 函数 (组件内), `tGlobal()` (非组件代码)

### 8.6 CSS 架构

```
三层设计系统:

1. tokens.css (507行) — CSS 自定义属性 / 设计令牌
     ↓
2. utilities.css (192行) — 工具类
     ↓
3. 聚合入口:
   ├── components/ (11 files) — 可复用 UI 模式 (buttons, badges, dropdowns, selectors)
   ├── messaging/  (10 files) — 消息/输入/工具调用样式
   └── panels/     (6 files)  — 面板/布局/标签样式
```

**聚合入口文件**仅 `@import` 功能子文件，保持精简。

### 8.7 类型定义 (types/, 10 files)

`attachment.ts`, `delete-hover.ts`, `diff.ts`, `global.ts`, `instance.ts`, `message.ts`, `permission.ts`, `qrcode.ts`, `question.ts`, `session.ts`

---

## 9. Desktop Shell 架构

### 9.1 双壳架构

CodeNomad 支持两种桌面 Shell：**Electron** (主力) 和 **Tauri** (Rust, 实验)。UI 通过 `runtime-env.ts` 检测运行时，`native-functions.ts` 分派到平台实现。

```
           ┌─────────────────────────────────────┐
           │         UI (SolidJS)                 │
           │   runtime-env.ts 检测平台             │
           │   native-functions.ts 分派调用        │
           └────────┬──────────┬──────────────────┘
                    │          │
          ┌─────────▼──┐  ┌───▼──────────┐
          │  Electron   │  │   Tauri      │
          │  (Node.js)  │  │   (Rust)     │
          │  main.ts    │  │   main.rs    │
          │  ipc.ts     │  │   commands   │
          └─────────────┘  └──────────────┘
```

### 9.2 Electron Shell

**9 个源文件**, ~2,094 行。

| 文件 | 行数 | 职责 |
|------|------|------|
| `main/main.ts` | 669 | Electron 主进程：BrowserWindow、CLI 生命周期、远程窗口、缩放、深度链接 |
| `main/process-manager.ts` | 703 | `CliProcessManager`：spawn CLI Server 进程，stdout 解析就绪状态，Bootstrap Token 交换 |
| `main/ipc.ts` | 160 | IPC 处理: `cli:getStatus`, `cli:restart`, `dialog:open`, `filesystem:getDirectoryPaths`, `media:requestMicrophoneAccess`, `power:setWakeLock`, `notifications:show`, `remote:openWindow` |
| `main/menu.ts` | 84 | macOS 应用菜单 |
| `main/permissions.ts` | 58 | 媒体权限处理 (麦克风) |
| `main/storage.ts` | 121 | Electron 存储路径 |
| `main/user-shell.ts` | 139 | 解析用户默认 Shell |
| `preload/index.cjs` | 29 | `contextBridge` 暴露 `window.electronAPI` |

**启动流程**:
```typescript
app.whenReady().then(() => {
  app.setAppUserModelId("ai.neuralnomads.codenomad.client")
  startCli()       // 启动 CLI Server 进程
  createWindow()   // 创建 BrowserWindow (1400x900, contextIsolation: true)
})
```

**安全**: `contextIsolation: true`, `nodeIntegration: false`, 所有原生操作通过 IPC + preload 暴露。

### 9.3 Tauri Shell (实验)

**2 个 Rust 源文件**, ~1,916 行。

| 文件 | 行数 | 职责 |
|------|------|------|
| `src-tauri/src/main.rs` | 722 | Tauri 应用配置：窗口管理、IPC 命令、菜单、全局快捷键、缩放、Wake Lock、远程窗口、通知 |
| `src-tauri/src/cli_manager.rs` | 1194 | `CliProcessManager`：CLI 进程管理，用户 Shell spawn，stdout 就绪状态解析，Bootstrap Token，跨平台 (Win/Mac/Linux) |

**Tauri 依赖**: `tauri 2.5.2`, `serde`, `serde_yaml`, `keepawake`, `tauri-plugin-dialog`, `tauri-plugin-opener`, `tauri-plugin-global-shortcut`, `tauri-plugin-notification`

**构建目标**: `app`, `appimage`, `deb`, `rpm`, `nsis`

### 9.4 Electron vs Tauri 对比

| 特性 | Electron | Tauri |
|------|----------|-------|
| 语言 | TypeScript | Rust |
| 包大小 | 较大 | 较小 |
| 进程管理 | `child_process.spawn` | `Command::new` + `std::process` |
| IPC | `ipcMain.handle/invoke` | `#[tauri::command]` |
| 原生对话框 | `dialog.showOpenDialog` | `tauri-plugin-dialog` |
| 通知 | Electron API | `tauri-plugin-notification` |
| Wake Lock | Power Save Blocker | `keepawake` crate |
| 成熟度 | 主力 | 实验 |

### 9.5 Cloudflare Worker

**`packages/cloudflare/src/index.ts`** (26行)

Cloudflare Worker 用于托管 UI 静态资源，域名 `ui.codenomad.neuralnomads.ai`。为 `/version.json` 添加 `Cache-Control: no-store` 头。

---

## 10. OpenCode 插件系统

### 10.1 概述

`packages/opencode-config/` 提供了一个 OpenCode 插件模板，在 OpenCode 实例启动时自动加载，建立与 CodeNomad Server 的双向通信通道。

**5 个源文件**, ~664 行。依赖: `@opencode-ai/plugin` (v1.3.7)

### 10.2 工作流程

```
1. Server 复制 opencode-config 模板到 ~/.config/codenomad/opencode-config/
2. Spawn OpenCode 时设置 OPENCODE_CONFIG_DIR 环境变量
3. OpenCode 自动加载 plugin/codenomad.ts
4. 插件读取 CODENOMAD_INSTANCE_ID + CODENOMAD_BASE_URL 环境变量
5. 建立 SSE 连接到 Server (GET /workspaces/:id/plugin/events)
6. POST 事件到 Server (/workspaces/:id/plugin/event)
```

### 10.3 插件文件

| 文件 | 行数 | 职责 |
|------|------|------|
| `plugin/codenomad.ts` | 62 | 插件入口 — 注册工具、事件监听 |
| `plugin/lib/client.ts` | 133 | HTTP+SSE 客户端到 Server |
| `plugin/lib/request.ts` | 214 | HTTP 请求辅助 (认证头、重试) |
| `plugin/lib/background-process.ts` | 253 | 后台进程工具定义 (供 AI Agent 使用) |
| `opencode.jsonc` | - | OpenCode 配置模板 (仅 `$schema`) |

### 10.4 插件能力

1. **后台进程工具**: 为 AI Agent 提供后台 Shell 命令管理能力
2. **语音模式**: 注入系统提示词，指导 AI 在回复前添加口语摘要
3. **双向通信**: SSE 订阅 Server 事件 + POST 发送事件到 Server

### 10.5 插件通信架构

```
OpenCode 进程                        CodeNomad Server
     │                                    │
     │ CodeNomadPlugin (自动加载)           │
     │                                    │
     │─── SSE GET /plugin/events ─────────►│  订阅 Server 事件
     │                                    │
     │─── POST /plugin/event ─────────────►│  发送事件到 Server
     │     (voice-mode, background-proc)   │
     │                                    │
     │◄── Server 指令 ────────────────────│  通过 SSE 下发
```

---

## 11. 数据流全景

### 11.1 端到端消息流

```
用户输入 Prompt
    │
    ▼
PromptInput 组件
    │
    ▼
session-api.ts → serverApi.sendMessage()
    │
    ▼
HTTP POST → /workspaces/:id/.../instance/session/:sessionId/message
    │
    ▼
Server HTTP Proxy → http://127.0.0.1:<PORT>/session/:sessionId/message
    │
    ▼
OpenCode 实例处理
    │
    ▼
OpenCode SSE → /global/event → MessageUpdated 事件
    │
    ▼
InstanceEventBridge 消费 → EventBus.publish("instance.event")
    │
    ▼
SSE /api/events → UI SSEManager
    │
    ▼
session-events.ts → message-v2/bridge.ts → instance-store.ts
    │
    ▼
SolidJS Signal 更新 → UI 重渲染
    │
    ▼
MessageTimeline → MessageSection → MessageBlock → MessageItem
```

### 11.2 工作空间创建流

```
用户选择文件夹
    │
    ▼
UI → serverApi.createWorkspace({ folder })
    │
    ▼
HTTP POST /api/workspaces → WorkspaceManager.create()
    │
    ├── 生成唯一 ID
    ├── 生成 Basic Auth 凭证
    ├── WorkspaceRuntime.launch() → spawn OpenCode 子进程
    ├── waitForPortAvailability() → TCP 连接测试
    ├── probeInstance() → GET /global/health
    ├── delay(1500ms) → 稳定性检查
    │
    ▼
EventBus → SSE → UI
    │
    ▼
instances.ts → setActiveInstanceId() → UI 渲染新标签
```

### 11.3 API 代理路径

UI 从不直接访问 OpenCode 实例端口。所有流量通过 Server 统一代理：

```
UI 请求: /workspaces/:id/worktrees/:slug/instance/session/xxx
         │
         ▼
Server proxyWorkspaceRequest()
         │
         ├── workspaceManager.getInstancePort(:id) → 获取目标端口
         ├── 注入 Authorization 头 (Basic Auth)
         ├── 注入 x-opencode-directory 头
         │
         ▼
HTTP Proxy → http://127.0.0.1:<PORT>/session/xxx
         │
         ▼
OpenCode 实例响应 → 原路返回
```

---

## 12. 安全模型

### 12.1 认证架构总览

CodeNomad 采用 **Bootstrap Token + Session Cookie** 双层认证架构：

```
┌──────────────┐     1. 启动 CLI (--generate-token)     ┌──────────────┐
│  Desktop App │ ──────────────────────────────────────► │    Server     │
│  (Electron/  │     stdout: CODENOMAD_BOOTSTRAP_TOKEN:x │              │
│   Tauri)     │                                         │              │
│              │     2. POST /api/auth/token {token}     │              │
│              │ ──────────────────────────────────────► │  验证 Token  │
│              │     3. Set-Cookie: codenomad_session=y  │  创建 Session│
│              │ ◄────────────────────────────────────── │              │
│              │                                         │              │
│              │     4. 导航到主 URL (已认证)             │              │
│              │ ──────────────────────────────────────► │  Cookie 验证 │
└──────────────┘                                         └──────────────┘
```

### 12.2 AuthManager 组成

**文件**: `packages/server/src/auth/manager.ts`

```
AuthManager
  ├── AuthStore          # 持久化凭证到 auth.json (哈希存储)
  ├── TokenManager       # 一次性 Bootstrap Token (内存, 60s TTL)
  └── SessionManager     # 内存会话跟踪
```

**关键行为**:
- `--generate-token` 启动时打印 `CODENOMAD_BOOTSTRAP_TOKEN:<token>` 到 stdout
- Bootstrap Token 60 秒后自动过期，仅可使用一次
- Session Cookie 名称: `codenomad_session` (或通过 `--auth-cookie-name` 自定义)
- Cookie 属性: `HttpOnly; Path=/; SameSite=Lax; Secure`(TLS 时)
- `--dangerously-skip-auth` 禁用全部认证

### 12.3 Desktop Token 交换

**Electron** (`process-manager.ts`):
1. 解析 stdout 提取 `CODENOMAD_BOOTSTRAP_TOKEN:` 前缀
2. CLI 就绪后调用 `maybeExchangeAndNavigate()`
3. POST token 到 `/api/auth/token`
4. 将返回的 `Set-Cookie` 注入 `session.defaultSession.cookies`
5. 导航到主 URL (已携带认证 Cookie)
6. 失败时重定向到 `/login`

**Cookie 名称隔离**: 每次启动生成唯一名称 `codenomad_session_<pid>_<timestamp>`，防止跨实例会话泄漏。

### 12.4 环回地址自动认证

**文件**: `packages/server/src/auth/http-auth.ts`

```typescript
isLoopbackAddress(remoteAddress) {
  // 匹配: 127.0.0.1, ::1, ::ffff:127.0.0.1
}
```

环回请求可享受不同的认证策略（如更宽松的访问控制）。

### 12.5 TLS 安全

**文件**: `packages/server/src/server/tls.ts` (283行)

| 模式 | 说明 |
|------|------|
| **provided** | 用户通过 CLI 标志提供 key/cert/ca |
| **generated** | 自动生成自签名 CA + 叶证书 |

**自签名证书流程**:
1. 生成 CA (`CodeNomad Local CA`, 365 天有效期)，存储于 `~/.config/codenomad/tls/`
2. 生成叶证书 (30 天有效期)，由 CA 签名
3. SANs 包含: `localhost`, `127.0.0.1`, 配置的 host IP, 额外 `--tlsSANs`
4. 叶证书到期前 3 天自动轮换；CA 仅过期时轮换
5. CA 证书路径通过 `NODE_EXTRA_CA_CERTS` 传递给 OpenCode 子进程

### 12.6 敏感配置过滤

**文件**: `packages/server/src/settings/public-config.ts`

发送给客户端的配置中，`speech.apiKey` 被替换为布尔值 `hasApiKey`，防止 API 密钥泄漏到前端。

### 12.7 Electron 渲染进程安全

**文件**: `packages/electron-app/electron/main/main.ts`

| 措施 | 说明 |
|------|------|
| `contextIsolation: true` | 渲染进程隔离，无法直接访问 Node API |
| `nodeIntegration: false` | 禁止在渲染进程使用 `require()` |
| 导航白名单 | 非白名单 origin 在系统浏览器打开而非 webview 内导航 |
| 窗口 origin 追踪 | 每个远程窗口有独立的允许 origin |
| TLS 证书处理 | 远程窗口 `skipTlsVerify` 时，仅对特定 origin 跳过验证 |

---

## 13. 错误处理策略

### 13.1 进程级错误

**Workspace 启动失败** (`runtime.ts`):
- 端口检测超时: 每 10 秒警告一次
- 进程在端口发现前退出: launch Promise reject，附带最近 50 行 stdout/stderr 作为错误信息
- 进程在端口发现后崩溃: `onExit` 回调触发，区分正常退出 (`requestedStop`) 与异常崩溃

**进程停止策略** (`runtime.ts`):
```
1. 发送 SIGTERM (POSIX: 进程组 -pid; Windows: taskkill /T)
2. 等待 2 秒
3. 升级为 SIGKILL 强制终止
```

**敏感信息过滤**: 环境变量中包含 `PASSWORD`、`TOKEN`、`SECRET` 的值在日志中自动脱敏。

### 13.2 网络级错误

**SSE 断线重连** (`sse-manager.ts`):
- 监听 `instance.eventStatus` 事件
- `disconnected` + reason=`workspace stopped` → 不重连
- 其他断线原因 → UI 显示断连通知，用户确认后调用 `stopInstance()`

**API 调用失败**:
- UI `hydrateInstanceData()` 包装所有 fetch 在 try/catch 中
- 失败记录日志但不崩溃应用
- `rehydrateInstance()` 清除所有缓存数据，从头重新获取

### 13.3 状态级错误

**工作空间错误处理** (`instances.ts`):

| 事件 | 处理 |
|------|------|
| `workspace.error` | `showWorkspaceLaunchError()` 显示错误 UI |
| `workspace.stopped` | `releaseInstanceResources()` (销毁 SDK 客户端、设置 SSE 状态为 disconnected) → `removeInstance()` |
| 权限/问题同步失败 | `syncPendingPermissions`/`syncPendingQuestions` 重连时与服务器协调状态，移除过期条目 |

---

## 14. 远程访问架构

### 14.1 监听模式

**文件**: `packages/server/src/index.ts`

| 模式 | HTTPS 绑定 | HTTP 绑定 | 使用场景 |
|------|-----------|-----------|---------|
| `--host 127.0.0.1` (默认) | loopback | loopback | 本地桌面/浏览器 |
| `--host 0.0.0.0` | `0.0.0.0` (所有接口) | `127.0.0.1` (仅 loopback) | 远程 LAN 访问 |

> 安全设计: 即使启用远程访问，HTTP 仍仅绑定 loopback，远程流量必须走 HTTPS。

### 14.2 网络地址解析

**文件**: `packages/server/src/server/network-addresses.ts`

```
1. 枚举所有系统网络接口 (os.networkInterfaces())
2. 过滤 IPv4，排除 0.0.0.0
3. 分类: "loopback" | "external"
4. 排序: 私有 IP (10.x, 172.16-31.x, 192.168.x) → 链路本地 (169.254.x) → 公网 IP
5. 返回 primaryRemoteUrl 作为用户可见地址
```

### 14.3 远程服务器探测

**文件**: `packages/server/src/server/routes/remote-servers.ts`

`POST /api/remote-servers/probe` — 从当前 Server 探测另一个远程 CodeNomad 实例：

```typescript
请求: { baseUrl, skipTlsVerify }
响应: {
  ok, reachable, requiresAuth, authenticated,
  errorCode?: "tls_error" | "connection_refused" | "dns_error" | "timeout" | "invalid_url"
}
```

使用 undici 发起请求，支持 `rejectUnauthorized: false` 跳过 TLS 验证。

---

## 15. Session 与 Message 数据模型

### 15.1 Instance 类型

**文件**: `packages/ui/src/types/instance.ts`

```typescript
interface Instance {
  id: string; folder: string; port: number; pid: number; proxyPath: string
  status: "starting" | "ready" | "error" | "stopped"
  error?: string; client: OpencodeClient | null
  metadata?: InstanceMetadata  // project, mcpStatus, lspStatus, plugins, version
  binaryPath?: string; binaryLabel?: string; binaryVersion?: string
  environmentVariables?: Record<string, string>
}
```

### 15.2 Session 类型

**文件**: `packages/ui/src/types/session.ts`

```typescript
interface Session {
  instanceId: string
  parentId: string | null
  agent: string
  model: { providerId: string; modelId: string }
  version: string
  pendingPermission?: boolean
  pendingQuestion?: boolean
  status: "idle" | "working" | "compacting"
  retry?: SessionRetryState   // { attempt, message, next }
  diff?: FileDiff[]
}
```

### 15.3 Message 类型

**文件**: `packages/ui/src/types/message.ts`

```typescript
interface Message {
  id: string
  sessionId: string
  type: "user" | "assistant"
  parts: ClientPart[]
  timestamp: number
  status: "sending" | "sent" | "streaming" | "complete" | "error"
  version: number
}
```

`ClientPart` 扩展自 SDK `Part`，增加 `sessionID`、`messageID`、`synthetic`、`renderCache`、`pendingPermission` 等客户端字段。`MessagePartDeltaEvent` 支持流式文本增量更新。

### 15.4 Message Store 状态结构

**文件**: `packages/ui/src/stores/message-v2/instance-store.ts`

```typescript
InstanceMessageState {
  instanceId
  sessions: Record<string, SessionRecord>
  sessionOrder: string[]
  messages: Record<string, MessageRecord>
  lastAssistantMessageIds: Record<string, string>

  // Pending Parts: 先于父消息到达的 part 缓冲 (30s 最大存活)
  pendingParts: Record<string, PendingPartEntry[]>

  // 修订追踪: 每会话单调递增，用于滚动位置响应式
  sessionRevisions: Record<string, number>

  // 权限/问题队列
  permissions: { queue[], active, byMessage }
  questions: { queue[], active, byMessage }

  // 用量追踪: 每会话 token/cost 统计
  usage: Record<string, SessionUsageState>
    // totalInputTokens, totalOutputTokens, totalReasoningTokens, totalCost

  // 滚动状态快照
  scrollState: Record<string, ScrollSnapshot>

  // Todo 追踪: 已完成的 todowrite 工具调用
  latestTodos: Record<string, LatestTodoSnapshot>
}
```

**关键模式**:
- **Pending Parts 缓冲**: SSE 事件中 part 可能先于其父 message 到达，缓冲在 `pendingParts` 中，父消息到达时刷新
- **Session Revert**: `setSessionRevert()` 裁剪回退点之后的所有消息
- **Usage 累加**: 每消息级别的 `totalInputTokens`/`totalOutputTokens`/`totalCost` 累加统计

### 15.5 服务端类型 (api-types.ts)

```typescript
WorkspaceDescriptor {
  id, path, name?, status, pid?, port?, proxyPath
  binaryId, binaryLabel, binaryVersion?
  createdAt, updatedAt, error?
}

NetworkAddress { ip, family, scope: "external" | "internal" | "loopback", remoteUrl }

ServerMeta {
  localUrl, remoteUrl?, eventsUrl, host, listeningMode
  localPort, remotePort?, hostLabel, workspaceRoot
  addresses, serverVersion?, ui?, support?, update?
}
```

---

## 16. Desktop Bootstrap 握手

### 16.1 Electron 启动握手流程

**文件**: `packages/electron-app/electron/main/process-manager.ts`

```
1. CliProcessManager.start()
   │
   ├── 构建启动参数:
   │   ["serve", "--host", host, "--generate-token",
   │    "--auth-cookie-name", "codenomad_session_<pid>_<ts>",
   │    "--unrestricted-root", ...]
   │
   ├── 选择启动模式:
   │   ├── macOS Packaged → utilityProcess.fork(cli-supervisor.cjs)
   │   │   (通过 login shell 获取完整用户环境)
   │   └── Dev/Unpacked → 直接 spawn() + 可选 shell 包装
   │
   ├── 解析 stdout:
   │   ├── "CODENOMAD_BOOTSTRAP_TOKEN:<token>" → 提取 token
   │   └── "Local Connection URL: <url>"       → 标记 ready
   │
   ├── 60 秒启动超时 → 超时后 kill 进程组
   │
   └── 就绪后 maybeExchangeAndNavigate():
       ├── POST /api/auth/token { bootstrapToken }
       ├── Set-Cookie → session.defaultSession.cookies.set()
       └── 加载主 URL (已认证)
```

### 16.2 CLI Supervisor

**文件**: `packages/electron-app/electron/resources/cli-supervisor.cjs` (131行)

```
职责: 在 macOS 打包构建中通过 login shell 启动 CLI
  ├── 接收 { command, args, cwd } 参数
  ├── spawn 子进程，转发 stdout/stderr
  ├── 优雅关闭: SIGTERM/SIGINT/disconnect
  └── 30 秒宽限期后强制 kill
```

### 16.3 Tauri 启动握手

**文件**: `packages/tauri-app/src-tauri/src/cli_manager.rs`

与 Electron 几乎相同的逻辑，Rust 实现：

| 差异点 | Electron | Tauri |
|--------|----------|-------|
| 进程组隔离 | `detached: true` | `libc::setpgid(0, 0)` |
| Token 交换 | fetch API | 原始 TcpStream HTTP 请求 |
| HTTPS 本地 | 标准流程 | 跳过 token 交换，直接导航到 /login |
| Cookie 设置 | `session.cookies.set()` | Tauri `Cookie::build()` API |
| 进程终止 | SIGTERM → 2s → SIGKILL | SIGTERM → 30s → SIGKILL |
| Windows | `taskkill /T` | `taskkill /PID /T [/F]` |

---

## 17. 语音模式端到端流程

### 17.1 架构概览

```
┌─ UI Client ──────────────────────────────────────────────────────────┐
│  1. 用户启用 Voice Mode → speech.ts 设置状态                         │
│  2. conversation-speech.ts 监听 assistant 文本 part                  │
│  3. 提取 ```spoken``` 代码块 → 加入 TTS 播放队列                     │
│  4. TTS 播放: buffered (完整音频) 或 streaming (MediaSource 分块)    │
└────────────────────────────┬────────────────────────────────────────┘
                             │ SSE
┌─ Server ──────────────────┼─────────────────────────────────────────┐
│  VoiceModeManager          │                                         │
│  ├── 聚合所有客户端的 voice mode 状态                                │
│  ├── 任一客户端启用 → 聚合为 true                                   │
│  ├── 状态变化 → 通过 PluginChannel 广播 codenomad.voiceMode         │
│  └── 客户端断开 → 自动清理并重新计算                                │
│                                                                       │
│  SpeechService → OpenAI-Compatible Provider                          │
│  ├── STT: openai audio.transcriptions.create()                      │
│  └── TTS: POST /audio/speech (buffered 或 streaming)                │
└────────────────────────────┬────────────────────────────────────────┘
                             │ Plugin SSE
┌─ OpenCode Plugin ─────────┼─────────────────────────────────────────┐
│  CodeNomadPlugin                                                     │
│  ├── 监听 codenomad.voiceMode 事件                                   │
│  ├── voice mode 开启时 hook chat.message                             │
│  └── 注入系统提示: "在回复前添加 ```spoken 摘要块"                    │
└──────────────────────────────────────────────────────────────────────┘
```

### 17.2 语音配置

**文件**: `packages/server/src/speech/service.ts`

```yaml
# config.yaml 中的 speech 配置
speech:
  provider: openai-compatible     # 默认提供商
  model: gpt-4o-mini-transcribe   # STT 模型
  ttsModel: gpt-4o-mini-tts       # TTS 模型
  voice: alloy                     # 语音
  format: mp3                      # 音频格式
  apiKey: <key>                    # 或 OPENAI_API_KEY 环境变量
  baseUrl: <url>                   # 或 OPENAI_BASE_URL 环境变量
```

### 17.3 TTS 播放模式

| 模式 | 实现 | 适用场景 |
|------|------|---------|
| **Buffered** | 等待完整音频 → `<Audio>` 元素播放 | 短文本 |
| **Streaming** | `MediaSource` → `SourceBuffer` 分块追加 | 长文本，低延迟 |

### 17.4 spoken 块格式

Voice mode 开启后，AI 回复格式变为：

````markdown
```spoken
这是对回复的口语化摘要，2-4 句自然对话。
```

正常的文字回复内容...
````

UI 提取 `` ```spoken `` `` 块进行 TTS 播放，其余内容正常渲染。

---

## 18. UI 远程包解析与自动更新

### 18.1 四种解析策略

**文件**: `packages/server/src/ui/remote-ui.ts` (571行)

```
解析优先级:

1. dev-proxy     ──► --ui-dev-server 设置时，代理到 Vite dev server
2. override      ──► --ui-dir 设置时，从指定目录加载
3. downloaded    ──► autoUpdate 开启时，从远程 manifest 下载最新版本
4. bundled       ──► 内置的 public/ 目录静态文件 (最终 fallback)
```

### 18.2 下载与更新流程

```
1. 获取远程 manifest: https://ui.codenomad.neuralnomads.ai/version.json (5s 超时)
   ├── 校验字段: minServerVersion, latestUIVersion, uiPackageURL, sha256
   ├── URL 必须为 HTTPS
   └── sha256 必须为 64 位 hex

2. 版本兼容性检查:
   └── server version < minServerVersion → 返回 supported: false + 升级提示

3. 下载 (30s 超时):
   └── 校验 sha256 → yauzl 解压 (含 zip-slip 防护)

4. 目录轮换:
   ├── current → previous
   └── 新下载 → current

5. 服务新版本

Fallback 链: downloaded → bundled → previous (旋转缓存)
```

### 18.3 版本比较

- 高版本优先
- 版本相同时按来源优先级: `downloaded(1) > bundled(2) > previous(0)`

---

## 19. 开发模式架构

### 19.1 Server 开发模式

**文件**: `packages/server/package.json`

```bash
npm run dev --workspace @neuralnomads/codenomad
# 等价于:
cross-env \
  CODENOMAD_DEV=1 \
  CODENOMAD_SERVER_PASSWORD=codenomad-dev \
  CLI_UI_DEV_SERVER=http://localhost:3000 \
  CLI_HTTPS=false \
  CLI_HTTP=true \
  tsx src/index.ts
```

| 环境变量 | 值 | 作用 |
|---------|-----|------|
| `CODENOMAD_DEV` | `1` | 启用开发模式行为 |
| `CODENOMAD_SERVER_PASSWORD` | `codenomad-dev` | 预设开发密码 |
| `CLI_UI_DEV_SERVER` | `http://localhost:3000` | UI 代理到 Vite dev server |
| `CLI_HTTPS` | `false` | 禁用 HTTPS |
| `CLI_HTTP` | `true` | 启用 HTTP |

使用 `tsx` 直接运行 TypeScript，无需预编译。

### 19.2 UI 开发模式

**文件**: `packages/ui/vite.config.ts`

```
Vite Dev Server:
  ├── 端口: 3000
  ├── 根目录: ./src/renderer
  ├── Monaco 编辑器: 按需从 node_modules 复制到 public/
  └── PWA (Workbox):
      ├── navigateFallback: null (保留服务端认证重定向)
      ├── globPatterns: 仅静态资源 (JS/CSS/图片/字体)
      └── Monaco 资源排除预缓存 (运行时缓存)

构建输出:
  ├── main — 主 HTML 入口
  ├── loading — 加载页 HTML 入口
  ├── ui-version.json — UI 版本号 (构建时生成)
  └── Vendor 分块: monaco, git-diff, highlight.js, fast-diff
```

### 19.3 完整开发流程

```
终端 1: UI Dev Server
  npm run dev --workspace @codenomad/ui
  → Vite 启动在 :3000

终端 2: Server Dev
  npm run dev --workspace @neuralnomads/codenomad
  → tsx 直接运行 TypeScript
  → UI 请求代理到 :3000 (Vite HMR)

浏览器: http://127.0.0.1:<server-port>
```

---

## 20. 构建系统

### 20.1 构建依赖链

```
UI Build → Server Build → Desktop Build
   │            │              │
   │            │              ├── Electron (electron-vite + electron-builder)
   │            │              └── Tauri (cargo + tauri-cli)
   │            │
   │            ├── tsc 编译 TypeScript
   │            ├── copy-ui-dist.mjs (UI dist → server/public/)
   │            ├── copy-opencode-config.mjs (插件模板 → server/dist/)
   │            └── copy-auth-pages.mjs (静态 HTML → server/dist/)
   │
   └── Vite 构建 SolidJS SPA
       ├── 代码分块 (monaco, git-diff, highlight.js, fast-diff)
       ├── 生成 ui-version.json
       └── PWA service worker (Workbox)
```

### 20.2 构建脚本

| 脚本 | 位置 | 职责 |
|------|------|------|
| `copy-ui-dist.mjs` | `packages/server/scripts/` | 复制 UI dist → server/public/ |
| `copy-opencode-config.mjs` | `packages/server/scripts/` | 复制插件模板 → server/dist/ (含 npm install --production) |
| `copy-auth-pages.mjs` | `packages/server/scripts/` | 复制静态 HTML 认证页面 (tsc 不编译 HTML) |
| `bump-version.js` | `scripts/` | 跨所有 workspace 更新版本号 + 同步 Tauri 版本 |
| `prebuild.js` | `packages/tauri-app/scripts/` | Tauri 预构建: 构建 UI + Server → 复制到 src-tauri/resources/ |
| `sync-tauri-version.js` | `packages/tauri-app/scripts/` | 同步版本到 Cargo.toml, Cargo.lock, tauri.conf.json |

### 20.3 根级构建命令

```bash
npm run build              # Electron 完整构建
npm run build:ui           # 仅构建 UI
npm run build:mac-x64      # macOS x64
npm run build:binaries     # 仅构建二进制
npm run build:tauri         # Tauri 构建
npm run typecheck           # TypeScript 类型检查 (UI + Electron)
npm run bumpVersion         # 版本号更新
```

---

## 21. 键盘快捷键与命令系统

### 21.1 快捷键定义

**文件**: `packages/ui/src/lib/shortcuts/`

平台适配: macOS 使用 `meta` (Cmd)，其他平台使用 `ctrl`。

**输入快捷键** (`input.ts`):

| 快捷键 | 功能 |
|--------|------|
| `Cmd/Ctrl+K` | 清空输入 |
| `Cmd/Ctrl+P` | 聚焦输入框 / 打开命令面板 |

**导航快捷键** (`navigation.ts`):

| 快捷键 | 功能 |
|--------|------|
| `Cmd/Ctrl+[` | 上一个实例标签 |
| `Cmd/Ctrl+]` | 下一个实例标签 |
| `Cmd/Ctrl+Shift+[` | 上一个会话 |
| `Cmd/Ctrl+Shift+]` | 下一个会话 |
| `Cmd/Ctrl+Shift+L` | 切换到信息面板 |

**Agent 快捷键** (`agent.ts`):

| 快捷键 | 功能 |
|--------|------|
| `Cmd/Ctrl+Shift+M` | 聚焦模型选择器 |
| `Cmd/Ctrl+Shift+A` | 打开 Agent 选择器 |
| `Cmd/Ctrl+Shift+T` | 聚焦 Thinking 变体选择器 |

**Escape 快捷键** (`escape.ts`):

| 操作 | 行为 |
|------|------|
| 单击 Escape | 关闭模态框 或 取消输入聚焦 |
| 双击 Escape (1秒内, 会话繁忙中) | 中止当前运行的会话 |

### 21.2 命令系统

**文件**: `packages/ui/src/lib/hooks/use-commands.ts` (471行)

命令注册包含: `id`, `label`, `description`, `category`, `keywords` (模糊搜索), `shortcut`, `action`。

**核心命令**:

| 命令 | 快捷键 | 分类 |
|------|--------|------|
| `new-instance` | Cmd+N | Instance |
| `close-instance` | Cmd+W | Instance |
| `instance-next` | Cmd+] | Instance |
| `instance-prev` | Cmd+[ | Instance |
| `new-session` | Cmd+Shift+N | Session |
| `close-session` | Cmd+Shift+W | Session |
| `session-next` | Cmd+Shift+] | Session |
| `session-prev` | Cmd+Shift+[ | Session |
| `switch-to-info` | Cmd+Shift+L | Instance |
| `open-model-selector` | Cmd+Shift+M | Agent & Model |
| `open-variant-selector` | Cmd+Shift+T | Agent & Model |
| `open-agent-selector` | Cmd+Shift+A | Agent & Model |
| `clear-input` | Cmd+K | Input & Focus |
| `compact` | — | Session |
| `undo` | — | Session |
| `help` | — | System |

另有一组 **Behavior 命令** (`registerBehaviorCommands()`) 用于切换: thinking block 显示、快捷键提示、timeline 工具、用量指标等。

---

## 22. 其他说明

### 22.1 根级依赖解释

| 依赖 | 版本 | 说明 |
|------|------|------|
| `google-auth-library` | ^10.5.0 | **未在代码中使用**。可能为未来 Google Cloud 认证/制品仓库预留，或用于 CI/CD 发布脚本 |
| `7zip-bin` | ^5.2.0 | `electron-builder` 的传递依赖，用于 7z 归档打包。显式声明以解决 monorepo workspace 下的依赖解析问题 |
| `baseline-browser-mapping` | ^2.9.11 | DevDependency，用于 Vite 开发服务器与 Baseline 浏览器兼容性映射 |

### 22.2 `.opencode/` 配置

CodeNomad 使用 OpenCode 自身来开发，`.opencode/` 目录包含 Agent 和命令定义：

**Agent 定义** (`.opencode/agent/web_developer.md`):
- `web_developer` Agent — 专注于 SolidJS UI 组件开发
- `mode: all` — 在所有上下文中可用

**自定义命令** (`.opencode/commands/release-notes.md`):
- `/release-notes` 命令 — 对比上一个 tag 与当前分支，生成用户友好的发布说明
- 使用 `build` Agent

---

## 23. 关键文件索引

### Server (packages/server/src/)

| 功能 | 文件路径 | 行数 | 关键函数/类 |
|------|----------|------|-------------|
| **CLI 入口** | `index.ts` | 572 | `main()`, `parseCliOptions()` |
| **HTTP 服务器** | `server/http-server.ts` | 1193 | `createHttpServer()`, `proxyWorkspaceRequest()` |
| **TLS 管理** | `server/tls.ts` | 283 | TLS 证书解析/自动生成 |
| **网络地址** | `server/network-addresses.ts` | 128 | LAN IP 解析 |
| **工作空间管理** | `workspaces/manager.ts` | 488 | `WorkspaceManager.create()`, `delete()`, `shutdown()` |
| **进程运行时** | `workspaces/runtime.ts` | 487 | `WorkspaceRuntime.launch()`, `stop()` |
| **实例事件桥** | `workspaces/instance-events.ts` | 226 | `InstanceEventBridge.consumeStream()` |
| **Git Worktree** | `workspaces/git-worktrees.ts` | 241 | worktree 列表/创建 |
| **Worktree 映射** | `workspaces/worktree-map.ts` | 129 | 会话-worktree 映射 |
| **OpenCode 认证** | `workspaces/opencode-auth.ts` | 22 | Basic Auth 头生成 |
| **事件总线** | `events/bus.ts` | 49 | `EventBus.publish()`, `onEvent()` |
| **认证管理** | `auth/manager.ts` | 180 | `AuthManager`, `issueBootstrapToken()` |
| **认证存储** | `auth/auth-store.ts` | 175 | 持久化凭证 |
| **配置服务** | `settings/service.ts` | 128 | `SettingsService` (YAML) |
| **YAML 存储** | `settings/yaml-doc-store.ts` | 110 | 原子 YAML 读写 |
| **配置迁移** | `settings/migrate.ts` | 274 | JSON → YAML 迁移 |
| **二进制解析** | `settings/binaries.ts` | 55 | `BinaryResolver` |
| **配置 Schema** | `config/schema.ts` | 105 | Zod 校验 |
| **文件浏览** | `filesystem/browser.ts` | 361 | `FileSystemBrowser` |
| **文件搜索** | `filesystem/search.ts` | 184 | Fuzzy 搜索 |
| **客户端连接** | `clients/connection-manager.ts` | 128 | `ClientConnectionManager` |
| **插件通道** | `plugins/channel.ts` | 55 | `PluginChannelManager` |
| **语音模式** | `plugins/voice-mode.ts` | 96 | `VoiceModeManager` |
| **Sidecar 管理** | `sidecars/manager.ts` | 256 | `SideCarManager` |
| **语音服务** | `speech/service.ts` | 106 | `SpeechService` |
| **OpenAI 语音** | `speech/providers/openai-compatible.ts` | 234 | 流式 TTS/STT |
| **后台进程** | `background-processes/manager.ts` | 519 | `BackgroundProcessManager` |
| **实例存储** | `storage/instance-store.ts` | 64 | `InstanceStore` |
| **发布监控** | `releases/dev-release-monitor.ts` | 118 | GitHub Releases API |
| **UI 解析** | `ui/remote-ui.ts` | 571 | UI 包解析策略 |
| **共享类型** | `api-types.ts` | 410 | HTTP/SSE 类型契约 |
| **日志系统** | `logger.ts` | 133 | Pino 日志 |

### UI (packages/ui/src/)

| 功能 | 文件路径 | 行数 | 关键函数/类 |
|------|----------|------|-------------|
| **应用入口** | `main.tsx` | 66 | `bootstrap()` |
| **根组件** | `App.tsx` | 637 | `App` |
| **文件夹选择** | `components/folder-selection-view.tsx` | 1041 | `FolderSelectionView` |
| **实例外壳** | `components/instance/instance-shell2.tsx` | 952 | `InstanceShell2` |
| **右侧面板** | `components/instance/shell/right-panel/RightPanel.tsx` | 995 | `RightPanel` |
| **消息块** | `components/message-block.tsx` | 1615 | `MessageBlock` |
| **消息区域** | `components/message-section.tsx` | 1272 | `MessageSection` |
| **消息时间线** | `components/message-timeline.tsx` | 920 | `MessageTimeline` |
| **消息项** | `components/message-item.tsx` | 696 | `MessageItem` |
| **工具调用** | `components/tool-call.tsx` | 941 | `ToolCall` |
| **提示输入** | `components/prompt-input.tsx` | 773 | `PromptInput` |
| **命令面板** | `components/command-palette.tsx` | 322 | `CommandPalette` |
| **会话列表** | `components/session-list.tsx` | 798 | `SessionList` |
| **实例 Store** | `stores/instances.ts` | 1152 | `instances`, `createInstance()` |
| **偏好设置** | `stores/preferences.tsx` | 882 | `ConfigProvider`, `useConfig()` |
| **消息 Store** | `stores/message-v2/instance-store.ts` | 1241 | 每实例消息存储 |
| **会话 API** | `stores/session-api.ts` | 780 | 会话 CRUD 操作 |
| **会话状态** | `stores/session-state.ts` | 762 | `SessionInfo`, `SessionThread` |
| **会话事件** | `stores/session-events.ts` | 754 | SSE → Store 桥接 |
| **消息桥接** | `stores/message-v2/bridge.ts` | 311 | SSE → 消息 Store |
| **会话列表** | `stores/sessions.ts` | 141 | `sessions`, `activeSessionId` |
| **Worktree** | `stores/worktrees.ts` | 394 | `WorktreeMap` |
| **API 客户端** | `lib/api-client.ts` | 469 | `serverApi`, `connectEvents()` |
| **SSE 管理** | `lib/sse-manager.ts` | 231 | `SSEManager` |
| **SDK 管理** | `lib/sdk-manager.ts` | 64 | `SDKManager` |
| **运行时检测** | `lib/runtime-env.ts` | 86 | `getRuntime()`, `getPlatform()` |
| **i18n** | `lib/i18n/index.tsx` | 237 | `useI18n()`, `tGlobal()` |
| **主题** | `lib/theme.tsx` | 224 | `ThemeProvider` |
| **Markdown** | `lib/markdown.ts` | 380 | Shiki 渲染 |
| **存储** | `lib/storage.ts` | 261 | 设置持久化 |
| **原生功能** | `lib/native/native-functions.ts` | 37 | 平台分发 |

### Electron (packages/electron-app/electron/)

| 功能 | 文件路径 | 行数 | 关键函数/类 |
|------|----------|------|-------------|
| **主进程** | `main/main.ts` | 669 | `createWindow()`, `startCli()` |
| **进程管理** | `main/process-manager.ts` | 703 | `CliProcessManager` |
| **IPC** | `main/ipc.ts` | 160 | `setupCliIPC()` |
| **菜单** | `main/menu.ts` | 84 | macOS 菜单 |
| **权限** | `main/permissions.ts` | 58 | 媒体权限 |
| **存储** | `main/storage.ts` | 121 | 存储路径 |
| **Shell 解析** | `main/user-shell.ts` | 139 | 用户 Shell |
| **Preload** | `preload/index.cjs` | 29 | `contextBridge` |

### Tauri (packages/tauri-app/src-tauri/src/)

| 功能 | 文件路径 | 行数 | 关键函数/类 |
|------|----------|------|-------------|
| **应用入口** | `main.rs` | 722 | Tauri setup + IPC commands |
| **CLI 管理** | `cli_manager.rs` | 1194 | `CliProcessManager` (Rust) |

### OpenCode 插件 (packages/opencode-config/)

| 功能 | 文件路径 | 行数 | 关键函数/类 |
|------|----------|------|-------------|
| **插件入口** | `plugin/codenomad.ts` | 62 | `CodeNomadPlugin` |
| **客户端** | `plugin/lib/client.ts` | 133 | HTTP+SSE 客户端 |
| **请求辅助** | `plugin/lib/request.ts` | 214 | HTTP 请求封装 |
| **后台进程** | `plugin/lib/background-process.ts` | 253 | 工具定义 |

---

## 24. 超限文件告警

> 以下文件超出项目文件长度指南 (源文件 ~500 行警告, ~800 行限制)，建议在合适时机进行重构。

### 超出限制 (~800行)

| 文件 | 行数 | 超出 |
|------|------|------|
| `packages/ui/src/components/message-block.tsx` | 1615 | +815 |
| `packages/ui/src/stores/message-v2/instance-store.ts` | 1241 | +441 |
| `packages/ui/src/components/message-section.tsx` | 1272 | +472 |
| `packages/server/src/server/http-server.ts` | 1193 | +393 |
| `packages/tauri-app/src-tauri/src/cli_manager.rs` | 1194 | +394 |
| `packages/ui/src/stores/instances.ts` | 1152 | +352 |
| `packages/ui/src/components/folder-selection-view.tsx` | 1041 | +241 |
| `packages/ui/src/components/tool-call.tsx` | 941 | +141 |
| `packages/ui/src/components/instance/instance-shell2.tsx` | 952 | +152 |
| `packages/ui/src/components/message-timeline.tsx` | 920 | +120 |
| `packages/ui/src/stores/preferences.tsx` | 882 | +82 |

### 超出警告 (~500行)

| 文件 | 行数 | 类型 |
|------|------|------|
| `packages/ui/src/components/instance/shell/right-panel/RightPanel.tsx` | 995 | 组件 |
| `packages/ui/src/stores/session-api.ts` | 780 | Store |
| `packages/ui/src/components/prompt-input.tsx` | 773 | 组件 |
| `packages/ui/src/stores/session-state.ts` | 762 | Store |
| `packages/ui/src/stores/session-events.ts` | 754 | Store |
| `packages/ui/src/App.tsx` | 637 | 组件 |
| `packages/electron-app/electron/main/process-manager.ts` | 703 | 主进程 |
| `packages/electron-app/electron/main/main.ts` | 669 | 主进程 |
| `packages/tauri-app/src-tauri/src/main.rs` | 722 | Rust |
| `packages/server/src/ui/remote-ui.ts` | 571 | 工具 |

---

## 附录 A: 编译与运行

### A.1 克隆仓库
```bash
git clone https://github.com/NeuralNomadsAI/CodeNomad.git
cd CodeNomad
```

### A.2 安装依赖
```bash
npm install
```

### A.3 开发模式运行
```bash
# Electron 桌面应用 (推荐)
npm run dev

# 纯 Server 模式 (浏览器访问)
npm run dev --workspace @neuralnomads/codenomad
```

### A.4 构建桌面应用
```bash
npm run build              # Electron (当前平台)
npm run build:mac-x64      # macOS x64
npm run build:tauri         # Tauri
```

### A.5 类型检查
```bash
npm run typecheck
```

### A.6 依赖要求
- **Node.js 18+**
- **OpenCode CLI** (必须安装并添加到 PATH)

---

## 附录 B: 配置说明

### B.1 配置文件路径

| 文件 | 路径 | 说明 |
|------|------|------|
| 持久设置 | `~/.config/codenomad/config.yaml` | 全局配置 |
| 可变状态 | `~/.config/codenomad/state.yaml` | 运行时状态 |
| 认证数据 | `~/.config/codenomad/auth.json` | 哈希凭证 |
| OpenCode 配置 | `~/.config/codenomad/opencode-config/` | 插件模板 |

### B.2 环境变量

| 变量 | 说明 |
|------|------|
| `OPENCODE_CONFIG_DIR` | OpenCode 配置目录 |
| `CODENOMAD_INSTANCE_ID` | 工作空间实例 ID |
| `CODENOMAD_BASE_URL` | CodeNomad 服务器地址 |
| `OPENCODE_SERVER_USERNAME` | OpenCode 实例认证用户名 |
| `OPENCODE_SERVER_PASSWORD` | OpenCode 实例认证密码 |
| `NODE_EXTRA_CA_CERTS` | 可选 TLS CA 证书路径 |

### B.3 CLI 参数

| 参数 | 说明 |
|------|------|
| `--host` | 绑定地址 |
| `--https` | 启用 HTTPS (自动自签名) |
| `--http` | 强制 HTTP |
| `--workspace-root` | 工作空间根目录 |
| `--generate-token` | 生成引导令牌 |
| `--dangerously-skip-auth` | 跳过认证 |
| `--launch` | 启动后自动打开浏览器 |

---

## 附录 C: 版本与发布

### C.1 版本管理

当前版本: **v0.13.3** (定义于根 `package.json`)

通过 `npm run bumpVersion` 更新版本号。

### C.2 发布渠道

| 渠道 | NPM 包 | 说明 |
|------|--------|------|
| Stable | `@neuralnomads/codenomad` | 正式发布 |
| Dev | `@neuralnomads/codenomad-dev` | 开发频道 (dev 分支) |

### C.3 发布监控

- `releases/dev-release-monitor.ts` — 轮询 GitHub Releases API 检查开发频道更新
- `releases/release-monitor.ts` — 通用发布监控基础设施

---

*文档更新完毕 — 2026-04-09 (第二轮补充: 安全模型、错误处理、远程访问、数据模型、Bootstrap 握手、语音模式、UI 自动更新、开发模式、构建系统、快捷键系统)*
