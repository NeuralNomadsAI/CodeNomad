import { createEffect, createMemo, createSignal, lazy, type Accessor } from "solid-js"
import type { ToolState } from "@opencode-ai/sdk/v2"

import type { Instance } from "../../../../types/instance"
import type { BackgroundProcess } from "../../../../../../server/src/api-types"
import type { Session } from "../../../../types/session"
import type { PromptInputApi } from "../../../prompt-input/types"
import type { DiffContextMode, DiffViewMode, DiffWordWrapMode, RightPanelTab } from "./types"
import type { RightPanelCustomization, RightPanelSectionModule } from "./registry"

import {
  getDefaultWorktreeSlug,
  getGitRepoStatus,
  getWorktreeSlugForSession,
  getWorktrees,
} from "../../../../stores/worktrees"
import { writeClientLayoutValue } from "../../../../stores/client-state"
import {
  RIGHT_PANEL_CHANGES_DIFF_CONTEXT_MODE_KEY,
  RIGHT_PANEL_CHANGES_DIFF_VIEW_MODE_KEY,
  RIGHT_PANEL_CHANGES_DIFF_WORD_WRAP_KEY,
  RIGHT_PANEL_GIT_CHANGES_LIST_OPEN_NONPHONE_KEY,
  RIGHT_PANEL_GIT_CHANGES_LIST_OPEN_PHONE_KEY,
  RIGHT_PANEL_GIT_CHANGES_SPLIT_WIDTH_KEY,
  RIGHT_PANEL_GIT_CHANGES_STAGED_OPEN_NONPHONE_KEY,
  RIGHT_PANEL_GIT_CHANGES_STAGED_OPEN_PHONE_KEY,
  RIGHT_PANEL_GIT_CHANGES_UNSTAGED_OPEN_NONPHONE_KEY,
  RIGHT_PANEL_GIT_CHANGES_UNSTAGED_OPEN_PHONE_KEY,
  readStoredBool,
  readStoredEnum,
} from "../storage"
import { useGitChanges } from "./useGitChanges"
import { createCoreRightPanelManifest } from "./core-plugin"
import { createFilesTabRuntime } from "./tabs/files-runtime"
import { createSplitResize } from "./tabs/split-resize"

const LazyGitChangesTab = lazy(() => import("./tabs/GitChangesTab"))
const LazyStatusTab = lazy(() => import("./tabs/StatusTab"))

interface CoreRightPanelRuntimeOptions {
  t: (key: string, vars?: Record<string, any>) => string
  instanceId: string
  instance: Instance
  activeSessionId: Accessor<string | null>
  activeSession: Accessor<Session | null>
  latestTodoState: Accessor<ToolState | null>
  backgroundProcessList: Accessor<BackgroundProcess[]>
  onOpenBackgroundOutput: (process: BackgroundProcess) => void
  onStopBackgroundProcess: (processId: string) => Promise<void> | void
  onTerminateBackgroundProcess: (processId: string) => Promise<void> | void
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
  const [diffViewMode, setDiffViewMode] = createSignal<DiffViewMode>(
    readStoredEnum(RIGHT_PANEL_CHANGES_DIFF_VIEW_MODE_KEY, ["split", "unified"] as const) ?? "unified",
  )
  const [diffContextMode, setDiffContextMode] = createSignal<DiffContextMode>(
    readStoredEnum(RIGHT_PANEL_CHANGES_DIFF_CONTEXT_MODE_KEY, ["expanded", "collapsed"] as const) ?? "collapsed",
  )
  const [diffWordWrapMode, setDiffWordWrapMode] = createSignal<DiffWordWrapMode>(
    readStoredEnum(RIGHT_PANEL_CHANGES_DIFF_WORD_WRAP_KEY, ["on", "off"] as const) ?? "on",
  )
  const [gitChangesListOpen, setGitChangesListOpen] = createSignal(true)
  const [gitStagedOpen, setGitStagedOpen] = createSignal(true)
  const [gitUnstagedOpen, setGitUnstagedOpen] = createSignal(true)

