import { For, Show, createMemo } from "solid-js"
import { ChevronDown, ChevronRight, Copy, ExternalLink, Eye, Folder, FolderOpen, FileCode, FileText, Image, File, RefreshCw, TerminalSquare } from "lucide-solid"
import type { useWorkspaceTree } from "../useWorkspaceTree"
import type { ActionOverflowMenuItem } from "../../../../action-overflow-menu"
import FileRowActions from "../FileRowActions"
import { copyToClipboard } from "../../../../../lib/clipboard"
import { showToastNotification } from "../../../../../lib/notifications"
import { canOpenWorkspacePaths, openWorkspacePath } from "../../../../../lib/workspace-open"

export function WorkspaceTree(props: {
  tree: ReturnType<typeof useWorkspaceTree>
  t: (key: string, vars?: Record<string, any>) => string
  directory: string
  instanceId: string
  worktreeSlug: string
  canOpen: boolean
  previewPath?: string
  onOpen: (path: string) => void
}) {
  const icon = (name: string) => /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i.test(name) ? Image
    : /\.(md|mdx|txt|rst)$/i.test(name) ? FileText
    : /\.(tsx?|jsx?|json|ya?ml|css|html|py|rs|sh)$/i.test(name) ? FileCode : File
  let root!: HTMLDivElement
  const tabStop = createMemo(() => props.tree.rows().some(row => row.path === props.tree.state().selected)
    ? props.tree.state().selected : props.tree.rows()[0]?.path)
  const focusRow = (path: string) => root.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.focus()
  const activateRow = (row: ReturnType<typeof props.tree.rows>[number]) => {
    props.tree.select(row.path)
    if (row.type === "directory") props.tree.toggle(row.path)
  }
  function keyDown(event: KeyboardEvent, row: ReturnType<typeof props.tree.rows>[number]) {
    // The row menu trigger is a separate tab stop; its keys must not toggle the row.
    if (event.target !== event.currentTarget) return
    const rows = props.tree.rows(), index = rows.findIndex(entry => entry.path === row.path)
    const rtl = document.documentElement.dir === "rtl"
    if (event.key === "ArrowDown") focusRow(rows[Math.min(index + 1, rows.length - 1)]!.path)
    else if (event.key === "ArrowUp") focusRow(rows[Math.max(index - 1, 0)]!.path)
    else if (event.key === "Home") focusRow(rows[0]!.path)
    else if (event.key === "End") focusRow(rows[rows.length - 1]!.path)
    else if (event.key === (rtl ? "ArrowLeft" : "ArrowRight") && row.type === "directory") {
      if (!props.tree.state().expanded.has(row.path)) props.tree.toggle(row.path)
      else if (rows[index + 1]?.parent === row.path) focusRow(rows[index + 1]!.path)
    } else if (event.key === (rtl ? "ArrowRight" : "ArrowLeft")) {
      if (row.type === "directory" && props.tree.state().expanded.has(row.path)) props.tree.toggle(row.path)
      else focusRow(row.parent)
    } else if (event.key === "Enter" || event.key === " ") {
      activateRow(row)
    } else return
    event.preventDefault()
  }

  const handleCopyPath = async (path: string) => {
    const ok = await copyToClipboard(path)
    showToastNotification({
      message: ok ? props.t("instanceShell.filesShell.toast.copyPathSuccess") : props.t("instanceShell.filesShell.toast.copyPathError"),
      variant: ok ? "success" : "error",
    })
  }

  const handleNativeOpen = async (target: "default" | "reveal" | "terminal", path: string) => {
    try {
      await openWorkspacePath({ target, instanceId: props.instanceId, worktreeSlug: props.worktreeSlug, path })
    } catch (error) {
      showToastNotification({
        message: props.t("instanceShell.filesShell.toast.openError", {
          message: error instanceof Error ? error.message : String(error),
        }),
        variant: "error",
      })
    }
  }

  const rowActions = (row: ReturnType<typeof props.tree.rows>[number]): ActionOverflowMenuItem[] => {
    const items: ActionOverflowMenuItem[] = []
    if (row.type === "file") items.push({
      key: "preview", label: `${props.t("filesPanel.viewer")} · ${row.path}`,
      icon: <Eye class="w-3.5 h-3.5" />, disabled: !props.canOpen,
      checked: props.previewPath === row.path, onSelect: () => props.onOpen(row.path),
    })
    if (canOpenWorkspacePaths()) {
      if (row.type === "directory") {
        const isMacApp = isMacDesktop && row.path.toLowerCase().endsWith(".app")
        items.push(
          {
            key: "open-folder",
            label: props.t(isMacApp
              ? "instanceShell.filesShell.actions.showInFolder"
              : "instanceShell.filesShell.actions.openFolder"),
            icon: <FolderOpen class="w-3.5 h-3.5" />,
            onSelect: () => handleNativeOpen(isMacApp ? "reveal" : "default", row.path),
          },
          {
            key: "open-terminal",
            label: props.t("instanceShell.filesShell.actions.openTerminal"),
            icon: <TerminalSquare class="w-3.5 h-3.5" />,
            onSelect: () => handleNativeOpen("terminal", row.path),
          },
        )
      } else {
        if (isWindowsDesktop) {
          items.push({
            key: "open-default",
            label: props.t({
              open: "instanceShell.filesShell.actions.openDefault",
              edit: "instanceShell.filesShell.actions.editDefault",
              choose: "instanceShell.filesShell.actions.chooseApplication",
            }[windowsDefaultAction(row.path)]),
            icon: <ExternalLink class="w-3.5 h-3.5" />,
            onSelect: () => handleNativeOpen("default", row.path),
          })
        }
        items.push({
          key: "show-in-folder",
          label: props.t("instanceShell.filesShell.actions.showInFolder"),
          icon: <FolderOpen class="w-3.5 h-3.5" />,
          onSelect: () => handleNativeOpen("reveal", row.path),
        })
      }
    }
    items.push({
      key: "copy-path",
      label: props.t("instanceShell.filesShell.actions.copyPath"),
      icon: <Copy class="w-3.5 h-3.5" />,
      onSelect: () => handleCopyPath(row.path),
    })
    return items
  }

  return <div class="workspace-tree">
    <div class="workspace-tree-root" title={props.directory}><FolderOpen size={15} /><strong>{props.directory.replace(/\\/g, "/").split("/").pop()}</strong></div>
    <div ref={root} role="tree" aria-label={props.t("filesPanel.workspace")}>
      <For each={props.tree.rows()}>{row => {
        const isFolder = row.type === "directory", Icon = icon(row.name)
        const expanded = () => props.tree.state().expanded.has(row.path)
        return <div role="treeitem" data-path={row.path} aria-label={row.name} aria-level={row.depth}
          aria-expanded={isFolder ? expanded() : undefined} aria-selected={props.tree.state().selected === row.path}
          class="workspace-tree-row" style={{ "padding-inline-start": `${8 + row.depth * 14}px` }} title={row.path}
          tabIndex={tabStop() === row.path ? 0 : -1}
          onFocus={() => props.tree.select(row.path)} onKeyDown={event => keyDown(event, row)}
          onClick={() => activateRow(row)}>
          <Show when={isFolder} fallback={<span class="workspace-tree-spacer" />}>
            <Show when={expanded()} fallback={<ChevronRight size={12} />}><ChevronDown size={12} /></Show>
          </Show>
          <Show when={isFolder} fallback={<Icon size={14} />}><Show when={expanded()} fallback={<Folder size={14} />}><FolderOpen size={14} /></Show></Show>
          <span class="workspace-tree-label">{row.name}</span><Show when={props.tree.busy().has(row.path)}><RefreshCw size={12} class="animate-spin" /></Show>
          <FileRowActions items={rowActions(row)} label={props.t("instanceShell.filesShell.actions.more", { name: row.name })} />
        </div>
      }}</For>
    </div>
    <For each={[...props.tree.errors()]}>{([path, error]) => <div class="p-3 text-xs text-error" role="alert">{path}: {error}
      <button onClick={() => void props.tree.load(path, true)}>{props.t("instanceShell.rightPanel.actions.refresh")}</button></div>}</For>
    <Show when={props.tree.busy().has(".")}><p class="p-3 text-xs text-secondary" role="status">{props.t("instanceInfo.loading")}</p></Show>
  </div>
}

