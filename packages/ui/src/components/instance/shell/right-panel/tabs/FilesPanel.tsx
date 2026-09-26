import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { ArrowLeft, ChevronRight, GitBranch, GitCommitHorizontal, RefreshCw } from "lucide-solid"
import type { useGitChanges } from "../useGitChanges"
import type { useGitHistory } from "../useGitHistory"
import type { FilePreviewTarget } from "../../../../../stores/files-preview"
import { buildGitChangeListItems } from "../git-changes-model"
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
  branch: string | null
  onWorktreeChange: (slug: string) => void
  onOpenFile: (file: Pick<FilePreviewTarget, "kind" | "path" | "originalPath" | "scope" | "commit" | "subject">) => void
  canOpenFile: boolean
}

const FilesPanel: Component<FilesPanelProps> = props => {
  const items = createMemo(() => buildGitChangeListItems(props.git.gitStatusEntries()))
  const [filter, setFilter] = createSignal("")
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
        <button disabled={!props.gitAvailable} aria-pressed={props.mode === "changes"} onClick={() => props.onModeChange("changes")}>{props.t("gitPanel.changes")} <span class="badge-shape">{props.git.gitStatusEntries()?.length ?? "–"}</span></button>
        <button disabled={!props.gitAvailable} aria-pressed={props.mode === "history"} onClick={() => props.onModeChange("history")}>{props.t("filesPanel.commits")}</button>
      </div>
    </div>
    <Show when={error()}><div role="alert" class="p-3 text-error text-xs">{error()}</div></Show>
    <Show when={!props.canOpenFile}><p class="p-3 text-xs text-secondary">{props.t("instanceShell.gitChanges.noSessionSelected")}</p></Show>
    <div class="git-panel-body" style={{ display: props.mode === "workspace" ? undefined : "none" }}>
      <WorkspaceTree tree={props.tree} t={props.t} directory={props.directory} canOpen={props.canOpenFile} onOpen={path => props.onOpenFile({ kind: "workspace", path })} />
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
          <For each={details().files}>{file => <button class="git-panel-file" title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path} disabled={!props.canOpenFile} onClick={() => props.onOpenFile({
            path: file.path, commit: details().id, subject: details().message.split("\n")[0],
          })}><span class={`git-file-status git-file-status-${file.status}`}>{file.status}</span><span>{file.path}</span><ChevronRight size={12} /></button>}</For>
        </>}</Show>
      </Show>
      <Show when={loading()}><p class="p-3 text-xs text-secondary" role="status">{props.t("instanceInfo.loading")}</p></Show>
    </div>
    <div class="git-panel-body" style={{ display: props.mode === "changes" ? undefined : "none" }}>
      <Show when={items().length === 0}><p class="p-3 text-xs text-secondary">{props.git.gitStatusLoading() ? props.t("instanceInfo.loading") : props.t("instanceShell.gitChanges.empty")}</p></Show>
      <For each={["staged", "unstaged"] as const}>{section => <Show when={items().some(item => item.section === section)}>
        <div class="git-panel-section">{props.t(`instanceShell.gitChanges.sections.${section}`)}<span>{items().filter(item => item.section === section).length}</span></div>
        <For each={items().filter(item => item.section === section)}>{item => <button class="git-panel-file" classList={{ "git-panel-file-selected": props.git.gitActionItems().some(selected => selected.id === item.id) }} aria-pressed={props.git.gitActionItems().some(selected => selected.id === item.id)} aria-current={props.git.gitSelectedItemId() === item.id ? "true" : undefined} title={item.path} disabled={!props.canOpenFile} onClick={event => {
          props.git.handleGitRowClick(item, event)
          if (!event.ctrlKey && !event.metaKey && !event.shiftKey) props.onOpenFile({ path: item.path, originalPath: item.originalPath, scope: item.section })
        }}><span class="git-file-status">{item.status.slice(0, 1).toUpperCase()}</span><span>{item.path}</span><small><b class="file-list-item-additions">+{item.additions}</b> <b class="file-list-item-deletions">−{item.deletions}</b></small></button>}</For>
      </Show>}</For>
      <Show when={items().length > 0}><details class="git-panel-actions"><summary>{props.t("gitPanel.actions")}</summary>
        <For each={["staged", "unstaged"] as const}>{section => {
          const targets = createMemo(() => props.git.gitActionItems().filter(item => item.section === section))
          const action = section === "staged" ? "unstage" : "stage"
          return <Show when={targets().length > 0}><button class="git-panel-more" title={targets().map(item => item.path).join("\n")} onClick={() => {
            const item = targets()[0]
            if (item) section === "staged" ? props.git.unstageGitFile(item) : props.git.stageGitFile(item)
          }}>{targets().length > 1
            ? props.t(`instanceShell.gitChanges.actions.${action}Selected`, { count: targets().length })
            : `${props.t(`instanceShell.gitChanges.actions.${action}`)} · ${targets()[0]?.path ?? ""}`}</button></Show>
        }}</For>
        <textarea aria-label={props.t("instanceShell.gitChanges.commit.placeholder")} placeholder={props.t("instanceShell.gitChanges.commit.placeholder")} value={props.git.gitCommitMessage()} onInput={event => props.git.setGitCommitMessage(event.currentTarget.value)} />
        <button class="git-panel-more" disabled={!props.git.gitCommitMessage().trim() || !items().some(item => item.section === "staged") || props.git.gitCommitSubmitting()} onClick={() => void props.git.submitGitCommit()}>{props.t("instanceShell.gitChanges.commit.submit")}</button>
      </details></Show>
    </div>
  </section>
}
export default FilesPanel
