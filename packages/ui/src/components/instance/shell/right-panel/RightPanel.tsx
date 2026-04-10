import {
  Show,
  Suspense,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
  type Accessor,
  type Component,
} from "solid-js"
import type { ToolState } from "@opencode-ai/sdk/v2"
import type { FileContent, FileNode, File as GitFileStatus } from "@opencode-ai/sdk/v2/client"
import IconButton from "@suid/material/IconButton"
import MenuOpenIcon from "@suid/icons-material/MenuOpen"
import PushPinIcon from "@suid/icons-material/PushPin"
import PushPinOutlinedIcon from "@suid/icons-material/PushPinOutlined"

import type { Instance } from "../../../../types/instance"
import type { BackgroundProcess } from "../../../../../../server/src/api-types"
import type { Session } from "../../../../types/session"
import type { PromptInputApi } from "../../../prompt-input/types"
import type { DrawerViewState } from "../types"
import type {
  DiffContextMode,
  DiffViewMode,
  DiffWordWrapMode,
  GitChangeEntry,
  GitChangeListItem,
  GitSelectionDescriptor,
  RightPanelTab,
} from "./types"

import { getDefaultWorktreeSlug, getOrCreateWorktreeClient, getWorktreeSlugForSession } from "../../../../stores/worktrees"
import { requestData } from "../../../../lib/opencode-api"
import { serverApi } from "../../../../lib/api-client"
import { showConfirmDialog } from "../../../../stores/alerts"
import { showToastNotification } from "../../../../lib/notifications"
import { adaptSdkGitStatusEntries, buildGitChangeListItems } from "./git-changes-model"
import { useGlobalPointerDrag } from "../useGlobalPointerDrag"
import {
  RIGHT_PANEL_CHANGES_DIFF_CONTEXT_MODE_KEY,
  RIGHT_PANEL_CHANGES_DIFF_VIEW_MODE_KEY,
  RIGHT_PANEL_CHANGES_DIFF_WORD_WRAP_KEY,
  RIGHT_PANEL_CHANGES_LIST_OPEN_NONPHONE_KEY,
  RIGHT_PANEL_CHANGES_LIST_OPEN_PHONE_KEY,
  RIGHT_PANEL_CHANGES_SPLIT_WIDTH_KEY,
  RIGHT_PANEL_FILES_LIST_OPEN_NONPHONE_KEY,
  RIGHT_PANEL_FILES_LIST_OPEN_PHONE_KEY,
  RIGHT_PANEL_FILES_SPLIT_WIDTH_KEY,
  RIGHT_PANEL_GIT_CHANGES_LIST_OPEN_NONPHONE_KEY,
  RIGHT_PANEL_GIT_CHANGES_LIST_OPEN_PHONE_KEY,
  RIGHT_PANEL_GIT_CHANGES_STAGED_OPEN_NONPHONE_KEY,
  RIGHT_PANEL_GIT_CHANGES_STAGED_OPEN_PHONE_KEY,
  RIGHT_PANEL_GIT_CHANGES_SPLIT_WIDTH_KEY,
  RIGHT_PANEL_GIT_CHANGES_UNSTAGED_OPEN_NONPHONE_KEY,
  RIGHT_PANEL_GIT_CHANGES_UNSTAGED_OPEN_PHONE_KEY,
  RIGHT_PANEL_TAB_STORAGE_KEY,
  readStoredBool,
  readStoredEnum,
  readStoredPanelWidth,
  readStoredRightPanelTab,
} from "../storage"

const LazyChangesTab = lazy(() => import("./tabs/ChangesTab"))
const LazyGitChangesTab = lazy(() => import("./tabs/GitChangesTab"))
const LazyFilesTab = lazy(() => import("./tabs/FilesTab"))
const LazyStatusTab = lazy(() => import("./tabs/StatusTab"))

function RightPanelTabFallback() {
  return <div class="flex-1 min-h-0" />
}

interface RightPanelProps {
  t: (key: string, vars?: Record<string, any>) => string

  instanceId: string
  instance: Instance

  activeSessionId: Accessor<string | null>
  activeSession: Accessor<Session | null>
  activeSessionDiffs: Accessor<any[] | undefined>

  latestTodoState: Accessor<ToolState | null>
  backgroundProcessList: Accessor<BackgroundProcess[]>
  onOpenBackgroundOutput: (process: BackgroundProcess) => void
  onStopBackgroundProcess: (processId: string) => Promise<void> | void
  onTerminateBackgroundProcess: (processId: string) => Promise<void> | void

  isPhoneLayout: Accessor<boolean>
  rightDrawerWidth: Accessor<number>
  rightDrawerWidthInitialized: Accessor<boolean>
  rightDrawerState: Accessor<DrawerViewState>
  rightPinned: Accessor<boolean>
  onCloseRightDrawer: () => void
  onPinRightDrawer: () => void
  onUnpinRightDrawer: () => void
  promptInputApi: Accessor<PromptInputApi | null>

  setContentEl: (el: HTMLElement | null) => void
}