  const listLayoutKey = createMemo(() => (options.isPhoneLayout() ? "phone" : "nonphone"))

  const gitListOpenStorageKey = createMemo(() =>
    listLayoutKey() === "phone" ? RIGHT_PANEL_GIT_CHANGES_LIST_OPEN_PHONE_KEY : RIGHT_PANEL_GIT_CHANGES_LIST_OPEN_NONPHONE_KEY,
  )

  const gitSectionStorageKey = (section: "staged" | "unstaged") => {
    const phone = listLayoutKey() === "phone"
    if (section === "staged") {
      return phone ? RIGHT_PANEL_GIT_CHANGES_STAGED_OPEN_PHONE_KEY : RIGHT_PANEL_GIT_CHANGES_STAGED_OPEN_NONPHONE_KEY
    }
    return phone ? RIGHT_PANEL_GIT_CHANGES_UNSTAGED_OPEN_PHONE_KEY : RIGHT_PANEL_GIT_CHANGES_UNSTAGED_OPEN_NONPHONE_KEY
  }

  createEffect(() => {
    gitListOpenStorageKey()
    const gitPersisted = readStoredBool(gitListOpenStorageKey())
    if (gitPersisted !== null) {
      setGitChangesListOpen(gitPersisted)
    } else {
      setGitChangesListOpen(true)
    }

    setGitStagedOpen(readStoredBool(gitSectionStorageKey("staged")) ?? true)
    setGitUnstagedOpen(readStoredBool(gitSectionStorageKey("unstaged")) ?? true)
  })

  createEffect(() => writeClientLayoutValue(RIGHT_PANEL_CHANGES_DIFF_VIEW_MODE_KEY, diffViewMode()))
  createEffect(() => writeClientLayoutValue(RIGHT_PANEL_CHANGES_DIFF_CONTEXT_MODE_KEY, diffContextMode()))
  createEffect(() => writeClientLayoutValue(RIGHT_PANEL_CHANGES_DIFF_WORD_WRAP_KEY, diffWordWrapMode()))

  const gitChangesSplit = createSplitResize({
    storageKey: RIGHT_PANEL_GIT_CHANGES_SPLIT_WIDTH_KEY,
    defaultWidth: 320,
    rightDrawerWidth: options.rightDrawerWidth,
    rightDrawerWidthInitialized: options.rightDrawerWidthInitialized,
  })

  const worktreeSlugForViewer = createMemo(() => {
    const sessionId = options.activeSessionId()
    if (sessionId && sessionId !== "info") {
      return getWorktreeSlugForSession(options.instanceId, sessionId)
    }
    return getDefaultWorktreeSlug(options.instanceId)
  })

  const gitChangesWorktreeSlug = createMemo(() => {
    if (getGitRepoStatus(options.instanceId) === false) return null
    const slug = worktreeSlugForViewer().trim()
    return slug ? slug : null
  })

  const gitChangesWorktree = createMemo(() => {
    const slug = gitChangesWorktreeSlug()
    if (!slug) return null
    return getWorktrees(options.instanceId).find((worktree) => worktree.slug === slug) ?? null
  })

  const gitChangesBranchLabel = createMemo(() => gitChangesWorktree()?.branch?.trim() || null)
  const gitScopeKey = createMemo(() => `${options.instanceId}:git:${worktreeSlugForViewer()}`)
  const git = useGitChanges({
    t: options.t,
    instanceId: options.instanceId,
    rightPanelTab: options.rightPanelTab,
    worktreeSlug: worktreeSlugForViewer,
    isPhoneLayout: options.isPhoneLayout,
    promptInputApi: options.promptInputApi,
    closeGitList: () => setGitChangesListOpen(false),
  })
  const renderFilesTab = createFilesTabRuntime({
    t: options.t,
    instanceId: options.instanceId,
    rightPanelTab: options.rightPanelTab,
    worktreeSlug: worktreeSlugForViewer,
    isPhoneLayout: options.isPhoneLayout,
    rightDrawerWidth: options.rightDrawerWidth,
    rightDrawerWidthInitialized: options.rightDrawerWidthInitialized,
  })

