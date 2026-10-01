import { For, Show, createMemo, createSignal, createUniqueId, type Component, type JSX } from "solid-js"
import {
  DragDropProvider,
  DragDropSensors,
  closestCenter,
  createDraggable,
  createDroppable,
  transformStyle,
  type DragEvent as SolidDndDragEvent,
} from "@thisbeyond/solid-dnd"
import { ArrowLeft, ChevronRight, Eye, GitBranch, GitCommitHorizontal, Minus, Plus, RefreshCw } from "lucide-solid"
import type { useGitChanges } from "../useGitChanges"
import type { useGitHistory } from "../useGitHistory"
import { closeFilePreview, getFilePreview, type FilePreviewTarget } from "../../../../../stores/files-preview"
import FileRowActions from "../FileRowActions"
import type { ActionOverflowMenuItem } from "../../../../action-overflow-menu"
import { buildGitChangeListItems } from "../git-changes-model"
import type { GitChangeListItem, GitChangeSection } from "../types"
import type { useWorkspaceTree } from "../useWorkspaceTree"
import { WorkspaceTree } from "../components/WorkspaceTree"
import type { FilesPanelMode } from "../files-panel-state"

interface FilesPanelProps {
  t: (key: string, vars?: Record<string, any>) => string
  git: ReturnType<typeof useGitChanges>
  history: ReturnType<typeof useGitHistory>
  tree: ReturnType<typeof useWorkspaceTree>
  gitAvailable: boolean
  mode: FilesPanelMode
  onModeChange: (mode: FilesPanelMode) => void
  worktrees: Array<{ slug: string; directory: string; branch?: string | null }>
  slug: string
  directory: string
  instanceId: string
  branch: string | null
  onWorktreeChange: (slug: string) => void
  onOpenFile: (file: Pick<FilePreviewTarget, "kind" | "path" | "originalPath" | "scope" | "commit" | "subject">) => void
  canOpenFile: boolean
}

