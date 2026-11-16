import { createEffect, createMemo, createSignal, lazy, on, untrack, type Accessor, type JSX } from "solid-js"
import type { Instance } from "../../../../types/instance"
import type { Session } from "../../../../types/session"
import type { PromptInputApi } from "../../../prompt-input/types"
import type { RightPanelTab } from "./types"
import type { RightPanelCustomization, RightPanelSectionModule } from "./registry"
import { getWorktrees, getGitRepoStatus } from "../../../../stores/worktrees"
import { sessionWorktreeSlug } from "../file-preview-lifetime"
import { closeFilePreview, openFilePreview, type FilePreviewTarget } from "../../../../stores/files-preview"
import { useGitChanges } from "./useGitChanges"
import { useGitHistory } from "./useGitHistory"
import { createCoreRightPanelModule } from "./core-plugin"
import { useWorkspaceTree } from "./useWorkspaceTree"
import { useGitInit } from "./useGitInit"
import { FILES_PANEL_MODE_KEY, type FilesPanelMode } from "./files-panel-state"
import { readStoredEnum } from "../storage"
import { writeClientLayoutValue } from "../../../../stores/client-state"
import { getTabViewState, updateTabViewState } from "../../../../stores/tab-view-state"

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
  const [mode, selectMode] = createSignal<FilesPanelMode>(getTabViewState(options.instanceId).filesMode
    ?? readStoredEnum(FILES_PANEL_MODE_KEY, ["workspace", "changes", "history"] as const) ?? "workspace")
  const setMode = (value: FilesPanelMode) => {
    selectMode(value)
    writeClientLayoutValue(FILES_PANEL_MODE_KEY, value)
  }
  createEffect(() => {
    const selected = mode()
    untrack(() => updateTabViewState(options.instanceId, { filesMode: selected }))
  })
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
  const active = () => options.isActive() && options.rightPanelTab() === "files"
  // A known non-repository keeps Changes/Commits reachable for their Initialize
  // Git empty state, without Git reads. Unknown status (including no-Git
  // directory-only mode) retains the existing behavior.
  const gitAvailable = () => getGitRepoStatus(options.instanceId) !== false
  const directory = () => worktree()?.directory ?? options.instance.folder
  const gitInit = useGitInit({ instanceId: options.instanceId, directory, t: options.t })
  const tree = useWorkspaceTree(options.instanceId, directory, () => active() && mode() === "workspace")
  const history = useGitHistory(options.instanceId, slug, () => active() && gitAvailable() && mode() === "history")
  const git = useGitChanges({
    ...options, isActive: () => active() && gitAvailable() && mode() === "changes", rightPanelTab: () => "git-changes",
    worktreeSlug: slug, closeGitList: () => {}, externalDiff: true,
  })
  const openFile = (file: Pick<FilePreviewTarget, "kind" | "path" | "originalPath" | "scope" | "commit" | "subject">) => {
    const sessionId = options.activeSessionId()
    if (!sessionId || sessionId === "info") return
    openFilePreview(options.instanceId, { ...file, sessionId, slug: slug(), directory: directory(), serviceDirectory: worktree()?.serviceDirectory })
  }
  return createCoreRightPanelModule({
    renderFilesTab: () => <LazyFilesPanel t={options.t} git={git} history={history} tree={tree} gitAvailable={gitAvailable()} gitInit={gitInit} mode={mode()} onModeChange={setMode}
      instanceId={options.instanceId} worktrees={worktrees()} slug={slug()} directory={worktree()?.directory ?? options.instance.folder}
      branch={worktree()?.branch ?? null} onWorktreeChange={value => {
        setBrowsedWorktree(value)
        closeFilePreview(options.instanceId)
      }} onOpenFile={openFile} canOpenFile={Boolean(options.activeSessionId() && options.activeSessionId() !== "info")} />,
    renderStatusTab: () => <LazyStatusTab t={options.t} instanceId={options.instanceId} instance={options.instance}
      activeSession={options.activeSession} isActive={() => options.isActive() && options.rightPanelTab() === "status"}
      expandedItems={options.expandedItems} onExpandedItemsChange={options.onExpandedItemsChange}
      customization={options.customization} onCustomizationChange={options.onCustomizationChange} extraSections={options.extraStatusSections()}
      extraContent={options.extraStatusContent?.()} />,
  })
}