  const persistGitListOpen = (value: boolean) => {
    writeClientLayoutValue(gitListOpenStorageKey(), value ? "true" : "false")
  }

  const persistGitSectionOpen = (section: "staged" | "unstaged", value: boolean) => {
    writeClientLayoutValue(gitSectionStorageKey(section), value ? "true" : "false")
  }

  const toggleGitList = () => {
    setGitChangesListOpen((current) => {
      const next = !current
      persistGitListOpen(next)
      return next
    })
  }

  return createCoreRightPanelManifest({
    renderGitChangesTab: () => (
      <LazyGitChangesTab
        t={options.t}
        activeSessionId={options.activeSessionId}
        entries={git.gitStatusEntries}
        statusLoading={git.gitStatusLoading}
        statusError={git.gitStatusError}
        selectedItemId={git.gitSelectedItemId}
        selectedBulkItemIds={git.gitBulkSelectedItemIds}
        selectedLoading={git.gitSelectedLoading}
        selectedError={git.gitSelectedError}
        selectedBefore={git.gitSelectedBefore}
        selectedAfter={git.gitSelectedAfter}
        mostChangedItemId={git.gitMostChangedItemId}
        scopeKey={gitScopeKey}
        diffViewMode={diffViewMode}
        diffContextMode={diffContextMode}
        diffWordWrapMode={diffWordWrapMode}
        onViewModeChange={setDiffViewMode}
        onContextModeChange={setDiffContextMode}
        onWordWrapModeChange={setDiffWordWrapMode}
        onRowClick={git.handleGitRowClick}
        onRefresh={() => void git.refreshGitStatus()}
        onInsertContext={git.insertGitChangeContext}
        onStageFile={git.stageGitFile}
        onUnstageFile={git.unstageGitFile}
        commitMessage={git.gitCommitMessage}
        commitSubmitting={git.gitCommitSubmitting}
        onCommitMessageInput={git.setGitCommitMessage}
        onSubmitCommit={() => void git.submitGitCommit()}
        branchLabel={gitChangesBranchLabel}
        stagedOpen={gitStagedOpen}
        unstagedOpen={gitUnstagedOpen}
        onToggleStagedOpen={() => {
          const next = !gitStagedOpen()
          setGitStagedOpen(next)
          persistGitSectionOpen("staged", next)
        }}
        onToggleUnstagedOpen={() => {
          const next = !gitUnstagedOpen()
          setGitUnstagedOpen(next)
          persistGitSectionOpen("unstaged", next)
        }}
        listOpen={gitChangesListOpen}
        onToggleList={toggleGitList}
        splitWidth={gitChangesSplit.splitWidth}
        onResizeMouseDown={gitChangesSplit.onResizeMouseDown}
        onResizeTouchStart={gitChangesSplit.onResizeTouchStart}
        isPhoneLayout={options.isPhoneLayout}
      />
    ),
    renderFilesTab,
    renderStatusTab: () => (
      <LazyStatusTab
        t={options.t}
        instanceId={options.instanceId}
        instance={options.instance}
        activeSessionId={options.activeSessionId}
        activeSession={options.activeSession}
        latestTodoState={options.latestTodoState}
        backgroundProcessList={options.backgroundProcessList}
        onOpenBackgroundOutput={options.onOpenBackgroundOutput}
        onStopBackgroundProcess={options.onStopBackgroundProcess}
        onTerminateBackgroundProcess={options.onTerminateBackgroundProcess}
        expandedItems={options.expandedItems}
        onExpandedItemsChange={options.onExpandedItemsChange}
        customization={options.customization}
        onCustomizationChange={options.onCustomizationChange}
        extraSections={options.extraStatusSections()}
      />
    ),
  })
}
