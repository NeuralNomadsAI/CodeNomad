import { createEffect, createMemo, createSignal, lazy, on, onCleanup, untrack, type Accessor, type JSX } from "solid-js"
import type { Instance } from "../../../../types/instance"
import type { Session } from "../../../../types/session"
import type { PromptInputApi } from "../../../prompt-input/types"
import type { RightPanelTab } from "./types"
import type { RightPanelCustomization, RightPanelSectionModule } from "./registry"
import { getWorktrees, getGitRepoStatus } from "../../../../stores/worktrees"
import { sessionWorktreeSlug } from "../file-preview-lifetime"
import { closeFilePreview, openFilePreview, type FilePreviewTarget } from "../../../../stores/files-preview"
import { getSessionPreview, showSessionChat } from "../../../../stores/session-previews"
import { useGitChanges } from "./useGitChanges"
import { useGitHistory } from "./useGitHistory"
import { createCoreRightPanelModule } from "./core-plugin"
import { useWorkspaceTree } from "./useWorkspaceTree"
import { useGitInit } from "./useGitInit"
import { FILES_PANEL_MODE_KEY, type FilesPanelMode } from "./files-panel-state"
import { readStoredEnum } from "../storage"
import { writeClientLayoutValue } from "../../../../stores/client-state"
import { ProjectCapabilityBoundary } from "../../../project-capability-gate"
import { captureInstanceRequestAuthority } from "../../../../stores/session-api"
import { createProjectAdmission, getProjectAvailability } from "../../../../stores/project-capability"
import { getRootClient } from "../../../../stores/opencode-client"
import { filesystemInvalidationVersion } from "../../../../lib/filesystem-events"

const LazyFilesPanel = lazy(() => import("./tabs/FilesPanel"))
const LazyStatusTab = lazy(() => import("./tabs/StatusTab"))

interface CoreRightPanelRuntimeOptions {
  isActive: Accessor<boolean>
  t: (key: string, vars?: Record<string, any>) => string
  instanceId: string
  instance: Instance
  activeSessionId: Accessor<string | null>
  activeSession: Accessor<Session | null>
  isPhoneLayout: Accessor<boolean>
  rightDrawerWidth: Accessor<number>
  rightDrawerWidthInitialized: Accessor<boolean>
  promptInputApi: Accessor<PromptInputApi | null>
  rightPanelTab: Accessor<RightPanelTab>
  expandedItems: Accessor<string[]>
  onExpandedItemsChange: (values: string[]) => void
  customization: Accessor<RightPanelCustomization>
  onCustomizationChange: (updater: (current: RightPanelCustomization) => RightPanelCustomization) => void
  extraStatusSections: Accessor<readonly RightPanelSectionModule[]>
  extraStatusContent?: Accessor<readonly (() => JSX.Element)[]>
}

export function createCoreRightPanelRuntime(options: CoreRightPanelRuntimeOptions) {
  const admission = createProjectAdmission(() => options.instanceId, () => "files")
  const files = createMemo(() => admission() ? untrack(() => createFilesRuntime(options)) : undefined)
  return createCoreRightPanelModule({
    renderFilesTab: () => <ProjectCapabilityBoundary instanceId={options.instanceId} feature="files">
      {files()?.()}
    </ProjectCapabilityBoundary>,
    renderStatusTab: () => <LazyStatusTab t={options.t} instanceId={options.instanceId} instance={options.instance}
      activeSession={options.activeSession} isActive={() => options.isActive() && options.rightPanelTab() === "status"}
      expandedItems={options.expandedItems} onExpandedItemsChange={options.onExpandedItemsChange}
      customization={options.customization} onCustomizationChange={options.onCustomizationChange} extraSections={options.extraStatusSections()}
      extraContent={options.extraStatusContent?.()} />,
  })
}