const RightPanel: Component<RightPanelProps> = (props) => {
  const [rightPanelTab, setRightPanelTab] = createSignal<RightPanelTab>(readStoredRightPanelTab("changes"))
  const [rightPanelExpandedItems, setRightPanelExpandedItems] = createSignal<string[]>([
    "yolo-mode",
    "plan",
    "background-processes",
    "mcp",
    "lsp",
    "plugins",
  ])
  const [selectedFile, setSelectedFile] = createSignal<string | null>(null)

  const [browserPath, setBrowserPath] = createSignal(".")
  const [browserEntries, setBrowserEntries] = createSignal<FileNode[] | null>(null)
  const [browserLoading, setBrowserLoading] = createSignal(false)
  const [browserError, setBrowserError] = createSignal<string | null>(null)
  const [browserSelectedPath, setBrowserSelectedPath] = createSignal<string | null>(null)
  const [browserSelectedContent, setBrowserSelectedContent] = createSignal<string | null>(null)
  const [browserSelectedLoading, setBrowserSelectedLoading] = createSignal(false)
  const [browserSelectedError, setBrowserSelectedError] = createSignal<string | null>(null)
  const [browserSelectedDirty, setBrowserSelectedDirty] = createSignal(false)
  const [browserSelectedSaving, setBrowserSelectedSaving] = createSignal(false)
  const [browserSelectedOriginalContent, setBrowserSelectedOriginalContent] = createSignal<string | null>(null)

  const [diffViewMode, setDiffViewMode] = createSignal<DiffViewMode>(
    readStoredEnum(RIGHT_PANEL_CHANGES_DIFF_VIEW_MODE_KEY, ["split", "unified"] as const) ?? "unified",
  )
  const [diffContextMode, setDiffContextMode] = createSignal<DiffContextMode>(
    readStoredEnum(RIGHT_PANEL_CHANGES_DIFF_CONTEXT_MODE_KEY, ["expanded", "collapsed"] as const) ?? "collapsed",
  )
  const [diffWordWrapMode, setDiffWordWrapMode] = createSignal<DiffWordWrapMode>(
    readStoredEnum(RIGHT_PANEL_CHANGES_DIFF_WORD_WRAP_KEY, ["on", "off"] as const) ?? "on",
  )

  const [changesSplitWidth, setChangesSplitWidth] = createSignal(320)
  const [filesSplitWidth, setFilesSplitWidth] = createSignal(320)
  const [gitChangesSplitWidth, setGitChangesSplitWidth] = createSignal(320)
  const [activeSplitResize, setActiveSplitResize] = createSignal<"changes" | "git-changes" | "files" | null>(null)
  const [splitResizeStartX, setSplitResizeStartX] = createSignal(0)
  const [splitResizeStartWidth, setSplitResizeStartWidth] = createSignal(0)

  const [filesListOpen, setFilesListOpen] = createSignal(true)
  const [filesListTouched, setFilesListTouched] = createSignal(false)
  const [changesListOpen, setChangesListOpen] = createSignal(true)
  const [changesListTouched, setChangesListTouched] = createSignal(false)
  const [gitChangesListOpen, setGitChangesListOpen] = createSignal(true)
  const [gitChangesListTouched, setGitChangesListTouched] = createSignal(false)
  const [gitStagedOpen, setGitStagedOpen] = createSignal(true)
  const [gitUnstagedOpen, setGitUnstagedOpen] = createSignal(true)

  const listLayoutKey = createMemo(() => (props.isPhoneLayout() ? "phone" : "nonphone"))

  const listOpenStorageKey = (tab: "changes" | "git-changes" | "files") => {
    const layout = listLayoutKey()
    if (tab === "changes") {
      return layout === "phone" ? RIGHT_PANEL_CHANGES_LIST_OPEN_PHONE_KEY : RIGHT_PANEL_CHANGES_LIST_OPEN_NONPHONE_KEY
    }
    if (tab === "git-changes") {
      return layout === "phone"
        ? RIGHT_PANEL_GIT_CHANGES_LIST_OPEN_PHONE_KEY
        : RIGHT_PANEL_GIT_CHANGES_LIST_OPEN_NONPHONE_KEY
    }
    return layout === "phone" ? RIGHT_PANEL_FILES_LIST_OPEN_PHONE_KEY : RIGHT_PANEL_FILES_LIST_OPEN_NONPHONE_KEY
  }

  const gitSectionStorageKey = (section: "staged" | "unstaged") => {
    const layout = listLayoutKey()
    if (section === "staged") {
      return layout === "phone"
        ? RIGHT_PANEL_GIT_CHANGES_STAGED_OPEN_PHONE_KEY
        : RIGHT_PANEL_GIT_CHANGES_STAGED_OPEN_NONPHONE_KEY
    }
    return layout === "phone"
      ? RIGHT_PANEL_GIT_CHANGES_UNSTAGED_OPEN_PHONE_KEY
      : RIGHT_PANEL_GIT_CHANGES_UNSTAGED_OPEN_NONPHONE_KEY
  }

  const persistListOpen = (tab: "changes" | "git-changes" | "files", value: boolean) => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(listOpenStorageKey(tab), value ? "true" : "false")
  }

  const persistGitSectionOpen = (section: "staged" | "unstaged", value: boolean) => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(gitSectionStorageKey(section), value ? "true" : "false")
  }

  createEffect(() => {
    // Refresh persisted visibility when layout changes (phone vs non-phone).
    const layout = listLayoutKey()
    layout

    const filesPersisted = readStoredBool(listOpenStorageKey("files"))
    if (filesPersisted !== null) {
      setFilesListOpen(filesPersisted)
      setFilesListTouched(true)
    } else {
      setFilesListOpen(true)
      setFilesListTouched(false)
    }

    const changesPersisted = readStoredBool(listOpenStorageKey("changes"))
    if (changesPersisted !== null) {
      setChangesListOpen(changesPersisted)
      setChangesListTouched(true)
    } else {
      setChangesListOpen(true)
      setChangesListTouched(false)
    }

    const gitPersisted = readStoredBool(listOpenStorageKey("git-changes"))
    if (gitPersisted !== null) {
      setGitChangesListOpen(gitPersisted)
      setGitChangesListTouched(true)
    } else {
      setGitChangesListOpen(true)
      setGitChangesListTouched(false)
    }

    const stagedPersisted = readStoredBool(gitSectionStorageKey("staged"))
    setGitStagedOpen(stagedPersisted ?? true)

    const unstagedPersisted = readStoredBool(gitSectionStorageKey("unstaged"))
    setGitUnstagedOpen(unstagedPersisted ?? true)
  })

  createEffect(() => {
    // Default behavior: when nothing is selected, keep the file list open.
    // Once the user explicitly toggles it, we stop auto-opening.
    if (rightPanelTab() !== "files") return
    if (filesListTouched()) return
    if (!browserSelectedPath()) {
      setFilesListOpen(true)
    }
  })

  createEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(RIGHT_PANEL_TAB_STORAGE_KEY, rightPanelTab())
  })

  createEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(RIGHT_PANEL_CHANGES_DIFF_VIEW_MODE_KEY, diffViewMode())
  })

  createEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(RIGHT_PANEL_CHANGES_DIFF_CONTEXT_MODE_KEY, diffContextMode())
  })

  createEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(RIGHT_PANEL_CHANGES_DIFF_WORD_WRAP_KEY, diffWordWrapMode())
  })

  const clampSplitWidth = (value: number) => {
    const min = 200
    const maxByDrawer = Math.max(min, Math.floor(props.rightDrawerWidth() * 0.65))
    const max = Math.min(560, maxByDrawer)
    return Math.min(max, Math.max(min, Math.floor(value)))
  }

  const [splitWidthsInitialized, setSplitWidthsInitialized] = createSignal(false)

  createEffect(() => {
    if (splitWidthsInitialized()) return
    if (!props.rightDrawerWidthInitialized()) return
    setSplitWidthsInitialized(true)
    setChangesSplitWidth(clampSplitWidth(readStoredPanelWidth(RIGHT_PANEL_CHANGES_SPLIT_WIDTH_KEY, 320)))
    setFilesSplitWidth(clampSplitWidth(readStoredPanelWidth(RIGHT_PANEL_FILES_SPLIT_WIDTH_KEY, 320)))
    setGitChangesSplitWidth(clampSplitWidth(readStoredPanelWidth(RIGHT_PANEL_GIT_CHANGES_SPLIT_WIDTH_KEY, 320)))
  })

  const persistSplitWidth = (mode: "changes" | "git-changes" | "files", width: number) => {
    if (typeof window === "undefined") return
    const key =
      mode === "changes"
        ? RIGHT_PANEL_CHANGES_SPLIT_WIDTH_KEY
        : mode === "git-changes"
          ? RIGHT_PANEL_GIT_CHANGES_SPLIT_WIDTH_KEY
          : RIGHT_PANEL_FILES_SPLIT_WIDTH_KEY
    window.localStorage.setItem(key, String(width))
  }

  function stopSplitResize() {
    setActiveSplitResize(null)
    if (typeof document === "undefined") return
    splitPointerDrag.stop()
  }

  function splitMouseMove(event: MouseEvent) {
    const mode = activeSplitResize()
    if (!mode) return
    event.preventDefault()
    const isRtl = typeof document !== "undefined" && document.documentElement.dir === "rtl"
    const delta = (event.clientX - splitResizeStartX()) * (isRtl ? -1 : 1)
    const next = clampSplitWidth(splitResizeStartWidth() + delta)
    if (mode === "changes") setChangesSplitWidth(next)
    else if (mode === "git-changes") setGitChangesSplitWidth(next)
    else setFilesSplitWidth(next)
  }

  function splitMouseUp() {
    const mode = activeSplitResize()
    if (mode) {
      const width =
        mode === "changes" ? changesSplitWidth() : mode === "git-changes" ? gitChangesSplitWidth() : filesSplitWidth()
      persistSplitWidth(mode, width)
    }
    stopSplitResize()
  }

  function splitTouchMove(event: TouchEvent) {
    const mode = activeSplitResize()
    if (!mode) return
    const touch = event.touches[0]
    if (!touch) return
    event.preventDefault()
    const isRtl = typeof document !== "undefined" && document.documentElement.dir === "rtl"
    const delta = (touch.clientX - splitResizeStartX()) * (isRtl ? -1 : 1)
    const next = clampSplitWidth(splitResizeStartWidth() + delta)
    if (mode === "changes") setChangesSplitWidth(next)
    else if (mode === "git-changes") setGitChangesSplitWidth(next)
    else setFilesSplitWidth(next)
  }

  function splitTouchEnd() {
    const mode = activeSplitResize()
    if (mode) {
      const width =
        mode === "changes" ? changesSplitWidth() : mode === "git-changes" ? gitChangesSplitWidth() : filesSplitWidth()
      persistSplitWidth(mode, width)
    }
    stopSplitResize()
  }

  const splitPointerDrag = useGlobalPointerDrag({
    onMouseMove: splitMouseMove,
    onMouseUp: splitMouseUp,
    onTouchMove: splitTouchMove,
    onTouchEnd: splitTouchEnd,
  })

  const startSplitResize = (mode: "changes" | "git-changes" | "files", clientX: number) => {
    if (typeof document === "undefined") return
    setActiveSplitResize(mode)
    setSplitResizeStartX(clientX)
    setSplitResizeStartWidth(
      mode === "changes" ? changesSplitWidth() : mode === "git-changes" ? gitChangesSplitWidth() : filesSplitWidth(),
    )
    splitPointerDrag.start()
  }

  const handleSplitResizeMouseDown = (mode: "changes" | "git-changes" | "files") => (event: MouseEvent) => {
    event.preventDefault()
    startSplitResize(mode, event.clientX)
  }

  const handleSplitResizeTouchStart = (mode: "changes" | "git-changes" | "files") => (event: TouchEvent) => {
    const touch = event.touches[0]
    if (!touch) return
    event.preventDefault()
    startSplitResize(mode, touch.clientX)
  }

  onCleanup(() => {
    stopSplitResize()
  })

  const worktreeSlugForViewer = createMemo(() => {
    const sessionId = props.activeSessionId()
    if (sessionId && sessionId !== "info") {
      return getWorktreeSlugForSession(props.instanceId, sessionId)
    }
    return getDefaultWorktreeSlug(props.instanceId)
  })

  const browserClient = createMemo(() => getOrCreateWorktreeClient(props.instanceId, worktreeSlugForViewer()))

  const [gitStatusEntries, setGitStatusEntries] = createSignal<GitChangeEntry[] | null>(null)
  const [gitStatusLoading, setGitStatusLoading] = createSignal(false)
  const [gitStatusError, setGitStatusError] = createSignal<string | null>(null)
  const [gitSelectedItemId, setGitSelectedItemId] = createSignal<string | null>(null)
  const [gitSelectedLoading, setGitSelectedLoading] = createSignal(false)
  const [gitSelectedError, setGitSelectedError] = createSignal<string | null>(null)
  const [gitSelectedBefore, setGitSelectedBefore] = createSignal<string | null>(null)
  const [gitSelectedAfter, setGitSelectedAfter] = createSignal<string | null>(null)
  const [gitCommitMessage, setGitCommitMessage] = createSignal("")
  const [gitCommitSubmitting, setGitCommitSubmitting] = createSignal(false)
  let gitStatusRequestVersion = 0
  let passiveGitRefreshInFlight = false

  const gitListItems = createMemo(() => buildGitChangeListItems(gitStatusEntries()))

  const describeGitSelection = (itemId: string | null): GitSelectionDescriptor => {
    if (!itemId) {
      return { itemId: null, path: null, section: null }
    }
    const match = gitListItems().find((item) => item.id === itemId) ?? null
    return {
      itemId,
      path: match?.path ?? null,
      section: match?.section ?? null,
    }
  }

  const resolveValidGitSelection = (selection: GitSelectionDescriptor): string | null => {
    const items = gitListItems()
    if (items.length === 0) return null
    if (selection.itemId && items.some((item) => item.id === selection.itemId)) return selection.itemId
    if (selection.path && selection.section) {
      const oppositeSection = selection.section === "staged" ? "unstaged" : "staged"
      const moved = items.find((item) => item.path === selection.path && item.section === oppositeSection)
      if (moved) return moved.id
      const samePath = items.find((item) => item.path === selection.path)
      if (samePath) return samePath.id
    }
    return gitMostChangedPath()
  }

  const describeGitSelectionFingerprint = (itemId: string | null) => {
    if (!itemId) return null
    const item = gitListItems().find((entry) => entry.id === itemId) ?? null
    if (!item) return null
    return `${item.path}::${item.section}::${item.status}::${item.additions}::${item.deletions}`
  }

  const insertGitChangeContext = (item: GitChangeListItem, selection: { startLine: number; endLine: number } | null) => {
    const startLine = selection?.startLine ?? 1
    const endLine = selection?.endLine ?? startLine
    const comment = `<!-- Git change context: ${item.path} lines ${startLine}-${endLine} -->`
    props.promptInputApi()?.insertComment(comment)
  }

  const gitSelectedItem = createMemo(() => {
    const selectedId = gitSelectedItemId()
    if (!selectedId) return null
    return gitListItems().find((item) => item.id === selectedId) ?? null
  })

  const gitMostChangedPath = createMemo<string | null>(() => {
    const items = gitListItems()
    if (items.length === 0) return null
    const candidates = items.filter((item) => item && item.status !== "deleted")
    if (candidates.length === 0) return null
    const best = candidates.reduce((currentBest, item) => {
      const bestScore = (currentBest?.additions ?? 0) + (currentBest?.deletions ?? 0)
      const score = (item?.additions ?? 0) + (item?.deletions ?? 0)
      if (score > bestScore) return item
      if (score < bestScore) return currentBest
      return String(item.id || "").localeCompare(String(currentBest?.id || "")) < 0 ? item : currentBest
    }, candidates[0])
    return typeof best?.id === "string" ? best.id : null
  })

  createEffect(() => {
    // Reset tab state when worktree context changes.
    worktreeSlugForViewer()
    setBrowserPath(".")
    setBrowserEntries(null)
    setBrowserError(null)
    setBrowserSelectedPath(null)
    setBrowserSelectedContent(null)
    setBrowserSelectedError(null)
    setBrowserSelectedLoading(false)

    setGitStatusEntries(null)
    setGitStatusError(null)
    setGitStatusLoading(false)
    setGitSelectedItemId(null)
    setGitSelectedLoading(false)
    setGitSelectedError(null)
    setGitSelectedBefore(null)
    setGitSelectedAfter(null)
    setGitCommitMessage("")
    setGitCommitSubmitting(false)
  })

  const loadGitStatus = async (force = false) => {
    if (!force && gitStatusEntries() !== null) return
    const requestVersion = ++gitStatusRequestVersion
    setGitStatusLoading(true)
    setGitStatusError(null)
    try {
      const list = await requestData<GitFileStatus[]>(browserClient().file.status(), "file.status")
      const detailList = await serverApi.fetchWorktreeGitStatus(props.instanceId, worktreeSlugForViewer())
      if (requestVersion !== gitStatusRequestVersion) return
      setGitStatusEntries(adaptSdkGitStatusEntries(list, detailList))
    } catch (error) {
      if (requestVersion !== gitStatusRequestVersion) return
      setGitStatusError(error instanceof Error ? error.message : "Failed to load git status")
      setGitStatusEntries([])
    } finally {
      if (requestVersion !== gitStatusRequestVersion) return
      setGitStatusLoading(false)
    }
  }

  const clearSelectedGitDiff = () => {
    setGitSelectedError(null)
    setGitSelectedBefore(null)
    setGitSelectedAfter(null)
  }

  const passiveRefreshGitStatus = async () => {
    if (rightPanelTab() !== "git-changes") return
    if (passiveGitRefreshInFlight) return
    if (gitCommitSubmitting()) return

    passiveGitRefreshInFlight = true
    const previousSelection = describeGitSelection(gitSelectedItemId())
    const previousFingerprint = describeGitSelectionFingerprint(previousSelection.itemId)
    const hadSelectedDiff =
      previousSelection.itemId !== null &&
      (gitSelectedBefore() !== null || gitSelectedAfter() !== null || gitSelectedError() !== null)

    try {
      await loadGitStatus(true)
      const nextSelection = resolveValidGitSelection(previousSelection)
      setGitSelectedItemId(nextSelection)

      if (!nextSelection) {
        clearSelectedGitDiff()
        return
      }

      const nextFingerprint = describeGitSelectionFingerprint(nextSelection)
      if (!hadSelectedDiff || previousFingerprint !== nextFingerprint) {
        await openGitFile(nextSelection)
      }
    } finally {
      passiveGitRefreshInFlight = false
    }
  }

  const mutateGitFile = async (item: GitChangeListItem, action: "stage" | "unstage") => {
    const currentSelection = describeGitSelection(gitSelectedItemId())
    const fallbackSelection = currentSelection.path === item.path ? currentSelection : describeGitSelection(item.id)
    try {
      if (action === "stage") {
        await serverApi.stageWorktreeGitPaths(props.instanceId, worktreeSlugForViewer(), { paths: [item.path] })
      } else {
        await serverApi.unstageWorktreeGitPaths(props.instanceId, worktreeSlugForViewer(), { paths: [item.path] })
      }

      await loadGitStatus(true)
      const nextSelection = resolveValidGitSelection(fallbackSelection)
      setGitSelectedItemId(nextSelection)
      if (nextSelection) {
        await openGitFile(nextSelection)
      } else {
        setGitSelectedError(null)
        setGitSelectedBefore(null)
        setGitSelectedAfter(null)
      }
    } catch (error) {
      showToastNotification({
        message: error instanceof Error ? error.message : `Failed to ${action} file`,
        variant: "error",
      })
    }
  }

  const submitGitCommit = async () => {
    const message = gitCommitMessage().trim()
    if (!message || gitCommitSubmitting()) return

    setGitCommitSubmitting(true)
    try {
      await serverApi.commitWorktreeGitChanges(props.instanceId, worktreeSlugForViewer(), { message })
      setGitCommitMessage("")
      await loadGitStatus(true)
      const nextSelection = resolveValidGitSelection(describeGitSelection(gitSelectedItemId()))
      setGitSelectedItemId(nextSelection)
      if (nextSelection) {
        await openGitFile(nextSelection)
      } else {
        setGitSelectedError(null)
        setGitSelectedBefore(null)
        setGitSelectedAfter(null)
      }
      showToastNotification({
        message: props.t("instanceShell.gitChanges.commit.success"),
        variant: "success",
      })
    } catch (error) {
      showToastNotification({
        message: error instanceof Error ? error.message : props.t("instanceShell.gitChanges.commit.error"),
        variant: "error",
      })
    } finally {
      setGitCommitSubmitting(false)
    }
  }

  async function openGitFile(itemId: string) {
    setGitSelectedItemId(itemId)
    setGitSelectedLoading(true)
    setGitSelectedError(null)
    setGitSelectedBefore(null)
    setGitSelectedAfter(null)

    const item = gitListItems().find((entry) => entry.id === itemId) || null
    if (!item) {
      setGitSelectedItemId(null)
      setGitSelectedError(null)
      setGitSelectedLoading(false)
      return
    }

    // Phone: treat file selection as a commit action and close the overlay.
    if (props.isPhoneLayout()) {
      setGitChangesListOpen(false)
    }

    try {
      const path = item?.path ?? ""
      const diff = await serverApi.fetchWorktreeGitDiff(props.instanceId, worktreeSlugForViewer(), path, item?.section ?? "unstaged")
      if (diff.isBinary) {
        setGitSelectedError(props.t("instanceShell.gitChanges.binaryViewer"))
        return
      }
      setGitSelectedBefore(diff.before)
      setGitSelectedAfter(diff.after)
    } catch (error) {
      setGitSelectedError(error instanceof Error ? error.message : "Failed to load file changes")
    } finally {
      setGitSelectedLoading(false)
    }
  }

  createEffect(() => {
    if (rightPanelTab() !== "git-changes") return
    const items = gitListItems()
    if (gitStatusEntries() === null) return
    if (items.length === 0) return
    if (gitSelectedItemId()) return
    const next = gitMostChangedPath()
    if (!next) return
    void openGitFile(next)
  })

  const refreshGitStatus = async () => {
    await loadGitStatus(true)
    const selected = resolveValidGitSelection(describeGitSelection(gitSelectedItemId()))
    setGitSelectedItemId(selected)
    if (selected) {
      void openGitFile(selected)
    } else {
      clearSelectedGitDiff()
    }
  }

  const bestDiffFile = createMemo<string | null>(() => {
    const diffs = props.activeSessionDiffs()
    if (!Array.isArray(diffs) || diffs.length === 0) return null
    const best = diffs.reduce((currentBest, item) => {
      const bestAdd = typeof (currentBest as any)?.additions === "number" ? (currentBest as any).additions : 0
      const bestDel = typeof (currentBest as any)?.deletions === "number" ? (currentBest as any).deletions : 0
      const bestScore = bestAdd + bestDel

      const add = typeof (item as any)?.additions === "number" ? (item as any).additions : 0
      const del = typeof (item as any)?.deletions === "number" ? (item as any).deletions : 0
      const score = add + del

      if (score > bestScore) return item
      if (score < bestScore) return currentBest
      return String(item.file || "").localeCompare(String((currentBest as any)?.file || "")) < 0 ? item : currentBest
    }, diffs[0])
    return typeof (best as any)?.file === "string" ? (best as any).file : null
  })

  createEffect(() => {
    const next = bestDiffFile()
    if (!next) return
    const diffs = props.activeSessionDiffs()
    if (!Array.isArray(diffs) || diffs.length === 0) return

    const current = selectedFile()
    if (current && diffs.some((d) => d.file === current)) return
    setSelectedFile(next)
  })

  const normalizeBrowserPath = (input: string) => {
    const raw = String(input || ".").trim()
    if (!raw || raw === "./") return "."
    const cleaned = raw.replace(/\\/g, "/").replace(/\/+$/, "")
    return cleaned === "" ? "." : cleaned
  }

  const getParentPath = (path: string): string | null => {
    const current = normalizeBrowserPath(path)
    if (current === ".") return null
    const parts = current.split("/").filter(Boolean)
    parts.pop()
    return parts.length ? parts.join("/") : "."
  }

  const loadBrowserEntries = async (path: string) => {
    const normalized = normalizeBrowserPath(path)
    setBrowserLoading(true)
    setBrowserError(null)
    try {
      const nodes = await requestData<FileNode[]>(browserClient().file.list({ path: normalized }), "file.list")
      setBrowserPath(normalized)
      setBrowserEntries(Array.isArray(nodes) ? nodes : [])
    } catch (error) {
      setBrowserError(error instanceof Error ? error.message : "Failed to load files")
      setBrowserEntries([])
    } finally {
      setBrowserLoading(false)
    }
  }

  const openBrowserFile = async (path: string) => {
    setBrowserSelectedPath(path)
    setBrowserSelectedLoading(true)
    setBrowserSelectedError(null)
    setBrowserSelectedContent(null)
    setBrowserSelectedDirty(false)
    setBrowserSelectedOriginalContent(null)

    // Phone: treat file selection as a commit action and close the overlay.
    if (props.isPhoneLayout()) {
      setFilesListOpen(false)
    }
    try {
      const content = await requestData<FileContent>(browserClient().file.read({ path }), "file.read")
      const type = (content as any)?.type
      const encoding = (content as any)?.encoding
      if (type && type !== "text") {
        throw new Error("Binary file cannot be displayed")
      }
      if (encoding === "base64") {
        throw new Error("Binary file cannot be displayed")
      }
      const text = (content as any)?.content
      if (typeof text !== "string") {
        throw new Error("Unsupported file type")
      }
      setBrowserSelectedContent(text)
      setBrowserSelectedOriginalContent(text) // Track original content for conflict detection
    } catch (error) {
      setBrowserSelectedError(error instanceof Error ? error.message : "Failed to read file")
    } finally {
      setBrowserSelectedLoading(false)
    }
  }

  const saveBrowserFile = async (content: string): Promise<boolean> => {
    const path = browserSelectedPath()
    if (!path) return false

    // Check for conflict: agent edited file while user was editing
    const originalContent = browserSelectedOriginalContent()
    if (originalContent !== null) {
      try {
        const currentDiskContent = await requestData<FileContent>(
          browserClient().file.read({ path }),
          "file.read",
        )
        const diskContent = (currentDiskContent as any)?.content

        // If disk content differs from what we originally loaded (agent edit)
        // AND differs from user's current edits, we have a conflict
        if (diskContent !== originalContent && diskContent !== content) {
          const confirmed = await showConfirmDialog(
            props.t("instanceShell.rightPanel.actions.conflict.message", { path }),
            {
              variant: "warning",
              confirmLabel: props.t("instanceShell.rightPanel.actions.conflict.confirmLabel"),
              cancelLabel: props.t("instanceShell.rightPanel.actions.conflict.cancelLabel"),
              dismissible: false,
            },
          )
          if (!confirmed) {
            return false
          }
          // User chose to overwrite, proceed with save
        }
      } catch {
        // If we can't check for conflict, proceed with save
      }
    }

    setBrowserSelectedSaving(true)
    try {
      await serverApi.writeWorkspaceFile(props.instanceId, path, content)
      setBrowserSelectedContent(content)
      setBrowserSelectedOriginalContent(content) // Update original to match saved
      setBrowserSelectedDirty(false)
      showToastNotification({
        message: props.t("instanceShell.rightPanel.toast.saveSuccess"),
        variant: "success",
      })
      return true
    } catch (error) {
      setBrowserSelectedError(error instanceof Error ? error.message : "Failed to save file")
      showToastNotification({
        message: props.t("instanceShell.rightPanel.toast.saveError"),
        variant: "error",
      })
      return false
    } finally {
      setBrowserSelectedSaving(false)
    }
  }

  const handleBrowserFileChange = (content: string) => {
    setBrowserSelectedContent(content)
    setBrowserSelectedDirty(true)
  }

  const handleOpenBrowserFileRequest = async (path: string) => {
    if (browserSelectedDirty()) {
      const confirmed = await showConfirmDialog(
        props.t("instanceShell.rightPanel.actions.saveConfirm.message", { path: browserSelectedPath() || "" }),
        {
          variant: "warning",
          confirmLabel: props.t("instanceShell.rightPanel.actions.saveConfirm.confirmLabel"),
          cancelLabel: props.t("instanceShell.rightPanel.actions.saveConfirm.cancelLabel"),
          dismissible: false,
        },
      )
      if (confirmed) {
        const saveSuccess = await saveBrowserFile(browserSelectedContent() || "")
        if (!saveSuccess) {
          // Save failed - stay on current file, error toast already shown
          return
        }
      } else {
        // User chose not to save - clear dirty state and discard edits
        setBrowserSelectedDirty(false)
      }
    }
    await openBrowserFile(path)
  }

  createEffect(() => {
    if (rightPanelTab() !== "files") return
    if (browserLoading()) return
    if (browserEntries() !== null) return
    void loadBrowserEntries(browserPath())
  })

  createEffect(() => {
    if (rightPanelTab() === "files") return
    setBrowserSelectedContent(null)
    setBrowserSelectedLoading(false)
    setBrowserSelectedError(null)
    setBrowserSelectedDirty(false)
  })

  createEffect(() => {
    if (rightPanelTab() !== "git-changes") return
    void passiveRefreshGitStatus()
  })

  createEffect(() => {
    if (rightPanelTab() === "git-changes") return
    setGitSelectedBefore(null)
    setGitSelectedAfter(null)
    setGitSelectedLoading(false)
    setGitSelectedError(null)
  })

  const handleSelectChangesFile = (file: string, closeList: boolean) => {
    setSelectedFile(file)
    if (closeList) {
      setChangesListOpen(false)
    }
  }

  const toggleChangesList = () => {
    setChangesListTouched(true)
    setChangesListOpen((current) => {
      const next = !current
      persistListOpen("changes", next)
      return next
    })
  }

  const toggleFilesList = () => {
    setFilesListTouched(true)
    setFilesListOpen((current) => {
      const next = !current
      persistListOpen("files", next)
      return next
    })
  }

  const toggleGitList = () => {
    setGitChangesListTouched(true)
    setGitChangesListOpen((current) => {
      const next = !current
      persistListOpen("git-changes", next)
      return next
    })
  }

  const refreshFilesTab = async () => {
    // Prompt for confirmation if file has unsaved changes
    if (browserSelectedDirty()) {
      const confirmed = await showConfirmDialog(
        props.t("instanceShell.rightPanel.actions.refreshDirty.message"),
        {
          variant: "warning",
          confirmLabel: props.t("instanceShell.rightPanel.actions.refreshDirty.confirmLabel"),
          cancelLabel: props.t("instanceShell.rightPanel.actions.refreshDirty.cancelLabel"),
          dismissible: false,
        },
      )
      if (!confirmed) {
        return
      }
    }

    void loadBrowserEntries(browserPath())
    const selected = browserSelectedPath()
    if (selected) {
      // Refresh file content without altering overlay state.
      setBrowserSelectedLoading(true)
      setBrowserSelectedError(null)
      try {
        const content = await requestData<FileContent>(browserClient().file.read({ path: selected }), "file.read")
        const type = (content as any)?.type
        const encoding = (content as any)?.encoding
        if (type && type !== "text") {
          throw new Error("Binary file cannot be displayed")
        }
        if (encoding === "base64") {
          throw new Error("Binary file cannot be displayed")
        }
        const text = (content as any)?.content
        if (typeof text !== "string") {
          throw new Error("Unsupported file type")
        }
        setBrowserSelectedContent(text)
        setBrowserSelectedOriginalContent(text) // Update original content after refresh
        setBrowserSelectedDirty(false) // Clear dirty after refresh
      } catch (error) {
        setBrowserSelectedError(error instanceof Error ? error.message : "Failed to read file")
      } finally {
        setBrowserSelectedLoading(false)
      }
    }
  }

  const browserParentPath = createMemo(() => getParentPath(browserPath()))
  const browserScopeKey = createMemo(() => `${props.instanceId}:${worktreeSlugForViewer()}`)
  const gitScopeKey = createMemo(() => `${props.instanceId}:git:${worktreeSlugForViewer()}`)

  const openChangesTabFromStatus = (file?: string) => {
    if (file) {
      setSelectedFile(file)
    }
    setRightPanelTab("changes")
  }

  const statusSectionIds = ["yolo-mode", "session-changes", "plan", "background-processes", "mcp", "lsp", "plugins"]

  createEffect(() => {
    const currentExpanded = new Set(rightPanelExpandedItems())
    if (statusSectionIds.every((id) => currentExpanded.has(id))) return
    setRightPanelExpandedItems(statusSectionIds)
  })

  const handleAccordionChange = (values: string[]) => {
    setRightPanelExpandedItems(values)
  }

  const tabClass = (tab: RightPanelTab) =>
    `right-panel-tab ${rightPanelTab() === tab ? "right-panel-tab-active" : "right-panel-tab-inactive"}`

  return (
    <div class="flex flex-col h-full" ref={props.setContentEl}>
      <div class="right-panel-tab-bar">
        <div class="tab-container">
          <div class="tab-strip-shortcuts text-primary">
            <Show when={props.rightDrawerState() === "floating-open"}>
              <IconButton
                size="small"
                color="inherit"
                aria-label={props.t("instanceShell.rightDrawer.toggle.close")}
                title={props.t("instanceShell.rightDrawer.toggle.close")}
                onClick={props.onCloseRightDrawer}
              >
                <MenuOpenIcon fontSize="small" sx={{ transform: "scaleX(-1)" }} />
              </IconButton>
            </Show>
            <Show when={!props.isPhoneLayout()}>
              <IconButton
                size="small"
                color="inherit"
                aria-label={props.rightPinned() ? props.t("instanceShell.rightDrawer.unpin") : props.t("instanceShell.rightDrawer.pin")}
                onClick={() => (props.rightPinned() ? props.onUnpinRightDrawer() : props.onPinRightDrawer())}
              >
                {props.rightPinned() ? <PushPinIcon fontSize="small" /> : <PushPinOutlinedIcon fontSize="small" />}
              </IconButton>
            </Show>
          </div>
          <div class="tab-scroll">
            <div class="tab-strip">
              <div class="tab-strip-tabs" role="tablist" aria-label={props.t("instanceShell.rightPanel.tabs.ariaLabel")}> 
                <button
                  type="button"
                  role="tab"
                  class={tabClass("changes")}
                  aria-selected={rightPanelTab() === "changes"}
                  onClick={() => setRightPanelTab("changes")}
                >
                  <span class="tab-label">{props.t("instanceShell.rightPanel.tabs.changes")}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  class={tabClass("git-changes")}
                  aria-selected={rightPanelTab() === "git-changes"}
                  onClick={() => setRightPanelTab("git-changes")}
                >
                  <span class="tab-label">{props.t("instanceShell.rightPanel.tabs.gitChanges")}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  class={tabClass("files")}
                  aria-selected={rightPanelTab() === "files"}
                  onClick={() => setRightPanelTab("files")}
                >
                  <span class="tab-label">{props.t("instanceShell.rightPanel.tabs.files")}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  class={tabClass("status")}
                  aria-selected={rightPanelTab() === "status"}
                  onClick={() => setRightPanelTab("status")}
                >
                  <span class="tab-label">{props.t("instanceShell.rightPanel.tabs.status")}</span>
                </button>
              </div>

              <div class="tab-strip-spacer" />
            </div>
          </div>
        </div>
      </div>

      <div class="flex-1 overflow-y-auto">
        <Show when={rightPanelTab() === "changes"}>
          <Suspense fallback={<RightPanelTabFallback />}>
            <LazyChangesTab
              t={props.t}
              instanceId={props.instanceId}
              activeSessionId={props.activeSessionId}
              activeSessionDiffs={props.activeSessionDiffs}
              selectedFile={selectedFile}
              onSelectFile={handleSelectChangesFile}
              diffViewMode={diffViewMode}
              diffContextMode={diffContextMode}
              diffWordWrapMode={diffWordWrapMode}
              onViewModeChange={setDiffViewMode}
              onContextModeChange={setDiffContextMode}
              onWordWrapModeChange={setDiffWordWrapMode}
              listOpen={changesListOpen}
              onToggleList={toggleChangesList}
              splitWidth={changesSplitWidth}
              onResizeMouseDown={handleSplitResizeMouseDown("changes")}
              onResizeTouchStart={handleSplitResizeTouchStart("changes")}
              isPhoneLayout={props.isPhoneLayout}
            />
          </Suspense>
        </Show>

        <Show when={rightPanelTab() === "git-changes"}>
          <Suspense fallback={<RightPanelTabFallback />}>
            <LazyGitChangesTab
              t={props.t}
              activeSessionId={props.activeSessionId}
              entries={gitStatusEntries}
              statusLoading={gitStatusLoading}
              statusError={gitStatusError}
              selectedItemId={gitSelectedItemId}
              selectedLoading={gitSelectedLoading}
              selectedError={gitSelectedError}
              selectedBefore={gitSelectedBefore}
              selectedAfter={gitSelectedAfter}
              mostChangedItemId={gitMostChangedPath}
              scopeKey={gitScopeKey}
              diffViewMode={diffViewMode}
              diffContextMode={diffContextMode}
              diffWordWrapMode={diffWordWrapMode}
              onViewModeChange={setDiffViewMode}
              onContextModeChange={setDiffContextMode}
              onWordWrapModeChange={setDiffWordWrapMode}
              onOpenFile={(path: string) => void openGitFile(path)}
              onRefresh={() => void refreshGitStatus()}
              onInsertContext={insertGitChangeContext}
              onStageFile={(item) => void mutateGitFile(item, "stage")}
              onUnstageFile={(item) => void mutateGitFile(item, "unstage")}
              commitMessage={gitCommitMessage}
              commitSubmitting={gitCommitSubmitting}
              onCommitMessageInput={setGitCommitMessage}
              onSubmitCommit={() => void submitGitCommit()}
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
              splitWidth={gitChangesSplitWidth}
              onResizeMouseDown={handleSplitResizeMouseDown("git-changes")}
              onResizeTouchStart={handleSplitResizeTouchStart("git-changes")}
              isPhoneLayout={props.isPhoneLayout}
            />
          </Suspense>
        </Show>

        <Show when={rightPanelTab() === "files"}>
          <Suspense fallback={<RightPanelTabFallback />}>
            <LazyFilesTab
              t={props.t}
              browserPath={browserPath}
              browserEntries={browserEntries}
              browserLoading={browserLoading}
              browserError={browserError}
              browserSelectedPath={browserSelectedPath}
              browserSelectedContent={browserSelectedContent}
              browserSelectedLoading={browserSelectedLoading}
              browserSelectedError={browserSelectedError}
              browserSelectedDirty={browserSelectedDirty}
              browserSelectedSaving={browserSelectedSaving}
              parentPath={browserParentPath}
              scopeKey={browserScopeKey}
              onLoadEntries={(path: string) => void loadBrowserEntries(path)}
              onRequestOpenFile={(path: string) => void handleOpenBrowserFileRequest(path)}
              onRefresh={() => void refreshFilesTab()}
              onSave={(content: string) => void saveBrowserFile(content)}
              onContentChange={(content: string) => handleBrowserFileChange(content)}
              listOpen={filesListOpen}
              onToggleList={toggleFilesList}
              splitWidth={filesSplitWidth}
              onResizeMouseDown={handleSplitResizeMouseDown("files")}
              onResizeTouchStart={handleSplitResizeTouchStart("files")}
              isPhoneLayout={props.isPhoneLayout}
            />
          </Suspense>
        </Show>

        <Show when={rightPanelTab() === "status"}>
          <Suspense fallback={<RightPanelTabFallback />}>
            <LazyStatusTab
              t={props.t}
              instanceId={props.instanceId}
              instance={props.instance}
              activeSessionId={props.activeSessionId}
              activeSession={props.activeSession}
              activeSessionDiffs={props.activeSessionDiffs}
              latestTodoState={props.latestTodoState}
              backgroundProcessList={props.backgroundProcessList}
              onOpenBackgroundOutput={props.onOpenBackgroundOutput}
              onStopBackgroundProcess={props.onStopBackgroundProcess}
              onTerminateBackgroundProcess={props.onTerminateBackgroundProcess}
              expandedItems={rightPanelExpandedItems}
              onExpandedItemsChange={handleAccordionChange}
              onOpenChangesTab={openChangesTabFromStatus}
            />
          </Suspense>
        </Show>
      </div>
    </div>
  )
}

export default RightPanel