const FilesPanel: Component<FilesPanelProps> = props => {
  const items = createMemo(() => buildGitChangeListItems(props.git.gitStatusEntries()))
  const [filter, setFilter] = createSignal("")
  const [selectedCommitFile, setSelectedCommitFile] = createSignal("")
  const previewActive = (file: Parameters<FilesPanelProps["onOpenFile"]>[0]) => {
    const target = getFilePreview(props.instanceId)
    return Boolean(target && target.slug === props.slug && target.directory === props.directory && target.path === file.path
      && (target.kind ?? "diff") === (file.kind ?? "diff") && target.commit === file.commit && target.scope === file.scope)
  }
  const togglePreview: FilesPanelProps["onOpenFile"] = file => {
    if (previewActive(file)) closeFilePreview(props.instanceId)
    else props.onOpenFile(file)
  }
  let historyBody: HTMLDivElement | undefined
  let historyScroll = 0
  const selectCommit = (id: string) => {
    historyScroll = historyBody?.scrollTop ?? 0
    void props.history.select(id)
  }
  const backToCommits = () => {
    props.history.back()
    requestAnimationFrame(() => { if (historyBody?.isConnected) historyBody.scrollTop = historyScroll })
  }
  const commits = createMemo(() => (props.history.page()?.commits ?? []).filter(commit =>
    `${commit.subject} ${commit.author} ${commit.id}`.toLowerCase().includes(filter().toLowerCase())))
  const handleStageDragEnd = ({ draggable, droppable }: SolidDndDragEvent) => {
    if (!droppable) return
    const target = String(droppable.id)
    if (target !== "staged" && target !== "unstaged") return
    const item = items().find(entry => entry.id === String(draggable.id))
    if (!item || item.section === target) return
    if (target === "staged") props.git.stageGitFile(item)
    else props.git.unstageGitFile(item)
  }
  const loading = () => props.mode === "workspace" ? props.tree.busy().size > 0 : props.mode === "history" ? props.history.loading() || props.history.detailLoading() : props.git.gitStatusLoading()
  const error = () => props.mode === "workspace" ? null : props.mode === "history" ? props.history.error() : props.git.gitStatusError()
  const basename = (path: string) => path.replace(/\\/g, "/").split("/").pop() || path
  const date = (value: string) => new Date(value).toLocaleDateString(document.documentElement.lang || undefined, { month: "short", day: "numeric" })

  return <section class="git-panel" aria-label={props.t("instanceShell.rightPanel.tabs.files")}>
    <header class="git-panel-context">
      <div class="git-panel-branch"><GitBranch size={16} /><strong>{props.gitAvailable ? props.branch || props.t("gitPanel.detached") : basename(props.directory)}</strong>
        <button class="files-header-icon-button" aria-label={props.t("instanceShell.rightPanel.actions.refresh")} disabled={loading()} onClick={() => {
          if (props.mode === "workspace") props.tree.refresh()
          else if (props.mode === "history") void props.history.refresh()
          else void props.git.refreshGitStatus()
        }}><RefreshCw size={14} class={loading() ? "animate-spin" : ""} /></button>
      </div>
      <select class="git-panel-worktree" value={props.slug} aria-label={props.t("gitPanel.worktree")} title={props.directory}
        onChange={event => props.onWorktreeChange(event.currentTarget.value)}>
        <Show when={!props.worktrees.some(tree => tree.slug === props.slug)}><option value={props.slug}>{basename(props.directory)}</option></Show>
        <For each={props.worktrees}>{tree => <option value={tree.slug}>{basename(tree.directory)} · {tree.branch || props.t("gitPanel.detached")}</option>}</For>
      </select>
    </header>
    <div class="git-panel-tools">
      <div class="git-panel-switch" role="group" aria-label={props.t("instanceShell.rightPanel.tabs.files")}>
        <button aria-pressed={props.mode === "workspace"} onClick={() => props.onModeChange("workspace")}>{props.t("filesPanel.workspace")}</button>
        <button disabled={!props.gitAvailable} aria-pressed={props.mode === "changes"} onClick={() => props.onModeChange("changes")}>{props.t("gitPanel.changes")}</button>
        <button disabled={!props.gitAvailable} aria-pressed={props.mode === "history"} onClick={() => props.onModeChange("history")}>{props.t("filesPanel.commits")}</button>
      </div>
      <Show when={props.mode === "changes" && props.git.gitStatusEntries()}>
        <span class="git-panel-count">{props.t("gitPanel.files", { count: props.git.gitStatusEntries()?.length ?? 0 })}</span>
      </Show>
    </div>
    <Show when={error()}><div role="alert" class="p-3 text-error text-xs">{error()}</div></Show>
    <Show when={!props.canOpenFile}><p class="p-3 text-xs text-secondary">{props.t("instanceShell.gitChanges.noSessionSelected")}</p></Show>
    <div class="git-panel-body" style={{ display: props.mode === "workspace" ? undefined : "none" }}>
      <WorkspaceTree tree={props.tree} t={props.t} directory={props.directory} instanceId={props.instanceId} worktreeSlug={props.slug} canOpen={props.canOpenFile}
        previewPath={getFilePreview(props.instanceId)?.kind === "workspace" && getFilePreview(props.instanceId)?.slug === props.slug ? getFilePreview(props.instanceId)?.path : undefined}
        onOpen={path => togglePreview({ kind: "workspace", path })} />
    </div>
    <div ref={historyBody} class="git-panel-body" style={{ display: props.mode === "history" ? undefined : "none" }}>
      <div style={{ display: props.history.selected() ? "none" : undefined }}>
        <input class="git-panel-filter" aria-label={props.t("gitPanel.filter")} placeholder={props.t("gitPanel.filter")} value={filter()} onInput={event => setFilter(event.currentTarget.value)} />
        <For each={commits()}>{commit => <button class="git-history-row" onClick={() => selectCommit(commit.id)}>
          <GitCommitHorizontal class="git-history-mark" size={16} />
          <span class="git-history-row-content"><strong>{commit.subject}</strong>
            <Show when={commit.refs}><span class="git-history-refs" title={commit.refs}>{commit.refs}</span></Show>
            <span class="git-history-meta"><span>{commit.author} · {date(commit.date)}</span><code>{commit.id.slice(0, 7)}</code></span>
          </span>
        </button>}</For>
        <Show when={!loading() && commits().length === 0}><p class="p-3 text-xs text-secondary">{props.t("gitPanel.emptyHistory")}</p></Show>
        <Show when={props.history.page()?.hasMore}><button class="git-panel-more" disabled={loading()} onClick={() => void props.history.refresh(true)}>{props.t("gitPanel.more")}</button></Show>
      </div>
      <Show when={props.history.selected()}>
        <button class="git-panel-back" onClick={backToCommits}><ArrowLeft size={14} />{props.t("filesPanel.commits")}</button>
        <Show when={props.history.details()}>{details => <>
          <div class="git-commit-summary"><code>{details().id.slice(0, 8)}</code><p>{details().message}</p><span>{props.t("gitPanel.files", { count: details().files.length })}</span></div>
          <div class="git-commit-files">
           <For each={details().files}>{file => {
             const target = () => ({ path: file.path, commit: details().id, subject: details().message.split("\n")[0] })
             return <div class="git-panel-file-row" classList={{ "git-panel-file-selected": selectedCommitFile() === `${details().id}:${file.path}` }}>
               <button class="git-panel-file git-panel-file-main" title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path} onClick={() => setSelectedCommitFile(`${details().id}:${file.path}`)}>
                 <span class={`git-file-status git-file-status-${file.status}`}>{file.status}</span><span>{file.path}</span>
               </button>
               <FileRowActions label={props.t("instanceShell.filesShell.actions.more", { name: file.path })} items={[{
                 key: "preview", label: `${props.t("filesPanel.viewer")} · ${file.path}`, icon: <Eye size={14} />,
                 checked: previewActive(target()), disabled: !props.canOpenFile, onSelect: () => togglePreview(target()),
               }]} />
             </div>
           }}</For>
          </div>
        </>}</Show>
      </Show>
      <Show when={loading()}><p class="p-3 text-xs text-secondary" role="status">{props.t("instanceInfo.loading")}</p></Show>
    </div>
    <div class="git-panel-body" style={{ display: props.mode === "changes" ? undefined : "none" }}>
      <DragDropProvider collisionDetector={closestCenter} onDragEnd={handleStageDragEnd}>
        <DragDropSensors>
          <Show when={items().length === 0}><p class="p-3 text-xs text-secondary">{props.git.gitStatusLoading() ? props.t("instanceInfo.loading") : props.t("instanceShell.gitChanges.empty")}</p></Show>
          <For each={["staged", "unstaged"] as const}>{section =>
            <ChangeSection t={props.t} section={section} items={items().filter(item => item.section === section)}
              git={props.git} canOpenFile={props.canOpenFile} onOpenFile={togglePreview} previewActive={previewActive}>
              <Show when={section === "staged"}>
                <div class="git-change-commit-box" role="group" aria-label={props.t("gitPanel.actions")}>
                  <For each={["staged", "unstaged"] as const}>{actionSection => {
                    const targets = createMemo(() => props.git.gitActionItems().filter(item => item.section === actionSection))
                    const action = actionSection === "staged" ? "unstage" : "stage"
                    return <Show when={targets().length > 0}><button class="git-panel-more" title={targets().map(item => item.path).join("\n")} onClick={() => {
                      const item = targets()[0]
                      if (item) actionSection === "staged" ? props.git.unstageGitFile(item) : props.git.stageGitFile(item)
                    }}>{targets().length > 1
                      ? props.t(`instanceShell.gitChanges.actions.${action}Selected`, { count: targets().length })
                      : `${props.t(`instanceShell.gitChanges.actions.${action}`)} · ${targets()[0]?.path ?? ""}`}</button></Show>
                  }}</For>
                  <div class="git-change-commit-input-wrap">
                    <textarea class="git-change-commit-input" rows={1} aria-label={props.t("instanceShell.gitChanges.commit.placeholder")} placeholder={props.t("instanceShell.gitChanges.commit.placeholder")} value={props.git.gitCommitMessage()} onInput={event => props.git.setGitCommitMessage(event.currentTarget.value)} />
                    <button type="button" class="git-change-commit-button git-change-commit-button-overlay" disabled={!props.git.gitCommitMessage().trim() || !items().some(item => item.section === "staged") || props.git.gitCommitSubmitting()} onClick={() => void props.git.submitGitCommit()}>{props.t(props.git.gitCommitSubmitting() ? "instanceShell.gitChanges.commit.submitting" : "instanceShell.gitChanges.commit.submit")}</button>
                  </div>
                </div>
              </Show>
            </ChangeSection>
          }</For>
        </DragDropSensors>
      </DragDropProvider>
    </div>
  </section>
}

