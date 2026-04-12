# 文件操作与多类型预览器增强方案

> 文档版本: 1.5
> 创建日期: 2026-04-12
> 最后更新: 2026-04-12
> 状态: 已实施（Phase 0-6 + Bug Fixes #1-7 完成，编译通过）

---

## 1. 项目概述

本方案为 CodeNomad 右侧面板（文件浏览器）添加完整的文件操作能力（上传、下载、删除）和多类型文件预览支持（Markdown、图片、音频、视频、PDF），采用可扩展的预览器注册表架构。

---

## 2. 功能需求清单

| 功能 | 优先级 | 说明 |
|------|--------|------|
| **文件上传** | P0 | 支持任意文件类型，最大 100MB，支持冲突处理 |
| **文件下载** | P0 | 支持任意文件类型，最大 100MB，支持断点续传 |
| **文件删除** | P0 | 仅支持文件删除（禁止删除文件夹），带冲突检测 |
| **Markdown 预览** | P0 | 渲染模式与代码模式切换，支持内部路径解析 |
| **图片预览** | P1 | 支持缩放控制，Blob 内联显示 |
| **音频预览** | P1 | HTML5 audio 播放器 |
| **PDF 预览** | P1 | iframe 嵌入 + 下载按钮 |
| **视频预览** | P2 | HTML5 video 播放器（可选） |
| **进度条** | P0 | 上传/下载操作实时进度显示 |
| **操作按钮** | P0 | 下载/删除按钮直接显示在文件名右侧 |

---

## 3. 架构设计

### 3.1 核心设计决策：文件操作路径

#### 问题背景

CodeNomad 的文件系统访问存在两条路径：

| 路径 | 代码 | 上下文 | 目录解析 |
|------|------|--------|----------|
| **SDK Proxy** | `browserClient().file.list/read()` | OpenCode 实例 | worktree 目录（可能被覆盖） |
| **Server 路由** | `serverApi.readWorkspaceFile()` | CodeNomad Server | workspace 根目录 |

RightPanel 当前使用 SDK Proxy 浏览文件（`RightPanel.tsx:533,557`）。如果新增的上传/下载/删除操作走 Server 路由但不感知 worktree，在非 root worktree 场景下操作的目标目录会与用户浏览的目录不一致。

#### 解决方案：Server 路由 + worktree slug 参数

所有文件操作端点增加 `worktree` 查询参数，Server 端复用已有的 `resolveWorktreeDirectory()` 函数（`http-server.ts:795`）解析真实目录：

```
POST /api/workspaces/:id/files/upload?path=src/file.ts&worktree=root
DELETE /api/workspaces/:id/files/content?path=src/file.ts&worktree=feature-branch
GET  /api/workspaces/:id/files/download?path=img/logo.png&worktree=root
```

```
请求到达 Server
    │
    ▼
1. requireWorkspace(workspaceId)           → 获取 workspace 记录
    │
    ▼
2. resolveWorktreeDirectory({              → 解析 worktree 真实目录
     workspaceId,
     workspacePath: workspace.path,
     worktreeSlug: request.query.worktree ?? "root"
   })
   - slug="root" → repoRoot (非 git 则 fallback workspace.path)
   - slug="feature" → 通过 git worktree list 查到绝对路径
    │
    ▼
3. new FileSystemBrowser({ rootDir })      → Sandbox 防护自动生效
    │
    ▼
4. browser.deleteFile(relativePath)        → 执行操作
```

**前端调用**：前端已有 `worktreeSlugForViewer()` signal（`RightPanel.tsx:334`），直接透传即可。

#### 为什么不在 OpenCode SDK 层实现

OpenCode 目前不支持上传/下载/删除操作（无对应 API），且我们无法修改 OpenCode 源码。因此在 CodeNomad Server 层实现是最合理的选择。

#### 3.1.1 已有缺陷：文件读写不感知 worktree（Phase 0 需修复）

**问题发现**：经代码审查发现，现有的 `serverApi.writeWorkspaceFile()` 和 `serverApi.readWorkspaceFile()` 同样存在 worktree 不匹配问题。

| 操作 | 端点 | 问题 |
|------|------|------|
| **读取** `GET /files/content?path=...` | `RightPanel.tsx:557` 调用 `browserClient().file.read()` | ✅ 走 SDK proxy，已感知 worktree |
| **写入** `PUT /files/content?path=...` | `RightPanel.tsx:617` 调用 `serverApi.writeWorkspaceFile()` | ❌ 走 Server 路由，写入 workspace 根目录 |

**具体 bug**：

```
场景：用户在 worktree "feature-branch" 中编辑 src/app.ts 并保存

读取：browserClient().file.read("src/app.ts")
     → 代理到 /workspaces/:id/worktrees/feature-branch/instance/...
     → http-server.ts 解析 worktree 目录 → 读取正确位置 ✅

保存：serverApi.writeWorkspaceFile(id, "src/app.ts", content)
     → PUT /api/workspaces/:id/files/content?path=src/app.ts
     → workspaces.ts → WorkspaceManager.writeFile(id, path, content)
     → FileSystemBrowser({ rootDir: workspace.path }).writeFile(path, contents)
     → 写入 /workspace-root/src/app.ts ❌ （应该是 worktree 目录）

结果：用户保存的内容写到了错误的目录，下次读取看到的是旧内容
```

**影响**：在非 root worktree 场景下，保存功能会将内容写入 workspace 根目录而非当前 worktree 目录。

**解决方案**：与新端点一样，给 `GET/PUT /files/content` 端点也加上 `?worktree=` 参数。

### 3.2 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                        UI (SolidJS)                          │
│  ┌───────────────────────────────────────────────────────┐   │
│  │  RightPanel                                           │   │
│  │  ┌───────────────────┐  ┌──────────────────────────┐  │   │
│  │  │  FilesTab         │  │  File Viewer Dispatcher  │  │   │
│  │  │  - 文件列表       │  │  - 选择预览器             │  │   │
│  │  │  - 上传按钮       │  │  - 动态加载组件           │  │   │
│  │  │  - 操作按钮组     │  │  - 传递 props             │  │   │
│  │  │    (下载/删除)    │  └────────────┬─────────────┘  │   │
│  │  └────────┬──────────┘               │                │   │
│  └───────────┼──────────────────────────┼────────────────┘   │
│              │                          │                    │
│     ┌────────┴────────┐                 ▼                    │
│     │  文件操作调用    │  ┌───────────────────────────────┐   │
│     │                 │  │  Previewer Registry           │   │
│     │  浏览: SDK proxy│  │  ┌─────┐┌──────┐┌──────┐     │   │
│     │  (browserClient)│  │  │ MD  ││Image ││Audio │     │   │
│     │  上传/下载/删除  │  │  └─────┘└──────┘└──────┘     │   │
│     │  (serverApi +   │  │  ┌──────┐┌──────┐┌────────┐   │   │
│     │   worktree slug)│  │  │ PDF  ││Video ││ Monaco │   │   │
│     └────────┬────────┘  │  └──────┘└──────┘│(fallbk)│   │   │
│              │            │                  └────────┘   │   │
│              │            └───────────────────────────────┘   │
└──────────────┼──────────────────────────────────────────────┘
               │ HTTP API