const isWindowsDesktop = typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent)
const isMacDesktop = typeof navigator !== "undefined" && /macintosh|mac os x/i.test(navigator.userAgent)
const safeWindowsOpenExtensions = new Set([
  "7z", "avi", "bmp", "c", "cc", "cfg", "conf", "cpp", "cs", "css", "csv", "dart", "diff", "docx",
  "env", "flac", "fs", "fsx", "gif", "go", "gz", "h", "hpp", "htm", "html", "ini", "java", "jpeg", "jpg",
  "json", "jsonc", "jsx", "kt", "kts", "less", "lock", "log", "lua", "md", "markdown", "mkv", "mov", "mp3",
  "mp4", "ogg", "patch", "pdf", "png", "pptx", "r", "rar", "rmd", "rs", "scss", "sql", "svg", "svelte",
  "swift", "tar", "toml", "ts", "tsx", "txt", "vue", "wav", "webm", "webp", "xlsx", "xml", "yaml", "yml", "zip",
])
const windowsEditExtensions = new Set([
  "bat", "cmd", "js", "jse", "pl", "ps1", "psd1", "psm1", "py", "pyw", "rb", "reg", "vbe", "vbs", "wsf", "wsh",
])

function windowsDefaultAction(path: string): "open" | "edit" | "choose" {
  const name = path.split(/[\\/]/).pop() ?? ""
  const dot = name.lastIndexOf(".")
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
  if (!isWindowsDesktop || (extension && safeWindowsOpenExtensions.has(extension))) return "open"
  if (extension && windowsEditExtensions.has(extension)) return "edit"
  return "choose"
}
