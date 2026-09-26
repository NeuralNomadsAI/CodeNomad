import { createEffect, createMemo, createSignal, lazy, on, onCleanup, type Accessor } from "solid-js"
import type { Instance } from "../../../../types/instance"
import type { Session } from "../../../../types/session"
import type { PromptInputApi } from "../../../prompt-input/types"
import type { RightPanelTab } from "./types"
import type { RightPanelCustomization, RightPanelSectionModule } from "./registry"
import { getDefaultWorktreeSlug, getWorktreeSlugForSession, getWorktrees, getGitRepoStatus } from "../../../../stores/worktrees"
import { closeFilePreview, openFilePreview, type FilePreviewTarget } from "../../../../stores/files-preview"
import { showSessionChat } from "../../../../stores/session-previews"
import { useGitChanges } from "./useGitChanges"
import { useGitHistory } from "./useGitHistory"
import { createCoreRightPanelManifest } from "./core-plugin"
import { useWorkspaceTree } from "./useWorkspaceTree"
import { FILES_PANEL_MODE_KEY, type FilesPanelMode } from "./files-panel-state"
import { readStoredEnum } from "../storage"
import { writeClientLayoutValue } from "../../../../stores/client-state"

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
}

export function createCoreRightPanelRuntime(options: CoreRightPanelRuntimeOptions) {
  const [mode, setMode] = createSignal<FilesPanelMode>(readStoredEnum(FILES_PANEL_MODE_KEY, ["workspace", "changes", "history"] as const) ?? "workspace")
  createEffect(() => writeClientLayoutValue(FILES_PANEL_MODE_KEY, mode()))
  const [browsedWorktree, setBrowsedWorktree] = createSignal<string | null>(null)
  const sessionWorktree = createMemo(() => {
    const sessionId = options.activeSessionId()
    return sessionId && sessionId !== "info" ? getWorktreeSlugForSession(options.instanceId, sessionId) : getDefaultWorktreeSlug(options.instanceId)
  })
  createEffect(on(() => `${options.activeSessionId()}:${sessionWorktree()}`, () => {
    setBrowsedWorktree(null)
    closeFilePreview(options.instanceId)
  }))
  const slug = createMemo(() => browsedWorktree() ?? sessionWorktree())
  const worktrees = createMemo(() => getWorktrees(options.instanceId))
  const worktree = createMemo(() => worktrees().find(entry => entry.slug === slug()))
  createEffect(() => {
    // A removed browsed worktree must never silently turn into a root-file read.
    if (browsedWorktree() && worktrees().length && !worktree()) {
      setBrowsedWorktree(null)
      closeFilePreview(options.instanceId)
    }
  })
  const active = () => options.isActive() && options.rightPanelTab() === "files"
  const gitAvailable = () => getGitRepoStatus(options.instanceId) !== false
  createEffect(() => { if (!gitAvailable()) setMode("workspace") })
  const directory = () => worktree()?.directory ?? options.instance.folder
  const tree = useWorkspaceTree(options.instanceId, directory, () => active() && mode() === "workspace")
  const history = useGitHistory(options.instanceId, slug, () => active() && gitAvailable() && mode() === "history")
  const git = useGitChanges({
    ...options, isActive: () => active() && gitAvailable(), rightPanelTab: () => "git-changes",
    worktreeSlug: slug, closeGitList: () => {}, externalDiff: true,
  })
  const openFile = (file: Pick<FilePreviewTarget, "kind" | "path" | "originalPath" | "scope" | "commit" | "subject">) => {
    const sessionId = options.activeSessionId()
    if (!sessionId || sessionId === "info") return
    showSessionChat(options.instance.folder)
    openFilePreview(options.instanceId, { ...file, sessionId, slug: slug(), directory: directory() })
  }
  onCleanup(() => closeFilePreview(options.instanceId))
  return createCoreRightPanelManifest({
    renderFilesTab: () => <LazyFilesPanel t={options.t} git={git} history={history} tree={tree} gitAvailable={gitAvailable()} mode={mode()} onModeChange={setMode}
      worktrees={worktrees()} slug={slug()} directory={worktree()?.directory ?? options.instance.folder}
      branch={history.page()?.branch ?? worktree()?.branch ?? null} onWorktreeChange={value => {
        setBrowsedWorktree(value)
        closeFilePreview(options.instanceId)
      }} onOpenFile={openFile} canOpenFile={Boolean(options.activeSessionId() && options.activeSessionId() !== "info")} />,
    renderStatusTab: () => <LazyStatusTab t={options.t} instanceId={options.instanceId} instance={options.instance}
      activeSession={options.activeSession} isActive={() => options.isActive() && options.rightPanelTab() === "status"}
      expandedItems={options.expandedItems} onExpandedItemsChange={options.onExpandedItemsChange}
      customization={options.customization} onCustomizationChange={options.onCustomizationChange} extraSections={options.extraStatusSections()} />,
  })
}