┌──────────────┼──────────────────────────────────────────────┐
│              ▼           CodeNomad Server (Fastify)          │
│  ┌───────────────────────────────────────────────────────┐   │
│  │  文件操作路由 (registerWorkspaceRoutes)                │   │
│  │                                                       │   │
│  │  GET  /api/workspaces/:id/files           (已有)      │   │
│  │  GET  /api/workspaces/:id/files/content   (已有)      │   │
│  │  PUT  /api/workspaces/:id/files/content   (已有)      │   │
│  │  DELETE /api/workspaces/:id/files/content (新增)      │   │
│  │  GET  /api/workspaces/:id/files/download  (新增)      │   │
│  │  POST /api/workspaces/:id/files/upload    (新增)      │   │
│  │                                                       │   │
│  │  所有新增端点接受 ?worktree=<slug> 参数               │   │
│  └──────────────────────┬────────────────────────────────┘   │
│                         │                                    │
│                    resolveWorktreeDirectory()                │
│                    (已有函数, http-server.ts:795)            │
│                         │                                    │
│                    FileSystemBrowser                         │
│                    (Sandbox 防护)                            │
└─────────────────────────────────────────────────────────────┘
```

### 3.3 二进制文件读取问题

**现状**：`RightPanel.tsx:557-565` 中，`openBrowserFile()` 对二进制文件有**两个独立检查**：
1. `if (type && type !== "text")` → 抛出 "Binary file cannot be displayed"
2. `if (encoding === "base64")` → 抛出 "Binary file cannot be displayed"

**需要修改**：扩展 `openBrowserFile` 以支持二进制内容的获取和传递给预览器。对于二进制文件（图片/音频/PDF/视频），使用新增的 `downloadWorkspaceFile()` API 获取 Blob，而不是通过 SDK 的 `file.read()`。

```typescript
async function openBrowserFile(path: string) {
  // ... 现有逻辑 ...

  // 文本文件：继续走 SDK proxy
  if (isTextFile(path)) {
    const content = await browserClient().file.read({ path })
    // ... 现有处理 ...
    return
  }

  // 二进制文件：走 Server download API 获取 Blob
  const { blobUrl } = await serverApi.downloadWorkspaceFile(
    instanceId, path, undefined, { worktree: worktreeSlugForViewer() }
  )
  setBrowserSelectedContent(blobUrl)  // 存储 Blob URL
  setBrowserSelectedMimeType(inferMimeType(path))
}
```

### 3.4 预览器注册表模式

```typescript
interface FilePreviewer {
  id: string
  canHandle: (path: string, mimeType?: string) => boolean
  priority: number
  component: Component<FilePreviewerProps>
}

interface FilePreviewerProps {
  path: string
  content: string                    // 文本内容 (Monaco / Markdown)
  blobUrl?: string                   // Blob URL (图片/音频/PDF/视频)
  mimeType?: string
  scopeKey: string
  isDark?: boolean
  onNavigate?: (path: string) => void
  onSave?: (content: string) => void
  onContentChange?: (content: string) => void
}