const ChangeSection: Component<{
  t: (key: string, vars?: Record<string, any>) => string
  section: GitChangeSection
  items: GitChangeListItem[]
  git: ReturnType<typeof useGitChanges>
  canOpenFile: boolean
  onOpenFile: FilesPanelProps["onOpenFile"]
  previewActive: (file: Parameters<FilesPanelProps["onOpenFile"]>[0]) => boolean
  children?: JSX.Element
}> = sectionProps => {
  const droppable = createDroppable(sectionProps.section)
  const [open, setOpen] = createSignal(true)
  const contentId = createUniqueId()
  return <div ref={droppable} class="git-drop-zone git-change-section" classList={{ "git-drop-active": droppable.isActiveDroppable }}>
    <button type="button" class="git-change-section-header" aria-expanded={open()} aria-controls={contentId} onClick={() => setOpen(value => !value)}>
      <span class="git-change-section-header-main">
        <span class="git-change-section-chevron disclosure-chevron"><ChevronRight class="w-3.5 h-3.5" aria-hidden="true" /></span>
        <span class="git-change-section-title">{sectionProps.t(`instanceShell.gitChanges.sections.${sectionProps.section}`)}</span>
      </span>
      <span class="git-change-section-count">{sectionProps.items.length}</span>
    </button>
    <div id={contentId} hidden={!open()}>
      {sectionProps.children}
      <For each={sectionProps.items}>{item => <GitChangeRow t={sectionProps.t} item={item} git={sectionProps.git}
        canOpenFile={sectionProps.canOpenFile} onOpenFile={sectionProps.onOpenFile} previewActive={sectionProps.previewActive} />}</For>
    </div>
  </div>
}

