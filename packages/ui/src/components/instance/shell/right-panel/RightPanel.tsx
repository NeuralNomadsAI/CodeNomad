import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
  type Component,
} from "solid-js"
import type { ToolState } from "@opencode-ai/sdk"
import type { FileContent, FileNode, File as GitFileStatus } from "@opencode-ai/sdk/v2/client"
import IconButton from "@suid/material/IconButton"
import MenuOpenIcon from "@suid/icons-material/MenuOpen"
import PushPinIcon from "@suid/icons-material/PushPin"
import PushPinOutlinedIcon from "@suid/icons-material/PushPinOutlined"

import type { Instance } from "../../../../types/instance"
import type { BackgroundProcess } from "../../../../../../server/src/api-types"
import type { Session } from "../../../../types/session"
import type { DrawerViewState } from "../types"
import type { DiffContextMode, DiffViewMode, RightPanelTab } from "./types"

import ChangesTab from "./tabs/ChangesTab"
import FilesTab from "./tabs/FilesTab"
import GitChangesTab from "./tabs/GitChangesTab"
import StatusTab from "./tabs/StatusTab"

import { getDefaultWorktreeSlug, getOrCreateWorktreeClient, getWorktreeSlugForSession } from "../../../../stores/worktrees"
import { requestData } from "../../../../lib/opencode-api"
import { buildUnifiedDiffFromSdkPatch, tryReverseApplyUnifiedDiff } from "../../../../lib/unified-diff-reverse"
import { useGlobalPointerDrag } from "../useGlobalPointerDrag"
import {
  RIGHT_PANEL_CHANGES_DIFF_CONTEXT_MODE_KEY,
  RIGHT_PANEL_CHANGES_DIFF_VIEW_MODE_KEY,
  RIGHT_PANEL_CHANGES_LIST_OPEN_NONPHONE_KEY,
  RIGHT_PANEL_CHANGES_LIST_OPEN_PHONE_KEY,
  RIGHT_PANEL_CHANGES_SPLIT_WIDTH_KEY,
  RIGHT_PANEL_FILES_LIST_OPEN_NONPHONE_KEY,
  RIGHT_PANEL_FILES_LIST_OPEN_PHONE_KEY,
  RIGHT_PANEL_FILES_SPLIT_WIDTH_KEY,
  RIGHT_PANEL_GIT_CHANGES_LIST_OPEN_NONPHONE_KEY,
  RIGHT_PANEL_GIT_CHANGES_LIST_OPEN_PHONE_KEY,
  RIGHT_PANEL_GIT_CHANGES_SPLIT_WIDTH_KEY,
  RIGHT_PANEL_TAB_STORAGE_KEY,
  readStoredBool,
  readStoredEnum,
  readStoredPanelWidth,
  readStoredRightPanelTab,
} from "../storage"

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

  setContentEl: (el: HTMLElement | null) => void
}