const filePreviewers: FilePreviewer[] = [
  { id: 'markdown', canHandle: isMarkdown, priority: 100, component: MarkdownViewer },
  { id: 'image', canHandle: isImage, priority: 90, component: ImageViewer },
  { id: 'audio', canHandle: isAudio, priority: 80, component: AudioViewer },
  { id: 'video', canHandle: isVideo, priority: 70, component: VideoViewer },
  { id: 'pdf', canHandle: isPDF, priority: 60, component: PDFViewer },
  { id: 'monaco', canHandle: () => true, priority: 0, component: MonacoFileViewer },
]
```

> **文件类型检测函数**：`isMarkdown`、`isImage`、`isAudio`、`isVideo`、`isPDF`、`inferMimeType` 等工具函数放置在 `packages/ui/src/lib/file-types.ts` 中，基于文件扩展名判断。`registry.ts` 导入这些函数用于 `canHandle` 回调。

---

## 4. 后端 API 设计

### 4.1 API 端点总览

| 端点 | 方法 | 用途 | 状态 |
|------|------|------|------|
| `/api/workspaces/:id/files` | GET | 列出文件 | 已有 |
| `/api/workspaces/:id/files/content` | GET | 读取文件（文本） | 已有，需补丁 |
| `/api/workspaces/:id/files/content` | PUT | 写入文件（文本） | 已有，需补丁 |
| `/api/workspaces/:id/files/content` | DELETE | 删除文件 | **新增** |
| `/api/workspaces/:id/files/download` | GET | 下载文件（任意类型） | **新增** |
| `/api/workspaces/:id/files/upload` | POST | 上传文件 | **新增** |

**所有端点**（含已有 GET/PUT）均需支持 `?worktree=<slug>` 查询参数（默认 `"root"`）。

### 4.2 Worktree 目录解析（已有基础设施）

Server 端已有 `resolveWorktreeDirectory()` 函数（`http-server.ts:795-812`）：

```typescript
async function resolveWorktreeDirectory(params: {
  workspaceId: string
  workspacePath: string
  worktreeSlug: string
  logger: Logger
}): Promise<string | null>
```

- `slug="root"` → 返回 `repoRoot`（非 git 仓库则 fallback `workspace.path`）
- 其他 slug → 通过 `listWorktrees()` 查到对应目录的绝对路径
- 使用缓存 + 按需刷新策略

**WorkspaceManager 新增方法**：

```typescript
async resolveWorktreeDirectory(workspaceId: string, worktreeSlug: string): Promise<string> {
  const workspace = this.requireWorkspace(workspaceId)
  const directory = await resolveWorktreeDirectory({
    workspaceId,
    workspacePath: workspace.path,
    worktreeSlug,
    logger: this.options.logger,
  })
  if (!directory) {
    throw new Error(`Worktree "${worktreeSlug}" not found`)
  }
  return directory
}
```

> 注意：推荐将 `resolveWorktreeDirectory()` 迁移到 `workspaces/git-worktrees.ts`（与 `listWorktrees`、`resolveRepoRoot` 同模块），然后 `http-server.ts` 和 `WorkspaceManager` 均从该模块导入。`getCachedWorktrees` 和 `worktreeCache` 也需一并迁移或提供公共访问器。

### 4.3 下载端点（支持断点续传）

**端点**: `GET /api/workspaces/:id/files/download`

**Query 参数**:
- `path`: 文件相对路径
- `worktree`: worktree slug（默认 `"root"`）

**响应头**:
```
Content-Disposition: attachment; filename="example.pdf"
Content-Type: application/pdf
Accept-Ranges: bytes
ETag: "<mtime>-<size>"
Content-Length: <size>
```

**Range 请求支持**:
```
请求头: Range: bytes=0-1023
响应头: Content-Range: bytes 0-1023/10000
响应码: 206 Partial Content
```

**错误码**:
- `403`: 路径穿越尝试
- `404`: 文件不存在 / worktree 不存在
- `413`: 文件超过 100MB 限制

**实现要点**:
- 使用 `FileSystemBrowser` 构造时传入 `resolveWorktreeDirectory()` 返回的真实目录
- `toRestrictedAbsolute()` 提供 Sandbox 防护，防止路径穿越
- `fs.createReadStream({ start, end })` 实现 Range 请求
- 需在 `http-server.ts` 中导入并注册 `@fastify/multipart` 插件：
  ```typescript
  import multipart from '@fastify/multipart'
  app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } })
  ```

### 4.4 上传端点

**端点**: `POST /api/workspaces/:id/files/upload`

**请求头**:
- `Content-Type: multipart/form-data`
- `X-Overwrite: true` (可选，覆盖已存在文件)

**Query 参数**:
- `path`: 目标相对路径（含文件名）
- `worktree`: worktree slug（默认 `"root"`）

**请求体**:
- `file`: 文件二进制数据

**冲突处理**:
- 文件已存在且未设置 `X-Overwrite`: 返回 `409 Conflict`
- 前端根据 `409` 状态码显示覆盖确认对话框

**错误码**:
- `400`: 未提供文件
- `403`: 路径穿越尝试
- `409`: 文件冲突（需确认覆盖）
- `413`: 文件超过 100MB 限制

**实现要点**:
- 需要 `@fastify/multipart` 插件
- 流式写入：`file.file.pipe(fs.createWriteStream(resolvedPath))`
- 路径通过 `FileSystemBrowser.toRestrictedAbsolute()` 验证

### 4.5 删除端点

**端点**: `DELETE /api/workspaces/:id/files/content`

**Query 参数**:
- `path`: 文件相对路径
- `worktree`: worktree slug（默认 `"root"`）

**限制**:
- 禁止删除文件夹（返回 `400`）
- 必须通过 Sandbox 检查

**错误码**:
- `400`: 尝试删除文件夹
- `403`: 路径穿越尝试
- `404`: 文件不存在

---

## 5. 前端 API Client 设计

### 5.1 通用参数

所有新增方法均接受 `options?: { worktree?: string }` 参数，默认 `"root"`。

### 5.2 上传方法

```typescript
uploadWorkspaceFile(
  id: string,
  targetPath: string,
  file: File,
  onProgress?: (loaded: number, total: number) => void,
  options?: { worktree?: string; overwrite?: boolean },
): Promise<{ path: string; size: number; abort: () => void }>
```

**实现细节**:
- 使用 `XMLHttpRequest` 以支持上传进度
- `FormData` 封装文件
- `X-Overwrite` 头根据 `options.overwrite` 设置
- 捕获 `409` 状态码用于冲突处理
- 返回 `abort` 方法供调用方取消上传（调用 `xhr.abort()`）

### 5.3 下载方法

```typescript
downloadWorkspaceFile(
  id: string,
  relativePath: string,
  onProgress?: (loaded: number, total: number) => void,
  options?: { worktree?: string },
): Promise<{ blobUrl: string; fileName: string; abort: () => void }>
```

**实现细节**:
- 使用 `XMLHttpRequest` 以支持下载进度
- `responseType: "blob"` 接收二进制
- 创建 `Blob URL` 用于预览或触发浏览器下载
- 支持 `Range` 请求（浏览器自动处理）
- 返回 `abort` 方法供调用方取消下载（调用 `xhr.abort()`）
- 进度条组件的 `onCancel` 回调调用此 `abort` 方法

### 5.4 删除方法

```typescript
deleteWorkspaceFile(
  id: string,
  relativePath: string,
  options?: { worktree?: string },
): Promise<void>
```

**实现细节**:
- 标准 `fetch` 请求
- 捕获 `400` 状态码用于文件夹删除错误

---

## 6. UI 组件设计

### 6.1 FilesTab 文件列表项

```
桌面端 (固定操作列，始终可见):
┌─────────────────────────────────────────────────┐
│ 📁 src/                                         │
│ 📄 README.md                     [⬇] [🗑]      │
│ 📄 package.json                  [⬇] [🗑]      │
│ 📁 node_modules/                                │
└─────────────────────────────────────────────────┘

移动端 (始终可见，与桌面端相同):
┌─────────────────────────────────────────────────┐
│ 📁 src/                                         │
│ 📄 README.md                     [⬇] [🗑]      │
│ 📄 package.json                  [⬇] [🗑]      │
└─────────────────────────────────────────────────┘

Header 行:
┌─────────────────────────────────────────────────┐
│ [Toggle] [📤] [Stats/path] [👁] [</>] [Save] [🔄] │
└─────────────────────────────────────────────────┘
```

> [👁] 和 [</>] 为 Markdown 视图切换按钮，仅在选择 .md 文件时显示。
> [📤] = Upload, [👁] = Rendered, [</>] = Code, [Save], [🔄] = Refresh

**HTML 结构**（文件列表项更新后）:

```tsx
<div class="file-list-item">
  <div class="file-list-item-content">
    <div class="file-list-item-path" title={item.path}>
      <span class="file-path-text">{item.name}</span>
    </div>
    <div class="file-list-item-stats">
      <span class="text-[10px] text-secondary">{item.type}</span>
    </div>
  </div>
  <div class="file-list-item-actions">
    <button class="file-action-btn" title={t("download")} onClick={handleDownload}>⬇</button>
    <button class="file-action-btn delete" title={t("delete")} onClick={handleDelete}>🗑</button>
  </div>
</div>
```

**CSS 策略**:
```css
/* .file-list-item 使用 flex 布局使内容和操作列同行排列 */
.file-list-item {
  display: flex;
  align-items: center;
}

.file-list-item-content {
  flex: 1;
  min-width: 0;
}

/* 操作列固定宽度，始终显示（不悬停） */
.file-list-item-actions {
  display: flex;
  flex-shrink: 0;
  width: 48px;
  align-items: center;
  justify-content: center;
}