const GitChangeRow: Component<{
  t: (key: string, vars?: Record<string, any>) => string
  item: GitChangeListItem
  git: ReturnType<typeof useGitChanges>
  canOpenFile: boolean
  onOpenFile: FilesPanelProps["onOpenFile"]
  previewActive: (file: Parameters<FilesPanelProps["onOpenFile"]>[0]) => boolean
}> = rowProps => {
  const draggable = createDraggable(rowProps.item.id)
  const staged = () => rowProps.item.section === "staged"
  const toggleStage = () => {
    if (staged()) rowProps.git.unstageGitFile(rowProps.item)
    else rowProps.git.stageGitFile(rowProps.item)
  }
  const stageLabel = () => rowProps.t(staged() ? "instanceShell.gitChanges.actions.unstage" : "instanceShell.gitChanges.actions.stage")
  const target = () => ({ path: rowProps.item.path, originalPath: rowProps.item.originalPath, scope: rowProps.item.section })
  // Keep action identities stable when another reader opens. Recreating every
  // icon/menu for a preview-state change stalls large inventories, even hidden.
  const actions: ActionOverflowMenuItem[] = [
    { key: "preview", get label() { return `${rowProps.t("filesPanel.viewer")} · ${rowProps.item.path}` }, icon: <Eye size={14} />,
      get checked() { return rowProps.previewActive(target()) }, get disabled() { return !rowProps.canOpenFile }, onSelect: () => rowProps.onOpenFile(target()) },
    { key: "stage", get label() { return `${stageLabel()} · ${rowProps.item.path}` },
      icon: <Show when={staged()} fallback={<Plus size={14} />}><Minus size={14} /></Show>, onSelect: toggleStage },
  ]
  return <div ref={draggable} class="git-panel-file-row" classList={{ "git-panel-file-selected": rowProps.git.gitActionItems().some(selected => selected.id === rowProps.item.id) }} style={transformStyle(draggable.transform)}>
    <button class="git-panel-file git-panel-file-main" aria-pressed={rowProps.git.gitActionItems().some(selected => selected.id === rowProps.item.id)} aria-current={rowProps.git.gitSelectedItemId() === rowProps.item.id ? "true" : undefined} title={rowProps.item.path} disabled={!rowProps.canOpenFile} onClick={event => {
       rowProps.git.handleGitRowClick(rowProps.item, event)
    }}><span class="git-file-status">{rowProps.item.status.slice(0, 1).toUpperCase()}</span><span>{rowProps.item.path}</span><small><b class="file-list-item-additions">+{rowProps.item.additions}</b> <b class="file-list-item-deletions">−{rowProps.item.deletions}</b></small></button>
    <FileRowActions label={rowProps.t("instanceShell.filesShell.actions.more", { name: rowProps.item.path })} items={actions} />
  </div>
}
export default FilesPanel
