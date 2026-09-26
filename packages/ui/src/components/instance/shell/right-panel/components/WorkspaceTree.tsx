import { For, Show, createMemo } from "solid-js"
import { ChevronDown, ChevronRight, Folder, FolderOpen, FileCode, FileText, Image, File, RefreshCw } from "lucide-solid"
import type { useWorkspaceTree } from "../useWorkspaceTree"

export function WorkspaceTree(props: {
  tree: ReturnType<typeof useWorkspaceTree>
  t: (key: string) => string
  directory: string
  canOpen: boolean
  onOpen: (path: string) => void
}) {
  const icon = (name: string) => /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i.test(name) ? Image
    : /\.(md|mdx|txt|rst)$/i.test(name) ? FileText
    : /\.(tsx?|jsx?|json|ya?ml|css|html|py|rs|sh)$/i.test(name) ? FileCode : File
  let root!: HTMLDivElement
  const tabStop = createMemo(() => props.tree.rows().some(row => row.path === props.tree.state().selected)
    ? props.tree.state().selected : props.tree.rows()[0]?.path)
  const focusRow = (path: string) => root.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.focus()
  function keyDown(event: KeyboardEvent, row: ReturnType<typeof props.tree.rows>[number]) {
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
    } else return
    event.preventDefault()
  }
  return <div class="workspace-tree">
    <div class="workspace-tree-root" title={props.directory}><FolderOpen size={15} /><strong>{props.directory.replace(/\\/g, "/").split("/").pop()}</strong></div>
    <div ref={root} role="tree" aria-label={props.t("filesPanel.workspace")}>
      <For each={props.tree.rows()}>{row => {
        const isFolder = row.type === "directory", Icon = icon(row.name)
        const expanded = () => props.tree.state().expanded.has(row.path)
        return <button role="treeitem" data-path={row.path} aria-label={row.name} aria-level={row.depth}
          aria-expanded={isFolder ? expanded() : undefined} aria-selected={props.tree.state().selected === row.path}
          class="workspace-tree-row" style={{ "padding-inline-start": `${8 + row.depth * 14}px` }} title={row.path}
          tabIndex={tabStop() === row.path ? 0 : -1}
          onFocus={() => props.tree.select(row.path)} onKeyDown={event => keyDown(event, row)}
          onClick={() => { props.tree.select(row.path); if (isFolder) props.tree.toggle(row.path); else if (props.canOpen) props.onOpen(row.path) }}>
          <Show when={isFolder} fallback={<span class="workspace-tree-spacer" />}>
            <Show when={expanded()} fallback={<ChevronRight size={12} />}><ChevronDown size={12} /></Show>
          </Show>
          <Show when={isFolder} fallback={<Icon size={14} />}><Show when={expanded()} fallback={<Folder size={14} />}><FolderOpen size={14} /></Show></Show>
          <span>{row.name}</span><Show when={props.tree.busy().has(row.path)}><RefreshCw size={12} class="animate-spin" /></Show>
        </button>
      }}</For>
    </div>
    <For each={[...props.tree.errors()]}>{([path, error]) => <div class="p-3 text-xs text-error" role="alert">{path}: {error}
      <button onClick={() => void props.tree.load(path, true)}>{props.t("instanceShell.rightPanel.actions.refresh")}</button></div>}</For>
    <Show when={props.tree.busy().has(".")}><p class="p-3 text-xs text-secondary" role="status">{props.t("instanceInfo.loading")}</p></Show>
  </div>
}