.file-action-btn {
  width: 22px;
  height: 22px;
}
```

**宽度约束**:
- 列表最小宽度 200px
- 操作列固定 48px，内含两个 22x22px 按钮
- 文件名区域：200px - 48px - padding ≈ 116px 可用
- ".." 父级行也有空占位 `<div class="file-list-item-actions" />` 保持对齐

**交互逻辑**:
- 桌面端/移动端：操作按钮始终显示（不再使用悬停逻辑）
- 点击文件名 → 打开预览
- 点击操作按钮 → 执行对应操作
- 删除操作：始终显示确认对话框（有未保存更改时 variant="warning"，否则 variant="info"）
- 所有文件操作传递 `worktreeSlugForViewer()` 作为 worktree 参数
- 上传按钮放在 Header 行（Stats 之后），使用 `Upload` 图标
- **上传按钮定位修复**：`<button>` 需添加 `upload-button` class（position: relative），`<input type="file">` 使用 `upload-file-input` class（position: absolute），防止 input 覆盖整个页面
- **Header 按钮顺序**：Upload → Stats/path → Eye(仅.md) → Code(仅.md) → Save → Refresh
- **Header sticky**：`position: sticky; top: 0; z-index: 10; background: var(--surface-secondary)` 使 Header 在滚动时固定

### 6.2 进度条组件

**放置位置**: `files-tab-header` 和 `files-tab-body` 之间。在 `SplitFilePanel.tsx` 的 `files-tab-header` 组件之后、`files-tab-body` 之前插入进度条。在 split view 模式下，进度条横跨整个 split 区域上方；在 overlay 模式下，进度条在 overlay 内部列表上方。

```
┌─────────────────────────────────────────────────┐
│ [Toggle] [📤] [Stats/path] [👁] [</>] [Save] [🔄]│ ← header (已有)
├─────────────────────────────────────────────────┤
│ ████████████████░░░░░░░░░░ 67%  Cancel    [✕]  │ ← 进度条 (新增)
├─────────────────────────────────────────────────┤
│ 桌面端: split view                              │
│ ┌─────────────┬────┬──────────────────────────┐│
│ │ file list   │    │ viewer                   ││
│ └─────────────┴────┴──────────────────────────┘│
└─────────────────────────────────────────────────┘
```

**组件接口**:
```typescript
interface ProgressBarProps {
  progress: number      // 0-100
  label?: string        // 可选标签，如 "Uploading..."
  onCancel?: () => void // 取消回调，中断 XHR 请求
  showClose?: boolean   // 是否显示关闭按钮（操作完成/取消后）
  onClose?: () => void  // 关闭进度条（清除状态）
}
```

**样式**:
- 复用 `files-header-icon-button` 基础样式
- 进度条颜色：`--accent-primary`
- 背景色：`--surface-secondary`
- 高度：4px
- 取消按钮：`w-7 h-7` 圆形，带 `x` 图标

**使用场景**:
- 上传文件时显示上传进度
- 下载文件时显示下载进度
- 操作完成后自动隐藏（带淡入淡出动画）
- 支持取消操作（`xhr.abort()`）

**优先级**: 当有多个操作同时进行时，显示最近的操作进度

### 6.3 Markdown 预览器

```
┌─────────────────────────────────────────────┐
│  # 标题                                     │  ← 视图切换已移至 Header
│  正文内容...                                │
│  [链接](./other.md) → 点击导航到其他文件     │
│  ![图片](./img.png) → 内联显示              │
│                                             │
│  ```typescript                             │
│  const x = 1  // 语法高亮                  │
│  ```                                        │
│                                             │
└─────────────────────────────────────────────┘
```

> Markdown 视图切换按钮（👁 / </>）已移至 Header 行，仅在选择 .md 文件时显示。Viewer 内部不渲染切换控件，接受 `initialViewMode` prop 以响应 Header 按钮状态变化。

**特性**:
- 自动检测 `.md` / `.markdown` 文件
- 渲染模式：调用 `renderMarkdown()` 函数（来自 `lib/markdown.ts`）生成 HTML，**不复用现有的 `<Markdown>` 组件**（该组件深度耦合 `TextPart` 数据模型和 session 缓存体系，无法直接用于文件浏览器）
- 代码模式：Monaco 编辑器，支持编辑保存
- 内部链接解析：点击 `./other.md` 导航到其他文件
- 图片内联：通过 download API 获取 Blob URL 显示
- 自建轻量缓存：以文件路径 + 内容 hash 为 key，避免每次渲染重新解析
- 订阅 `onLanguagesLoaded()`：当 Shiki 异步加载完代码块语言后触发重新高亮

### 6.4 图片预览器

```
┌─────────────────────────────────────────────┐
│ [-] [100%] [+] [⛶]                        │  ← 缩放控制
├─────────────────────────────────────────────┤
│                                             │
│           <img src={blobUrl} />              │
│                                             │
└─────────────────────────────────────────────┘
```

**特性**:
- 缩放控制：25% - 400%，步进 25%
- 适应屏幕按钮
- 使用 Blob URL（通过 download API 获取），`onCleanup` 撤销

### 6.5 音频预览器

```
┌─────────────────────────────────────────────┐
│                  🎵                          │
│              audio-file.mp3                  │
├─────────────────────────────────────────────┤
│ [▶] ────────────────●──────────── 2:30/4:00 │
└─────────────────────────────────────────────┘
```

**特性**:
- HTML5 `<audio>` 元素，`src` 为 Blob URL
- 文件名显示
- 标准播放控制

### 6.6 PDF 预览器

```
┌─────────────────────────────────────────────┐
│ [⬇ 下载 PDF]                               │  ← 下载按钮
├─────────────────────────────────────────────┤
│                                             │
│  ┌─────────────────────────────────────┐   │
│  │         iframe (PDF 预览)            │   │
│  └─────────────────────────────────────┘   │
│                                             │
└─────────────────────────────────────────────┘
```

**特性**:
- iframe 嵌入 PDF，`src` 为 Blob URL
- 下载按钮（触发浏览器下载）
- **Electron 兼容性注意**：需验证 Electron `webSecurity` 是否允许 `blob:` 在 iframe 中加载。如不支持，降级为直接下载。

### 6.7 视频预览器（可选）

```
┌─────────────────────────────────────────────┐
│              <video src={blobUrl} controls />│
└─────────────────────────────────────────────┘
```

**特性**:
- HTML5 `<video>` 元素，`src` 为 Blob URL
- 标准播放控制

### 6.8 移动端适配

#### 6.8.1 文件列表 overlay

手机端文件列表为全屏 overlay（`z-index: 200`），当前无独立 header。需要在 overlay 内添加工具栏行：

```
┌──────────────────────────────┐
│ ← 返回        README.md     │  ← overlay 主 header (已有)
├──────────────────────────────┤
│ [📤] [Stats] [👁] [</>] [🔄]│  ← 工具栏行 (新增)
├──────────────────────────────┤
│ 📁 src/                     │
│ 📄 package.json   [⬇] [🗑] │  ← 操作按钮始终可见
└──────────────────────────────┘
```

**说明**：
- Markdown 视图切换按钮（👁/</>）在选中 .md 文件时出现在工具栏行
- 操作按钮在移动端始终显示（不使用悬停逻辑）

#### 6.8.2 响应式断点

| 布局 | 断点 | 行为 |
|------|------|------|
| 桌面端 | `> 640px` | Split panel，操作按钮始终显示（固定 48px 列） |
| 手机端 | `≤ 640px` | Full-screen overlay，操作按钮始终显示 |
| 窄面板 | `列表宽度 ≤ 200px` | 操作列固定 48px，文件名区域仍可显示 |

#### 6.8.3 手势交互（可选增强）

- 图片预览器：支持双指缩放（`touch` 事件监听 pinch/zoom）
- 音频/视频：原生控件已支持触屏

---

## 7. 文件结构

### 7.1 新增文件

```
packages/ui/src/components/file-viewer/
├── types.ts                    # FilePreviewer 类型定义
├── registry.ts                 # 预览器注册表 + 选择逻辑
├── progress-bar.tsx            # 上传/下载进度条组件
├── markdown-viewer.tsx         # Markdown 预览器 (视图切换)
├── image-viewer.tsx            # 图片预览器
├── audio-viewer.tsx            # 音频预览器
├── video-viewer.tsx            # 视频预览器 (可选)
└── pdf-viewer.tsx              # PDF 预览器