const RightPanel: Component<RightPanelProps> = (props) => {
  const [rightPanelTab, setRightPanelTab] = createSignal<RightPanelTab>(readStoredRightPanelTab("changes"))
  const [rightPanelExpandedItems, setRightPanelExpandedItems] = createSignal<string[]>([
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

  const [diffViewMode, setDiffViewMode] = createSignal<DiffViewMode>(
    readStoredEnum(RIGHT_PANEL_CHANGES_DIFF_VIEW_MODE_KEY, ["split", "unified"] as const) ?? "unified",
  )
  const [diffContextMode, setDiffContextMode] = createSignal<DiffContextMode>(
    readStoredEnum(RIGHT_PANEL_CHANGES_DIFF_CONTEXT_MODE_KEY, ["expanded", "collapsed"] as const) ?? "collapsed",
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

  const persistListOpen = (tab: "changes" | "git-changes" | "files", value: boolean) => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(listOpenStorageKey(tab), value ? "true" : "false")
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
    const delta = event.clientX - splitResizeStartX()
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
    const delta = touch.clientX - splitResizeStartX()
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

  const [gitStatusEntries, setGitStatusEntries] = createSignal<GitFileStatus[] | null>(null)
  const [gitStatusLoading, setGitStatusLoading] = createSignal(false)
  const [gitStatusError, setGitStatusError] = createSignal<string | null>(null)
  const [gitSelectedPath, setGitSelectedPath] = createSignal<string | null>(null)
  const [gitSelectedLoading, setGitSelectedLoading] = createSignal(false)
  const [gitSelectedError, setGitSelectedError] = createSignal<string | null>(null)
  const [gitSelectedBefore, setGitSelectedBefore] = createSignal<string | null>(null)
  const [gitSelectedAfter, setGitSelectedAfter] = createSignal<string | null>(null)

  const gitMostChangedPath = createMemo<string | null>(() => {
    const entries = gitStatusEntries()
    if (!Array.isArray(entries) || entries.length === 0) return null
    const candidates = entries.filter((item) => item && item.status !== "deleted")
    if (candidates.length === 0) return null
    const best = candidates.reduce((currentBest, item) => {
      const bestScore = (currentBest?.added ?? 0) + (currentBest?.removed ?? 0)
      const score = (item?.added ?? 0) + (item?.removed ?? 0)
      if (score > bestScore) return item
      if (score < bestScore) return currentBest
      return String(item.path || "").localeCompare(String(currentBest?.path || "")) < 0 ? item : currentBest
    }, candidates[0])
    return typeof best?.path === "string" ? best.path : null
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
    setGitSelectedPath(null)
    setGitSelectedLoading(false)
    setGitSelectedError(null)
    setGitSelectedBefore(null)
    setGitSelectedAfter(null)
  })

  const loadGitStatus = async (force = false) => {
    if (!force && gitStatusEntries() !== null) return
    setGitStatusLoading(true)
    setGitStatusError(null)
    try {
      const list = await requestData<GitFileStatus[]>(browserClient().file.status(), "file.status")
      setGitStatusEntries(Array.isArray(list) ? list : [])
    } catch (error) {
      setGitStatusError(error instanceof Error ? error.message : "Failed to load git status")
      setGitStatusEntries([])
    } finally {
      setGitStatusLoading(false)
    }
  }

  async function openGitFile(path: string) {
    setGitSelectedPath(path)
    setGitSelectedLoading(true)
    setGitSelectedError(null)
    setGitSelectedBefore(null)
    setGitSelectedAfter(null)

    const list = gitStatusEntries() || []
    const entry = list.find((item) => item.path === path) || null
    if (entry?.status === "deleted") {
      setGitSelectedError("Deleted file diff is not available yet")
      setGitSelectedLoading(false)
      return
    }

    // Phone: treat file selection as a commit action and close the overlay.
    if (props.isPhoneLayout()) {
      setGitChangesListOpen(false)
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
      const afterText = typeof (content as any)?.content === "string" ? ((content as any).content as string) : null
      if (afterText === null) {
        throw new Error("Unsupported file type")
      }

      setGitSelectedAfter(afterText)

      if (entry?.status === "added") {
        setGitSelectedBefore("")
        return
      }

      const diffText =
        typeof (content as any)?.diff === "string" && String((content as any).diff).trim().length > 0
          ? String((content as any).diff)
          : (content as any)?.patch
            ? buildUnifiedDiffFromSdkPatch((content as any).patch)
            : ""

      const beforeText = tryReverseApplyUnifiedDiff(afterText, diffText)
      if (beforeText === null) {
        throw new Error("Unable to calculate diff for this file")
      }
      setGitSelectedBefore(beforeText)
    } catch (error) {
      setGitSelectedError(error instanceof Error ? error.message : "Failed to load file changes")
    } finally {
      setGitSelectedLoading(false)
    }
  }

  createEffect(() => {
    if (rightPanelTab() !== "git-changes") return
    const entries = gitStatusEntries()
    if (entries === null) return
    if (gitSelectedPath()) return
    const next = gitMostChangedPath()
    if (!next) return
    void openGitFile(next)
  })

  const refreshGitStatus = async () => {
    await loadGitStatus(true)
    const selected = gitSelectedPath()
    if (selected) {
      void openGitFile(selected)
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
    } catch (error) {
      setBrowserSelectedError(error instanceof Error ? error.message : "Failed to read file")
    } finally {
      setBrowserSelectedLoading(false)
    }
  }

  createEffect(() => {
    if (rightPanelTab() !== "files") return
    if (browserLoading()) return
    if (browserEntries() !== null) return
    void loadBrowserEntries(browserPath())
  })

  createEffect(() => {
    if (rightPanelTab() !== "git-changes") return
    if (gitStatusLoading()) return
    if (gitStatusEntries() !== null) return
    void loadGitStatus()
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

  const statusSectionIds = ["session-changes", "plan", "background-processes", "mcp", "lsp", "plugins"]

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
          <ChangesTab
            t={props.t}
            instanceId={props.instanceId}
            activeSessionId={props.activeSessionId}
            activeSessionDiffs={props.activeSessionDiffs}
            selectedFile={selectedFile}
            onSelectFile={handleSelectChangesFile}
            diffViewMode={diffViewMode}
            diffContextMode={diffContextMode}
            onViewModeChange={setDiffViewMode}
            onContextModeChange={setDiffContextMode}
            listOpen={changesListOpen}
            onToggleList={toggleChangesList}
            splitWidth={changesSplitWidth}
            onResizeMouseDown={handleSplitResizeMouseDown("changes")}
            onResizeTouchStart={handleSplitResizeTouchStart("changes")}
            isPhoneLayout={props.isPhoneLayout}
          />
        </Show>

        <Show when={rightPanelTab() === "git-changes"}>
          <GitChangesTab
            t={props.t}
            activeSessionId={props.activeSessionId}
            entries={gitStatusEntries}
            statusLoading={gitStatusLoading}
            statusError={gitStatusError}
            selectedPath={gitSelectedPath}
            selectedLoading={gitSelectedLoading}
            selectedError={gitSelectedError}
            selectedBefore={gitSelectedBefore}
            selectedAfter={gitSelectedAfter}
            mostChangedPath={gitMostChangedPath}
            scopeKey={gitScopeKey}
            diffViewMode={diffViewMode}
            diffContextMode={diffContextMode}
            onViewModeChange={setDiffViewMode}
            onContextModeChange={setDiffContextMode}
            onOpenFile={(path) => void openGitFile(path)}
            onRefresh={() => void refreshGitStatus()}
            listOpen={gitChangesListOpen}
            onToggleList={toggleGitList}
            splitWidth={gitChangesSplitWidth}
            onResizeMouseDown={handleSplitResizeMouseDown("git-changes")}
            onResizeTouchStart={handleSplitResizeTouchStart("git-changes")}
            isPhoneLayout={props.isPhoneLayout}
          />
        </Show>

        <Show when={rightPanelTab() === "files"}>
          <FilesTab
            t={props.t}
            browserPath={browserPath}
            browserEntries={browserEntries}
            browserLoading={browserLoading}
            browserError={browserError}
            browserSelectedPath={browserSelectedPath}
            browserSelectedContent={browserSelectedContent}
            browserSelectedLoading={browserSelectedLoading}
            browserSelectedError={browserSelectedError}
            parentPath={browserParentPath}
            scopeKey={browserScopeKey}
            onLoadEntries={(path) => void loadBrowserEntries(path)}
            onOpenFile={(path) => void openBrowserFile(path)}
            onRefresh={() => void refreshFilesTab()}
            listOpen={filesListOpen}
            onToggleList={toggleFilesList}
            splitWidth={filesSplitWidth}
            onResizeMouseDown={handleSplitResizeMouseDown("files")}
            onResizeTouchStart={handleSplitResizeTouchStart("files")}
            isPhoneLayout={props.isPhoneLayout}
          />
        </Show>

        <Show when={rightPanelTab() === "status"}>
          <StatusTab
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
        </Show>
      </div>
    </div>
  )
}

export default RightPanel