function createFilesRuntime(options: CoreRightPanelRuntimeOptions) {
  let disposed = false
  const sourceCurrent = captureInstanceRequestAuthority(options.instanceId)
  onCleanup(() => { disposed = true })
  const [mode, setMode] = createSignal<FilesPanelMode>(readStoredEnum(FILES_PANEL_MODE_KEY, ["workspace", "changes", "history"] as const) ?? "workspace")
  createEffect(() => writeClientLayoutValue(FILES_PANEL_MODE_KEY, mode()))
  const [browsedWorktree, setBrowsedWorktree] = createSignal<string | null>(null)
  // The open file reader outlives this panel (useFilePreviewLifetime); only the
  // browsed worktree is panel state.
  const sessionWorktree = createMemo(() => sessionWorktreeSlug(options.instanceId, options.activeSessionId()))
  createEffect(on(() => `${options.activeSessionId()}:${sessionWorktree()}`, () => setBrowsedWorktree(null)))
  const slug = createMemo(() => browsedWorktree() ?? sessionWorktree())
  const worktrees = createMemo(() => getWorktrees(options.instanceId))
  const worktree = createMemo(() => worktrees().find(entry => entry.slug === slug()))
  createEffect(() => {
    if (browsedWorktree() && worktrees().length && !worktree()) setBrowsedWorktree(null)
  })
  const active = () => !disposed && sourceCurrent() && getProjectAvailability(options.instanceId, "files").allowed && options.isActive() && options.rightPanelTab() === "files"
  // A known non-repository keeps Changes/Commits reachable for their Initialize
  // Git empty state, without Git reads. Unknown status (including no-Git
  // directory-only mode) retains the existing behavior.
  const gitAvailable = () => getGitRepoStatus(options.instanceId) !== false
  const directory = () => worktree()?.directory ?? options.instance.folder
  // prototype-1236: an explicit server's project reads its working changes only (no history, index or commit).
  const readOnly = () => !getProjectAvailability(options.instanceId, "hostGit").allowed
  const shownMode = (): FilesPanelMode => readOnly() && mode() === "history" ? "changes" : mode()
  const gitInit = useGitInit({ instanceId: options.instanceId, directory, t: options.t })
  const tree = useWorkspaceTree(options.instanceId, directory, () => active() && shownMode() === "workspace")
  const history = useGitHistory(options.instanceId, slug, () => active() && !readOnly() && gitAvailable() && shownMode() === "history")
  const git = useGitChanges({
    ...options, isActive: () => active() && gitAvailable() && shownMode() === "changes", rightPanelTab: () => "git-changes",
    worktreeSlug: slug, closeGitList: () => {}, externalDiff: true,
  })
  // The branch of an explicit server's folder, read natively; refreshed with its files.
  const [remoteBranch, setRemoteBranch] = createSignal<string | null>(null)
  createEffect(() => {
    if (!readOnly() || !active()) return
    filesystemInvalidationVersion(options.instanceId)
    const location = { directory: directory() }, current = sourceCurrent
    void Promise.resolve().then(() => getRootClient(options.instanceId).vcs.get({ location }))
      .then(result => { if (!disposed && current() && result.location?.directory === location.directory) setRemoteBranch(result.data?.branch?.current ?? null) })
      .catch(() => {})
  })
  const openFile = (file: Pick<FilePreviewTarget, "kind" | "path" | "originalPath" | "scope" | "commit" | "subject">) => {
    if (!active()) return
    const sessionId = options.activeSessionId()
    if (!sessionId || sessionId === "info") return
    const preview = getSessionPreview(sessionId, options.instance.folder)
    if (preview) showSessionChat(preview.storageKey)
    openFilePreview(options.instanceId, { ...file, sessionId, slug: slug(), directory: directory(), serviceDirectory: worktree()?.serviceDirectory })
  }
  return () => <LazyFilesPanel t={options.t} git={git} history={history} tree={tree} gitAvailable={gitAvailable()} gitInit={gitInit} mode={shownMode()} onModeChange={setMode}
      instanceId={options.instanceId} worktrees={worktrees()} slug={slug()} directory={worktree()?.directory ?? options.instance.folder}
      readOnly={readOnly()} branch={worktree()?.branch ?? (readOnly() ? remoteBranch() : null)} onWorktreeChange={value => {
        setBrowsedWorktree(value)
        closeFilePreview(options.instanceId)
      }} onOpenFile={openFile} canOpenFile={Boolean(options.activeSessionId() && options.activeSessionId() !== "info")} />
}