packages/ui/src/styles/panels/
└── file-viewers.css            # 新增：预览器专用样式 + 操作按钮 + 进度条
```

### 7.2 修改文件

| 文件 | 修改内容 |
|------|----------|
| `packages/server/src/filesystem/browser.ts` | 新增 `deleteFile()` |
| `packages/server/src/workspaces/manager.ts` | 新增 `resolveWorktreeDirectory()` + `uploadFile()` + `deleteFile()`，修改 `readFile/writeFile` 增加 worktree 参数 |
| `packages/server/src/server/routes/workspaces.ts` | 补丁已有 GET/PUT 路由支持 worktree 参数 + 新增 DELETE/upload/download 路由 |
| `packages/server/src/server/http-server.ts` | 移除私有的 `resolveWorktreeDirectory()`（已迁移到 git-worktrees.ts） |
| `packages/server/src/workspaces/git-worktrees.ts` | 新增导出 `resolveWorktreeDirectory()` + `getCachedWorktrees()` + `worktreeCache` |
| `packages/ui/src/lib/api-client.ts` | 补丁 `readWorkspaceFile/writeWorkspaceFile` 支持 worktree + 新增 `uploadWorkspaceFile/downloadWorkspaceFile/deleteWorkspaceFile` |
| `packages/ui/src/components/instance/shell/right-panel/RightPanel.tsx` | 修改 `openBrowserFile` 支持二进制 + 修改 `saveBrowserFile` 传递 worktree slug + 新增删除冲突检测 + Markdown blob URL 清理 + tab 切换内容重加载 |
| `packages/ui/src/components/instance/shell/right-panel/tabs/FilesTab.tsx` | 集成预览器选择、操作按钮（固定列）、上传/下载/删除逻辑 + 上传按钮定位修复 + Header Markdown toggle 图标 |
| `packages/ui/src/components/instance/shell/right-panel/hooks/useFileOperations.ts` | **新建** 文件操作 hook（上传/下载/删除），始终显示删除确认 |
| `packages/ui/src/components/instance/shell/right-panel/components/SplitFilePanel.tsx` | viewer 外层包裹 `file-viewer-cell` 以约束高度 |
| `packages/ui/src/components/file-viewer/markdown-viewer.tsx` | **新建** Markdown 预览器（缓存、图片内联、内部链接导航），接受 `initialViewMode` prop |
| `packages/ui/src/lib/i18n/messages/*/instance.ts` | 7 种语言同步新增 instance 相关字符串 |
| `packages/ui/src/lib/i18n/messages/*/fileViewer.ts` | **新建** 7 种语言 fileViewer 字符串（含删除确认） |
| `packages/ui/src/styles/panels/right-panel.css` | 新增 `upload-button`、`upload-file-input`、`.files-tab-stats` max-width 样式 + 操作列 flex 布局 + sticky header + file-viewer-cell |
| `packages/ui/src/styles/panels/file-viewers.css` | 操作按钮固定列样式（48px 宽、22x22px 按钮） |

---

## 8. 安全设计

### 8.1 Sandbox 防护

所有文件操作通过 `FileSystemBrowser` 构造，其 `toRestrictedAbsolute()` 方法（`browser.ts:292-300`）已提供路径穿越防护：

```typescript
private toRestrictedAbsolute(relativePath: string) {
  const normalized = this.normalizeRelativePath(relativePath)
  const target = path.resolve(this.root, normalized)
  const relativeToRoot = path.relative(this.root, target)
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot) && relativeToRoot !== "") {
    throw new Error("Access outside of root is not allowed")
  }
  return target
}
```

**防护范围**:
- 上传文件路径验证
- 下载文件路径验证
- 删除文件路径验证

**关键点**：`FileSystemBrowser` 的 `rootDir` 来自 `resolveWorktreeDirectory()` 返回的真实目录，因此 sandbox 边界与用户浏览的 worktree 目录一致。

### 8.2 文件大小限制

| 操作 | 限制 | 错误码 |
|------|------|--------|
| 上传 | 100MB | `413` |
| 下载 | 100MB | `413` |

**Fastify bodyLimit**：需在注册路由前设置 `app.register(require('@fastify/multipart'), { limits: { fileSize: 100 * 1024 * 1024 } })`。

### 8.3 文件夹删除限制

```typescript
const stats = fs.statSync(resolvedPath)
if (stats.isDirectory()) {
  reply.code(400)
  return { error: "Folder deletion is not supported" }
}
```

### 8.4 worktree slug 验证

复用已有的 `isValidWorktreeSlug()`（`git-worktrees.ts:144`）验证 slug 格式，防止注入攻击。

---

## 9. 冲突处理

### 9.1 上传冲突

**场景**: 用户尝试上传已存在的文件

**流程**:
```
1. 前端调用 uploadWorkspaceFile()
2. Server 检测到文件存在 → 返回 409
3. 前端显示覆盖确认对话框
4. 用户确认 → 带 X-Overwrite: true 重试
5. 用户取消 → 放弃上传
```

### 9.2 删除冲突

**场景**: 用户尝试删除正在编辑的文件（有未保存更改）

**流程**:
```
1. 检查 browserSelectedPath === targetPath && browserSelectedDirty
2. 如果是 → 显示冲突确认对话框
3. 用户确认 → 清除 dirty 状态 → 执行删除
4. 用户取消 → 放弃删除
```

### 9.3 保存冲突检测（Phase 0 需补充 worktree 感知）

RightPanel 已有保存冲突检测（`RightPanel.tsx:579-613`），比较磁盘当前内容与原始加载内容，检测 agent 是否在用户编辑时修改了文件。

**Phase 0 补丁**：现有代码调用 `serverApi.writeWorkspaceFile(props.instanceId, path, content)` 时需传递 worktree 参数（`worktreeSlugForViewer()`），使保存操作写入正确的 worktree 目录。

---

## 10. i18n 国际化字符串

### 10.1 实例相关字符串 (en/instance.ts)

```typescript
{
  "instanceShell.rightPanel.actions.upload": "Upload File",
  "instanceShell.rightPanel.actions.download": "Download",
  "instanceShell.rightPanel.actions.delete": "Delete",
  "instanceShell.rightPanel.actions.uploadSuccess": "File uploaded successfully",
  "instanceShell.rightPanel.actions.uploadFailed": "Failed to upload file",
  "instanceShell.rightPanel.actions.downloadFailed": "Failed to download file",
  "instanceShell.rightPanel.actions.deleteSuccess": "File deleted successfully",
  "instanceShell.rightPanel.actions.deleteFailed": "Failed to delete file",
  "instanceShell.rightPanel.actions.deleteConflict.message": "This file has unsaved changes. Deleting will discard them. Continue?",
  "instanceShell.rightPanel.actions.deleteConflict.confirmLabel": "Delete anyway",
  "instanceShell.rightPanel.actions.deleteFolderNotAllowed": "Folder deletion is not supported",
  "instanceShell.rightPanel.actions.uploadConflict.message": "File already exists. Overwrite?",
  "instanceShell.rightPanel.actions.uploadConflict.confirmLabel": "Overwrite",
}
```

**注意**：删除确认相关字符串（`fileViewer.delete.*`）已移至 `fileViewer.ts` part 文件中，见 §10.2。

### 10.2 文件预览器字符串 (en/fileViewer.ts) — 新建 part 文件

```typescript
{
  "fileViewer.markdown.rendered": "Rendered",
  "fileViewer.markdown.code": "Code",
  "fileViewer.image.zoomIn": "Zoom In",
  "fileViewer.image.zoomOut": "Zoom Out",
  "fileViewer.image.fit": "Fit to Screen",
  "fileViewer.delete.confirm.message": "Delete \"{path}\"?",
  "fileViewer.delete.confirm.label": "Delete",
  "fileViewer.delete.cancel.label": "Cancel",
  "fileViewer.delete.dirty.message": "This file has unsaved changes. Deleting will discard them. Continue?",
}
```

### 10.3 其他语言

每个 locale 目录需新建 `fileViewer.ts` part 文件（`zh-Hans/`, `es/`, `fr/`, `ru/`, `ja/`, `he/`），并在对应 locale 的 `index.ts` 中注册。

---

## 10A. Bug 修复记录

### Bug #1: 上传按钮 `<input type="file">` 穿透覆盖整个页面 (CRITICAL)

**根因**：`FilesTab.tsx` 中上传按钮的 `<input type="file" class="absolute inset-0">` 没有父级 `position: relative`，导致 input 相对于 viewport 定位，覆盖整个页面。

**修复**：
- 按钮添加 `upload-button` class（触发 `position: relative`）
- input 使用专用 `upload-file-input` class
- 上传后重置 `input.value = ""`，允许重复选择同一文件

**文件**：`FilesTab.tsx`、`right-panel.css`

### Bug #2: 删除文件无确认对话框 (HIGH)

**根因**：`useFileOperations.ts` 中 `deleteFile` 只在 `hasDirtyState` 为 true 时才弹确认框。

**修复**：
- 始终显示确认对话框
- 有未保存更改：variant="warning"，提示会丢失更改
- 无未保存更改：variant="info"，仅确认删除

**文件**：`useFileOperations.ts`、`fileViewer.ts`（7 种语言）

### Bug #3: Header 路径过长时挤压按钮 (MEDIUM)

**根因**：`.files-tab-selected-path` 有 `flex-1`，会占满所有剩余空间，长路径导致布局问题。

**修复**：
- `.files-tab-stats` 添加 `max-width: 60%` + `min-width: 0`
- `.files-tab-selected-path` 添加 `max-width: 100%`

**文件**：`right-panel.css`

### Bug #4: Markdown 图片 Blob URL 不清理 (LOW)

**根因**：切换 Markdown 文件时，旧文件中内联图片的 Blob URL 未被 revoke，导致内存泄漏。

**修复**：
- 在 `openBrowserFile` 中清理旧的 markdown image blob URLs
- 在 `onCleanup` 中清理所有 blob URLs

**文件**：`RightPanel.tsx`、`markdown-viewer.tsx`

### Bug #5: 操作列与文件名不在同一行 (HIGH)

**根因**：`.file-list-item` 缺少 `display: flex`，导致内容 div 和操作 div 垂直堆叠而非水平排列。

**修复**：
- `.file-list-item` 添加 `@apply flex items-center`
- `.file-list-item-content` 添加 `flex-1 min-w-0` 确保内容区域占满剩余空间

**文件**：`right-panel.css`

### Bug #6: 切换标签页后再返回文件列表时内容丢失 (MEDIUM)

**根因**：离开 files tab 时 `browserSelectedContent` 被清空，但 `browserSelectedPath` 保留。返回时 UI 显示选中文件但无内容（"no file selected"）。

**修复**：
- 添加新 effect：当 tab 回到 "files" 且 `browserSelectedPath` 存在但 `browserSelectedContent` 为空时，自动重新获取文件内容

**文件**：`RightPanel.tsx`

### Bug #7: Markdown 预览模式下文件列表滚动条丢失 (MEDIUM)

**根因**：Markdown viewer 的内容区域（`.markdown-viewer-content`）使用 `overflow-auto` 但不约束高度，当内容很高时 CSS grid 单元格被撑大，导致左侧文件列表面板的滚动条被推出可视区域。Monaco viewer 不受影响因为其内部 JS 控制尺寸（`width: 100%; height: 100%`）。

**修复**：
- `.files-split` 添加 `overflow: hidden` 防止 grid 溢出
- 新增 `.file-viewer-cell` 包裹 viewer：`min-height: 0; overflow: hidden`
- 迫使所有 viewer 的内部滚动容器（如 `.markdown-viewer-content`）自行处理 overflow

**文件**：`SplitFilePanel.tsx`、`right-panel.css`

---

## 11. 实施步骤

### Phase 0: 修复已有 worktree bug（必须先执行）

| 步骤 | 内容 | 依赖 |
|------|------|------|
| 0.1 | 将 `resolveWorktreeDirectory()` 迁移到 `workspaces/git-worktrees.ts`（与 `listWorktrees`、`resolveRepoRoot` 同模块） | - |
| 0.2 | `WorkspaceManager.readFile/writeFile` 增加 `worktree` 参数 | 0.1 |
| 0.3 | `GET/PUT /files/content` 路由补充 `?worktree=` 参数 | 0.2 |
| 0.4 | `api-client.readWorkspaceFile/writeWorkspaceFile` 增加 `worktree` 参数 | 0.3 |
| 0.5 | `RightPanel.tsx` 的 saveBrowserFile 调用传递 `worktreeSlugForViewer()` | 0.4 |
| 0.6 | 验证非 root worktree 下保存功能正确 | 0.5 |

### Phase 1: 后端 API (Server)

| 步骤 | 内容 | 依赖 |
|------|------|------|
| 1.1 | 安装 `@fastify/multipart` | - |
| 1.2 | 提取 `resolveWorktreeDirectory()` 为可导出函数 | - |
| 1.3 | `FileSystemBrowser.deleteFile()` | - |
| 1.4 | `WorkspaceManager.resolveWorktreeDirectory()` + `uploadFile()` + `deleteFile()` | 1.2, 1.3 |
| 1.5 | `POST /files/upload` 路由（含 worktree 参数） | 1.4 |
| 1.6 | `DELETE /files/content` 路由（含 worktree 参数） | 1.4 |
| 1.7 | `GET /files/download` 路由 (含 worktree 参数 + Range 支持) | 1.4 |
| 1.8 | 单元测试 + Sandbox 防护验证 | 1.5-1.7 |

### Phase 2: 前端 API Client

| 步骤 | 内容 | 依赖 |
|------|------|------|
| 2.1 | `uploadWorkspaceFile()` - XHR with progress + worktree | Phase 1 |
| 2.2 | `downloadWorkspaceFile()` - XHR with progress + worktree | Phase 1 |
| 2.3 | `deleteWorkspaceFile()` + worktree | Phase 1 |

### Phase 3: 预览器架构

| 步骤 | 内容 | 依赖 |
|------|------|------|
| 3.1 | `types.ts` + `registry.ts` | - |
| 3.2 | `markdown-viewer.tsx` (视图切换 + 路径解析) | 3.1 |
| 3.3 | `image-viewer.tsx` | 3.1 |
| 3.4 | `audio-viewer.tsx` | 3.1 |
| 3.5 | `pdf-viewer.tsx` | 3.1 |
| 3.6 | `video-viewer.tsx` (可选) | 3.1 |
| 3.7 | `progress-bar.tsx` | - |

### Phase 4: RightPanel + FilesTab 集成

| 步骤 | 内容 | 依赖 |
|------|------|------|
| 4.0 | 重构 `RightPanel.tsx`：提取 `useBrowserFileOperations` hook + `useFileActions` hook | - |
| 4.1 | 修改 `openBrowserFile` 支持二进制文件 | Phase 2 |
| 4.2 | 顶部工具栏：上传按钮（传递 worktree slug） | Phase 2, 3 |
| 4.3 | 文件列表项：右侧操作按钮组（传递 worktree slug） | Phase 2, 3 |
| 4.4 | 预览器选择逻辑 (registry.select) | Phase 3 |
| 4.5 | RightPanel 冲突检测逻辑 | Phase 2 |
| 4.6 | 进度条集成 | Phase 2, 3.7 |

### Phase 5: 样式与 i18n

| 步骤 | 内容 | 依赖 |
|------|------|------|
| 5.1 | `file-viewers.css` 样式 | Phase 3 |
| 5.2 | 英文 i18n 字符串 | - |
| 5.3 | 其他语言 i18n 字符串 | 5.2 |

### Phase 6: 测试与验证

| 步骤 | 内容 | 依赖 |
|------|------|------|
| 6.1 | 上传功能测试 (正常 + 冲突 + 大小限制 + worktree) | Phase 4 |
| 6.2 | 下载功能测试 (正常 + Range + 大小限制 + worktree) | Phase 4 |
| 6.3 | 删除功能测试 (正常 + 冲突 + 文件夹) | Phase 4 |
| 6.4 | 预览器测试 (所有类型 + fallback) | Phase 4 |
| 6.5 | Sandbox 穿透测试 | Phase 1 |
| 6.6 | Worktree 场景端到端测试 | Phase 4 |

---

## 12. 技术决策记录

### 12.1 为什么文件操作走 Server 路由而不是 SDK proxy？

**决策**: 上传/下载/删除通过 CodeNomad Server 路由实现，不在 OpenCode SDK 层扩展。

**原因**:
1. OpenCode 目前不支持上传/下载/删除操作（无对应 API）
2. Server 路由可直接访问文件系统，无需修改 OpenCode
3. 已有 `FileSystemBrowser` 提供 Sandbox 防护
4. 已有 `resolveWorktreeDirectory()` 可解析 worktree 真实目录

### 12.2 为什么需要 worktree slug 参数？

**决策**: 所有文件操作端点增加 `?worktree=<slug>` 参数。

**原因**:
1. 用户通过 `browserClient()` 浏览的是 worktree 目录，不是 workspace 根目录
2. 在非 root worktree 场景下，文件操作的 target 必须与浏览的目录一致
3. 已有 `resolveWorktreeDirectory()` 可根据 slug 解析真实目录，复用成本极低
4. 前端已有 `worktreeSlugForViewer()` signal，传递无额外开销

### 12.3 为什么使用独立下载端点？

**决策**: 使用 `GET /files/download` 而非 `GET /files/content?download=true`

**原因**:
1. 职责清晰：content 端点返回文本 JSON，download 端点返回二进制流
2. 向后兼容：不破坏现有 `content` 端点行为
3. 易于测试：独立端点更容易编写测试

### 12.4 为什么使用 XHR 而非 fetch？

**决策**: 上传/下载使用 `XMLHttpRequest`

**原因**:
1. `fetch` 不支持上传进度事件
2. `XHR.upload.onprogress` 和 `XHR.onprogress` 提供实时进度
3. 对于大文件（接近 100MB 限制），进度条是必要的 UX

### 12.5 为什么使用预览器注册表模式？

**决策**: 使用可注册的预览器数组 + 优先级排序

**原因**:
1. **开闭原则**：新增预览器只需添加数组项，无需修改现有代码
2. **优先级控制**：通过 `priority` 字段解决文件类型重叠
3. **懒加载**：每个预览器使用 `lazy()` 导入，减少初始包大小
4. **易于测试**：每个预览器独立测试

### 12.6 为什么禁止删除文件夹？

**决策**: 暂时禁止删除文件夹

**原因**:
1. **风险控制**：文件夹删除可能导致大量数据丢失
2. **UI 复杂度**：文件夹删除需要递归确认和进度显示
3. **后续可扩展**：未来可添加"安全删除"（移至回收站）功能

### 12.7 为什么断点续传用 Range 请求？

**决策**: 使用 HTTP `Range` 头实现断点续传

**原因**:
1. 标准 HTTP 协议支持（RFC 7233）
2. 浏览器原生支持
3. Server 端实现简单（`fs.createReadStream({ start, end })`）

### 12.8 二进制文件为什么走 download API 而不是 SDK read？

**决策**: 二进制文件预览通过 `downloadWorkspaceFile()` 获取 Blob，而不是 `browserClient().file.read()`

**原因**:
1. SDK 的 `file.read()` 对二进制文件返回 `encoding: "base64"`，当前被 RightPanel 直接拒绝
2. 修改 SDK 的二进制处理需要协调 OpenCode 端变更
3. download API 已支持二进制流，且自带 Sandbox 防护
4. Blob URL 更适合 `<img>`、`<audio>`、`<video>`、`<iframe>` 直接消费

### 12.9 为什么 Markdown 预览器不复用 `<Markdown>` 组件？

**决策**: 不复用现有的 `<Markdown>` 组件（`components/markdown.tsx`），而是新建 `MarkdownViewer` 组件直接调用 `renderMarkdown()` 函数。

**原因**:
1. **数据模型耦合**：`TextPart` 依赖 —— `<Markdown>` 组件要求 `part: TextPart` 参数，深度耦合聊天消息的数据结构（`id`, `version`, `renderCache` 等字段）
2. **缓存体系不兼容**：组件使用 session 级别的 `useGlobalCache`，缓存 key 包含 `instanceId` 和 `sessionId`，对文件浏览器场景无意义
3. **需自建缓存策略**：文件浏览器需要以"文件路径 + 内容 hash"为 key 的轻量缓存，避免每次渲染都重新解析
4. **异步语言加载**：组件依赖 `onLanguagesLoaded` 订阅实现代码块异步高亮，需要自行处理重新渲染逻辑

**实现方式**:
- 直接调用 `lib/markdown.ts` 中的 `renderMarkdown(content, options)` 函数
- 自建 Map 缓存：`cache.get(path + contentHash)` → 命中则返回
- 订阅 `onLanguagesLoaded()` → 检测到新语言加载后清除相关缓存项并触发重新渲染

---

## 13. 桌面兼容性评估

| 平台 | 兼容性 | 说明 |
|------|--------|------|
| **Electron (macOS)** | ✅ 良好 | 文件系统操作无限制 |
| **Electron (Windows)** | ✅ 良好 | `FileSystemBrowser` 已处理 Windows 路径 (`isWindows` 分支) |
| **Electron (Linux)** | ✅ 良好 | 无特殊限制 |
| **Electron CSP** | ⚠️ 需注意 | Blob URL 在 `<img>` / `<audio>` / `<video>` 中正常加载，但 `<iframe>` 可能需要 `blob:` 加入 CSP `frame-src` |
| **Tauri (实验)** | ⚠️ 需验证 | Tauri CSP 更严格，iframe PDF 预览可能需要额外配置 |
| **Web 远程访问** | ⚠️ 需注意 | 下载需要 cookie 认证；XHR blob 在跨域场景可能受限 |
| **移动端浏览器** | ⚠️ 需注意 | 操作按钮直接显示（非悬停），适合触屏操作 |

**PDF iframe 兼容性风险**：Electron 的 `webSecurity` 可能阻止 `blob:` 在 iframe 中加载。降级方案：如果 iframe 不支持，直接触发浏览器下载。

---

## 14. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| **Worktree 目录解析失败** | 中 | slug="root" 时 fallback 到 workspace.path；非 git 仓库同上 |
| **大文件上传导致 OOM** | 高 | 设置 100MB 限制 + 流式写入 |
| **路径穿越攻击** | 高 | `FileSystemBrowser.toRestrictedAbsolute()` 已有防护 |
| **并发上传冲突** | 中 | 409 状态码 + 用户确认 |
| **预览器内存泄漏** | 中 | `onCleanup` 撤销 Blob URL |
| **断点续传兼容性问题** | 低 | 降级为完整下载 |
| **PDF iframe 在 Electron 中被阻止** | 低 | 检测 iframe 加载失败后降级为下载链接 |
| **`resolveWorktreeDirectory` 重构风险** | 低 | 函数逻辑不变，仅改变可见性和调用位置 |
| **窄面板下操作列挤压文件名** | 低 | 列表最小宽度 200px，操作列固定 48px（22px×2 按钮 + gap），文件名约 116px 够用 |

---

## 15. 后续可扩展点

| 功能 | 说明 | 优先级 |
|------|------|--------|
| **文件夹删除** | 递归删除 + 进度条 | P2 |
| **文件重命名** | 右键菜单 + 内联编辑 | P2 |
| **批量操作** | 多选上传/下载/删除 | P2 |
| **Git 差异预览** | 显示未提交的更改 | P1 |
| **Hex 查看器** | 二进制文件十六进制显示 | P3 |
| **CSV 预览** | 表格化显示 CSV 内容 | P2 |
| **JSON 格式化** | JSON 文件树形显示 | P2 |
| **文件历史** | 查看文件修改历史 | P3 |

---

## 16. 文件长度告警

根据项目规范，以下文件在实施后可能超限：

| 文件 | 当前行数 | 预期行数 | 状态 |
|------|----------|----------|------|
| `FilesTab.tsx` | 320 | 320 | ✅ 正常 |
| `RightPanel.tsx` | 1091 | 必须重构 | ⚠️ 阻塞项（用户要求不拆分） |
| `workspaces.ts` (路由) | ~131 | ~250 | 需关注 |
| `api-client.ts` | ~469 | ~550 | 需关注 |
| `useFileOperations.ts` | 新建 | ~150 | ✅ 正常 |
| `markdown-viewer.tsx` | 155 | ~300 | ✅ 正常 |
| `right-panel.css` | 603 | 603 | ⚠️ 需拆分（预已存在问题） |
| `file-viewers.css` | 80 | 80 | ✅ 正常 |

**建议**：
- **`RightPanel.tsx` 重构为阻塞项**：文件已超 1091 行（超出 800 行限制 36%），但用户明确表示不拆分（"RightPanel.tsx 不要切分了，我怕改坏了"）。当前阶段维持现状，后续再评估。
- **`right-panel.css` 超过 600 行**：建议拆分为 `right-panel.css`（聚合）+ `tabs/`、`file-list/`、`viewer/` 子文件，按 feature 分治（预已存在问题）

---

## 附录 A: 依赖添加

```json
// packages/server/package.json
{
  "dependencies": {
    "@fastify/multipart": "^8.0.0"
  }
}
```

---

## 附录 B: 关键代码片段

### B.1 Worktree 目录解析（复用已有逻辑）

```typescript
// workspaces/git-worktrees.ts (从 http-server.ts 迁移至此)
async function resolveWorktreeDirectory(params: {
  workspaceId: string
  workspacePath: string
  worktreeSlug: string
  logger: Logger
}): Promise<string | null> {
  const cached = await getCachedWorktrees({ ... })
  const match = cached.worktrees.find((wt) => wt.slug === worktreeSlug)
  if (match) return match.directory

  worktreeCache.delete(params.workspaceId)
  const refreshed = await getCachedWorktrees({ ... })
  return refreshed.worktrees.find((wt) => wt.slug === worktreeSlug)?.directory ?? null
}
```

### B.2 Range 请求处理

```typescript
const range = request.headers.range
if (range) {
  const parts = range.replace(/bytes=/, "").split("-")
  const start = parseInt(parts[0], 10)
  const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1
  const chunkSize = (end - start) + 1

  reply.code(206)
  reply.header("Content-Range", `bytes ${start}-${end}/${stats.size}`)
  reply.header("Content-Length", chunkSize)

  const stream = fs.createReadStream(filePath, { start, end })
  return reply.send(stream)
}
```

### B.3 预览器选择逻辑

```typescript
function selectPreviewer(path: string, mimeType?: string): FilePreviewer {
  return filePreviewers
    .filter(p => p.canHandle(path, mimeType))
    .sort((a, b) => b.priority - a.priority)[0]
}
```

---

*文档结束*
