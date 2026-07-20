import {
  For,
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
import type { FileContent, FileNode } from "@opencode-ai/sdk/v2/client"
import IconButton from "@suid/material/IconButton"
import MenuOpenIcon from "@suid/icons-material/MenuOpen"
import PushPinIcon from "@suid/icons-material/PushPin"
import PushPinOutlinedIcon from "@suid/icons-material/PushPinOutlined"
import { Settings2 } from "lucide-solid"

import type { Instance } from "../../../../types/instance"
import type { BackgroundProcess } from "../../../../../../server/src/api-types"
import type { Session } from "../../../../types/session"
import type { PromptInputApi } from "../../../prompt-input/types"
import type { DrawerViewState } from "../types"
import type { DiffContextMode, DiffViewMode, DiffWordWrapMode, RightPanelTab } from "./types"

import {
  getDefaultWorktreeSlug,
  getGitRepoStatus,
  getWorktreeSlugForSession,
  getWorktrees,
} from "../../../../stores/worktrees"
import { getRootClient } from "../../../../stores/opencode-client"
import { getOpenCodeWorkspaceIdForWorktree } from "../../../../stores/opencode-workspaces"
import { requestData } from "../../../../lib/opencode-api"
import { serverApi } from "../../../../lib/api-client"
import { showConfirmDialog } from "../../../../stores/alerts"
import { showToastNotification } from "../../../../lib/notifications"
import { readClientLayoutValue, writeClientLayoutValue } from "../../../../stores/client-state"
import { useGlobalPointerDrag } from "../useGlobalPointerDrag"
import { useGitChanges } from "./useGitChanges"
import {
  RIGHT_PANEL_CHANGES_DIFF_CONTEXT_MODE_KEY,
  RIGHT_PANEL_CHANGES_DIFF_VIEW_MODE_KEY,
  RIGHT_PANEL_CHANGES_DIFF_WORD_WRAP_KEY,
  RIGHT_PANEL_FILES_WORD_WRAP_KEY,
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
  RIGHT_PANEL_CUSTOMIZATION_STORAGE_KEY,
  RIGHT_PANEL_TAB_STORAGE_KEY,
  readStoredBool,
  readStoredEnum,
  readStoredPanelWidth,
  readStoredRightPanelTab,
} from "../storage"
import {
  applyRightPanelItemCustomization,
  collectRightPanelItems,
  moveRightPanelItem,
  parseRightPanelCustomization,
  setRightPanelItemHidden,
  type RightPanelCustomization,
  type RightPanelModule,
  type RightPanelSectionModule,
  type RightPanelTabModule,
} from "./registry"
import { CORE_STATUS_SECTION_ITEMS } from "./tabs/status-sections"

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
  const [rightPanelTab, setRightPanelTab] = createSignal<RightPanelTab>(readStoredRightPanelTab("git-changes"))
  const defaultStatusSectionIds = CORE_STATUS_SECTION_ITEMS.map((section) => section.id)
  const [rightPanelExpandedItems, setRightPanelExpandedItems] = createSignal<string[]>(defaultStatusSectionIds)
  const [rightPanelCustomizationOpen, setRightPanelCustomizationOpen] = createSignal(false)
  const [rightPanelCustomization, setRightPanelCustomization] = createSignal<RightPanelCustomization>(
    parseRightPanelCustomization(readClientLayoutValue(RIGHT_PANEL_CUSTOMIZATION_STORAGE_KEY)),
  )
  const [draggedTabId, setDraggedTabId] = createSignal<string | null>(null)

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
  const [filesWordWrapMode, setFilesWordWrapMode] = createSignal<DiffWordWrapMode>(
    readStoredEnum(RIGHT_PANEL_FILES_WORD_WRAP_KEY, ["on", "off"] as const) ?? "off",
  )

  const [filesSplitWidth, setFilesSplitWidth] = createSignal(320)
  const [gitChangesSplitWidth, setGitChangesSplitWidth] = createSignal(320)
  const [activeSplitResize, setActiveSplitResize] = createSignal<"git-changes" | "files" | null>(null)
  const [splitResizeStartX, setSplitResizeStartX] = createSignal(0)
  const [splitResizeStartWidth, setSplitResizeStartWidth] = createSignal(0)

  const [filesListOpen, setFilesListOpen] = createSignal(true)
  const [filesListTouched, setFilesListTouched] = createSignal(false)
  const [gitChangesListOpen, setGitChangesListOpen] = createSignal(true)
  const [gitChangesListTouched, setGitChangesListTouched] = createSignal(false)
  const [gitStagedOpen, setGitStagedOpen] = createSignal(true)
  const [gitUnstagedOpen, setGitUnstagedOpen] = createSignal(true)

  const listLayoutKey = createMemo(() => (props.isPhoneLayout() ? "phone" : "nonphone"))

  const listOpenStorageKey = (tab: "git-changes" | "files") => {
    const layout = listLayoutKey()
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

  const persistListOpen = (tab: "git-changes" | "files", value: boolean) => {
    writeClientLayoutValue(listOpenStorageKey(tab), value ? "true" : "false")
  }

  const persistGitSectionOpen = (section: "staged" | "unstaged", value: boolean) => {
    writeClientLayoutValue(gitSectionStorageKey(section), value ? "true" : "false")
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
    writeClientLayoutValue(RIGHT_PANEL_TAB_STORAGE_KEY, rightPanelTab())
  })

  createEffect(() => {
    writeClientLayoutValue(RIGHT_PANEL_CHANGES_DIFF_VIEW_MODE_KEY, diffViewMode())
  })

  createEffect(() => {
    writeClientLayoutValue(RIGHT_PANEL_CHANGES_DIFF_CONTEXT_MODE_KEY, diffContextMode())
  })

  createEffect(() => {
    writeClientLayoutValue(RIGHT_PANEL_CHANGES_DIFF_WORD_WRAP_KEY, diffWordWrapMode())
  })

  createEffect(() => {
    writeClientLayoutValue(RIGHT_PANEL_FILES_WORD_WRAP_KEY, filesWordWrapMode())
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
    setFilesSplitWidth(clampSplitWidth(readStoredPanelWidth(RIGHT_PANEL_FILES_SPLIT_WIDTH_KEY, 320)))
    setGitChangesSplitWidth(clampSplitWidth(readStoredPanelWidth(RIGHT_PANEL_GIT_CHANGES_SPLIT_WIDTH_KEY, 320)))
  })

  const persistSplitWidth = (mode: "git-changes" | "files", width: number) => {
    const key = mode === "git-changes" ? RIGHT_PANEL_GIT_CHANGES_SPLIT_WIDTH_KEY : RIGHT_PANEL_FILES_SPLIT_WIDTH_KEY
    writeClientLayoutValue(key, String(width))
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
    if (mode === "git-changes") setGitChangesSplitWidth(next)
    else setFilesSplitWidth(next)
  }

  function splitMouseUp() {
    const mode = activeSplitResize()
    if (mode) {
      const width = mode === "git-changes" ? gitChangesSplitWidth() : filesSplitWidth()
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
    if (mode === "git-changes") setGitChangesSplitWidth(next)
    else setFilesSplitWidth(next)
  }

  function splitTouchEnd() {
    const mode = activeSplitResize()
    if (mode) {
      const width = mode === "git-changes" ? gitChangesSplitWidth() : filesSplitWidth()
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

  const startSplitResize = (mode: "git-changes" | "files", clientX: number) => {
    if (typeof document === "undefined") return
    setActiveSplitResize(mode)
    setSplitResizeStartX(clientX)
    setSplitResizeStartWidth(mode === "git-changes" ? gitChangesSplitWidth() : filesSplitWidth())
    splitPointerDrag.start()
  }

  const handleSplitResizeMouseDown = (mode: "git-changes" | "files") => (event: MouseEvent) => {
    event.preventDefault()
    startSplitResize(mode, event.clientX)
  }

  const handleSplitResizeTouchStart = (mode: "git-changes" | "files") => (event: TouchEvent) => {
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

  const gitChangesWorktreeSlug = createMemo(() => {
    if (getGitRepoStatus(props.instanceId) === false) return null
    const slug = worktreeSlugForViewer().trim()
    return slug ? slug : null
  })

  const gitChangesWorktree = createMemo(() => {
    const slug = gitChangesWorktreeSlug()
    if (!slug) return null
    return getWorktrees(props.instanceId).find((worktree) => worktree.slug === slug) ?? null
  })

  const gitChangesBranchLabel = createMemo(() => {
    const branch = gitChangesWorktree()?.branch?.trim()
    return branch || null
  })

  const browserClient = createMemo(() => getRootClient(props.instanceId))
  const fileWorkspacePayload = async () => {
    const workspace = await getOpenCodeWorkspaceIdForWorktree(props.instanceId, worktreeSlugForViewer())
    return workspace ? { workspace } : {}
  }

  const {
    gitStatusEntries,
    gitStatusLoading,
    gitStatusError,
    gitSelectedItemId,
    gitBulkSelectedItemIds,
    gitSelectedLoading,
    gitSelectedError,
    gitSelectedBefore,
    gitSelectedAfter,
    gitCommitMessage,
    gitCommitSubmitting,
    gitMostChangedItemId,
    setGitCommitMessage,
    handleGitRowClick,
    refreshGitStatus,
    insertGitChangeContext,
    submitGitCommit,
    stageGitFile,
    unstageGitFile,
  } = useGitChanges({
    t: props.t,
    instanceId: props.instanceId,
    rightPanelTab,
    worktreeSlug: worktreeSlugForViewer,
    isPhoneLayout: props.isPhoneLayout,
    promptInputApi: props.promptInputApi,
    closeGitList: () => setGitChangesListOpen(false),
  })

  createEffect(() => {
    worktreeSlugForViewer()
    setBrowserPath(".")
    setBrowserEntries(null)
    setBrowserError(null)
    setBrowserSelectedPath(null)
    setBrowserSelectedContent(null)
    setBrowserSelectedError(null)
    setBrowserSelectedLoading(false)
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
      const nodes = await requestData<FileNode[]>(browserClient().file.list({ path: normalized, ...(await fileWorkspacePayload()) }), "file.list")
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
      const content = await requestData<FileContent>(browserClient().file.read({ path, ...(await fileWorkspacePayload()) }), "file.read")
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
          browserClient().file.read({ path, ...(await fileWorkspacePayload()) }),
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
      await serverApi.writeWorkspaceFile(props.instanceId, path, content, { worktree: worktreeSlugForViewer() })
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
        const content = await requestData<FileContent>(browserClient().file.read({ path: selected, ...(await fileWorkspacePayload()) }), "file.read")
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

  const handleAccordionChange = (values: string[]) => {
    setRightPanelExpandedItems(values)
  }

  const updateRightPanelCustomization = (updater: (current: RightPanelCustomization) => RightPanelCustomization) => {
    const next = updater(rightPanelCustomization())
    setRightPanelCustomization(next)
    writeClientLayoutValue(RIGHT_PANEL_CUSTOMIZATION_STORAGE_KEY, JSON.stringify(next))
  }

  const moveTab = (sourceId: string, targetId: string) => {
    if (!sourceId || sourceId === targetId) return
    const visibleIds = visibleRightPanelTabs().map((tab) => tab.id)
    const sourceIndex = visibleIds.indexOf(sourceId)
    const targetIndex = visibleIds.indexOf(targetId)
    if (sourceIndex === -1 || targetIndex === -1) return
    const nextVisibleIds = [...visibleIds]
    const [moved] = nextVisibleIds.splice(sourceIndex, 1)
    nextVisibleIds.splice(targetIndex, 0, moved)
    const allIds = allRightPanelTabs().map((tab) => tab.id)
    updateRightPanelCustomization((current) => ({
      ...current,
      tabOrder: [...nextVisibleIds, ...allIds.filter((id) => !nextVisibleIds.includes(id))],
    }))
  }

  const tabClass = (tab: RightPanelTab) =>
    `right-panel-tab ${rightPanelTab() === tab ? "right-panel-tab-active" : "right-panel-tab-inactive"}`

  const rightPanelModules = createMemo<RightPanelModule[]>(() => [
    {
      id: "core-right-panel",
      tabs: [
        {
          id: "git-changes",
          labelKey: "instanceShell.rightPanel.tabs.gitChanges",
          order: 10,
          render: () => (
            <LazyGitChangesTab
              t={props.t}
              activeSessionId={props.activeSessionId}
              entries={gitStatusEntries}
              statusLoading={gitStatusLoading}
              statusError={gitStatusError}
              selectedItemId={gitSelectedItemId}
              selectedBulkItemIds={gitBulkSelectedItemIds}
              selectedLoading={gitSelectedLoading}
              selectedError={gitSelectedError}
              selectedBefore={gitSelectedBefore}
              selectedAfter={gitSelectedAfter}
              mostChangedItemId={gitMostChangedItemId}
              scopeKey={gitScopeKey}
              diffViewMode={diffViewMode}
              diffContextMode={diffContextMode}
              diffWordWrapMode={diffWordWrapMode}
              onViewModeChange={setDiffViewMode}
              onContextModeChange={setDiffContextMode}
              onWordWrapModeChange={setDiffWordWrapMode}
              onRowClick={handleGitRowClick}
              onRefresh={() => void refreshGitStatus()}
              onInsertContext={insertGitChangeContext}
              onStageFile={stageGitFile}
              onUnstageFile={unstageGitFile}
              commitMessage={gitCommitMessage}
              commitSubmitting={gitCommitSubmitting}
              onCommitMessageInput={setGitCommitMessage}
              onSubmitCommit={() => void submitGitCommit()}
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
              splitWidth={gitChangesSplitWidth}
              onResizeMouseDown={handleSplitResizeMouseDown("git-changes")}
              onResizeTouchStart={handleSplitResizeTouchStart("git-changes")}
              isPhoneLayout={props.isPhoneLayout}
            />
          ),
        },
        {
          id: "files",
          labelKey: "instanceShell.rightPanel.tabs.files",
          order: 20,
          render: () => (
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
              wordWrapMode={filesWordWrapMode}
              parentPath={browserParentPath}
              scopeKey={browserScopeKey}
              onLoadEntries={(path: string) => void loadBrowserEntries(path)}
              onRequestOpenFile={(path: string) => void handleOpenBrowserFileRequest(path)}
              onRefresh={() => void refreshFilesTab()}
              onSave={(content: string) => void saveBrowserFile(content)}
              onContentChange={(content: string) => handleBrowserFileChange(content)}
              onWordWrapModeChange={setFilesWordWrapMode}
              listOpen={filesListOpen}
              onToggleList={toggleFilesList}
              splitWidth={filesSplitWidth}
              onResizeMouseDown={handleSplitResizeMouseDown("files")}
              onResizeTouchStart={handleSplitResizeTouchStart("files")}
              isPhoneLayout={props.isPhoneLayout}
            />
          ),
        },
        {
          id: "status",
          labelKey: "instanceShell.rightPanel.tabs.status",
          order: 30,
          render: () => (
            <LazyStatusTab
              t={props.t}
              instanceId={props.instanceId}
              instance={props.instance}
              activeSessionId={props.activeSessionId}
              activeSession={props.activeSession}
              latestTodoState={props.latestTodoState}
              backgroundProcessList={props.backgroundProcessList}
              onOpenBackgroundOutput={props.onOpenBackgroundOutput}
              onStopBackgroundProcess={props.onStopBackgroundProcess}
              onTerminateBackgroundProcess={props.onTerminateBackgroundProcess}
              expandedItems={rightPanelExpandedItems}
              onExpandedItemsChange={handleAccordionChange}
              customization={rightPanelCustomization}
              onCustomizationChange={updateRightPanelCustomization}
              extraSections={extraStatusSections()}
            />
          ),
        },
      ],
    },
  ])

  const allRightPanelTabs = createMemo(() => collectRightPanelItems<RightPanelTabModule>(rightPanelModules(), "tabs"))
  const visibleRightPanelTabs = createMemo(() =>
    applyRightPanelItemCustomization(
      allRightPanelTabs(),
      rightPanelCustomization().tabOrder,
      rightPanelCustomization().hiddenTabIds,
    ),
  )
  const orderedRightPanelTabs = createMemo(() => applyRightPanelItemCustomization(allRightPanelTabs(), rightPanelCustomization().tabOrder, []))
  const extraStatusSections = createMemo(() => collectRightPanelItems<RightPanelSectionModule>(rightPanelModules(), "statusSections"))
  const allStatusSections = createMemo(() => [...CORE_STATUS_SECTION_ITEMS, ...extraStatusSections()])
  const orderedStatusSections = createMemo(() => applyRightPanelItemCustomization(allStatusSections(), rightPanelCustomization().statusSectionOrder, []))
  const visibleStatusSections = createMemo(() =>
    applyRightPanelItemCustomization(
      allStatusSections(),
      rightPanelCustomization().statusSectionOrder,
      rightPanelCustomization().hiddenStatusSectionIds,
    ),
  )
  const activeRightPanelTab = createMemo(() => visibleRightPanelTabs().find((tab) => tab.id === rightPanelTab()) ?? visibleRightPanelTabs()[0])

  createEffect(() => {
    const active = activeRightPanelTab()
    if (active && active.id !== rightPanelTab()) {
      setRightPanelTab(active.id)
    }
  })

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
            <IconButton
              size="small"
              color="inherit"
              aria-label={props.t("instanceShell.rightPanel.customize.toggle")}
              title={props.t("instanceShell.rightPanel.customize.toggle")}
              onClick={() => setRightPanelCustomizationOpen((open) => !open)}
            >
              <Settings2 class="h-4 w-4" />
            </IconButton>
          </div>
          <div class="tab-scroll">
            <div class="tab-strip">
              <div class="tab-strip-tabs" role="tablist" aria-label={props.t("instanceShell.rightPanel.tabs.ariaLabel")}>
                <For each={visibleRightPanelTabs()}>
                  {(tab) => (
                    <button
                      type="button"
                      role="tab"
                      class={tabClass(tab.id)}
                      aria-selected={rightPanelTab() === tab.id}
                      onClick={() => setRightPanelTab(tab.id)}
                      draggable
                      onDragStart={(event) => {
                        setDraggedTabId(tab.id)
                        event.dataTransfer?.setData("text/plain", tab.id)
                        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
                      }}
                      onDragOver={(event) => {
                        if (!draggedTabId() || draggedTabId() === tab.id) return
                        event.preventDefault()
                        if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
                      }}
                      onDrop={(event) => {
                        event.preventDefault()
                        const sourceId = event.dataTransfer?.getData("text/plain") || draggedTabId()
                        if (sourceId) moveTab(sourceId, tab.id)
                        setDraggedTabId(null)
                      }}
                      onDragEnd={() => setDraggedTabId(null)}
                    >
                      <span class="tab-label">{props.t(tab.labelKey)}</span>
                    </button>
                  )}
                </For>
              </div>

              <div class="tab-strip-spacer" />
            </div>
          </div>
        </div>
      </div>

      <Show when={rightPanelCustomizationOpen()}>
        <div class="right-panel-customization-panel">
          <div class="right-panel-customization-header">
            <div>
              <div class="text-sm font-medium text-primary">{props.t("instanceShell.rightPanel.customize.title")}</div>
              <div class="text-xs text-secondary">{props.t("instanceShell.rightPanel.customize.description")}</div>
            </div>
            <button
              type="button"
              class="right-panel-customization-button"
              onClick={() => updateRightPanelCustomization(() => parseRightPanelCustomization(null))}
            >
              {props.t("instanceShell.rightPanel.customize.reset")}
            </button>
          </div>

          <div class="right-panel-customization-grid">
            <div class="right-panel-customization-group">
              <div class="right-panel-customization-group-title">{props.t("instanceShell.rightPanel.customize.tabs")}</div>
              <For each={orderedRightPanelTabs()}>
                {(tab) => {
                  const label = () => props.t(tab.labelKey)
                  const visible = () => !rightPanelCustomization().hiddenTabIds.includes(tab.id)
                  const disableHide = () => visible() && visibleRightPanelTabs().length <= 1
                  return (
                    <div class="right-panel-customization-row">
                      <label class="right-panel-customization-label">
                        <input
                          type="checkbox"
                          checked={visible()}
                          disabled={disableHide()}
                          onChange={(event) =>
                            updateRightPanelCustomization((current) => ({
                              ...current,
                              hiddenTabIds: setRightPanelItemHidden(current.hiddenTabIds, tab.id, !event.currentTarget.checked),
                            }))
                          }
                        />
                        <span>{label()}</span>
                      </label>
                      <div class="right-panel-customization-actions">
                        <button
                          type="button"
                          class="right-panel-customization-button"
                          aria-label={props.t("instanceShell.rightPanel.customize.moveTabUp", { label: label() })}
                          title={props.t("instanceShell.rightPanel.customize.moveTabUp", { label: label() })}
                          onClick={() =>
                            updateRightPanelCustomization((current) => ({
                              ...current,
                              tabOrder: moveRightPanelItem(current.tabOrder, allRightPanelTabs().map((item) => item.id), tab.id, -1),
                            }))
                          }
                        >
                          {props.t("instanceShell.rightPanel.customize.moveUp")}
                        </button>
                        <button
                          type="button"
                          class="right-panel-customization-button"
                          aria-label={props.t("instanceShell.rightPanel.customize.moveTabDown", { label: label() })}
                          title={props.t("instanceShell.rightPanel.customize.moveTabDown", { label: label() })}
                          onClick={() =>
                            updateRightPanelCustomization((current) => ({
                              ...current,
                              tabOrder: moveRightPanelItem(current.tabOrder, allRightPanelTabs().map((item) => item.id), tab.id, 1),
                            }))
                          }
                        >
                          {props.t("instanceShell.rightPanel.customize.moveDown")}
                        </button>
                      </div>
                    </div>
                  )
                }}
              </For>
            </div>

            <div class="right-panel-customization-group">
              <div class="right-panel-customization-group-title">{props.t("instanceShell.rightPanel.customize.statusSections")}</div>
              <For each={orderedStatusSections()}>
                {(section) => {
                  const label = () => props.t(section.labelKey)
                  const visible = () => !rightPanelCustomization().hiddenStatusSectionIds.includes(section.id)
                  const disableHide = () => visible() && visibleStatusSections().length <= 1
                  return (
                    <div class="right-panel-customization-row">
                      <label class="right-panel-customization-label">
                        <input
                          type="checkbox"
                          checked={visible()}
                          disabled={disableHide()}
                          onChange={(event) =>
                            updateRightPanelCustomization((current) => ({
                              ...current,
                              hiddenStatusSectionIds: setRightPanelItemHidden(
                                current.hiddenStatusSectionIds,
                                section.id,
                                !event.currentTarget.checked,
                              ),
                            }))
                          }
                        />
                        <span>{label()}</span>
                      </label>
                      <div class="right-panel-customization-actions">
                        <button
                          type="button"
                          class="right-panel-customization-button"
                          aria-label={props.t("instanceShell.rightPanel.customize.moveStatusSectionUp", { label: label() })}
                          title={props.t("instanceShell.rightPanel.customize.moveStatusSectionUp", { label: label() })}
                          onClick={() =>
                            updateRightPanelCustomization((current) => ({
                              ...current,
                              statusSectionOrder: moveRightPanelItem(
                                current.statusSectionOrder,
                                allStatusSections().map((item) => item.id),
                                section.id,
                                -1,
                              ),
                            }))
                          }
                        >
                          {props.t("instanceShell.rightPanel.customize.moveUp")}
                        </button>
                        <button
                          type="button"
                          class="right-panel-customization-button"
                          aria-label={props.t("instanceShell.rightPanel.customize.moveStatusSectionDown", { label: label() })}
                          title={props.t("instanceShell.rightPanel.customize.moveStatusSectionDown", { label: label() })}
                          onClick={() =>
                            updateRightPanelCustomization((current) => ({
                              ...current,
                              statusSectionOrder: moveRightPanelItem(
                                current.statusSectionOrder,
                                allStatusSections().map((item) => item.id),
                                section.id,
                                1,
                              ),
                            }))
                          }
                        >
                          {props.t("instanceShell.rightPanel.customize.moveDown")}
                        </button>
                      </div>
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
        </div>
      </Show>

      <div class="flex-1 overflow-y-auto">
        <Show keyed when={activeRightPanelTab()}>
          {(tab) => <Suspense fallback={<RightPanelTabFallback />}>{tab.render()}</Suspense>}
        </Show>
      </div>
    </div>
  )
}

export default RightPanel
