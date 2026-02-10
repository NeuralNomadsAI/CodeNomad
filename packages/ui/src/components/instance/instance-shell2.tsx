import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
  type Component,
} from "solid-js"
import type { ToolState } from "@opencode-ai/sdk"
import type { FileContent, FileNode } from "@opencode-ai/sdk/v2/client"
import { Accordion } from "@kobalte/core"
import { ChevronDown, Search, TerminalSquare, Trash2, XOctagon } from "lucide-solid"
import AppBar from "@suid/material/AppBar"
import Box from "@suid/material/Box"
import Drawer from "@suid/material/Drawer"
import IconButton from "@suid/material/IconButton"
import Toolbar from "@suid/material/Toolbar"
import Typography from "@suid/material/Typography"
import useMediaQuery from "@suid/material/useMediaQuery"
import MenuIcon from "@suid/icons-material/Menu"
import MenuOpenIcon from "@suid/icons-material/MenuOpen"
import PushPinIcon from "@suid/icons-material/PushPin"
import PushPinOutlinedIcon from "@suid/icons-material/PushPinOutlined"
import InfoOutlinedIcon from "@suid/icons-material/InfoOutlined"
import type { Instance } from "../../types/instance"
import type { Command } from "../../lib/commands"
import type { BackgroundProcess } from "../../../../server/src/api-types"
import type { Session } from "../../types/session"
import {
  activeParentSessionId,
  activeSessionId as activeSessionMap,
  getSessionFamily,
  getSessionInfo,
  getSessionThreads,
  loadMessages,
  sessions,
  setActiveParentSession,
  setActiveSession,
} from "../../stores/sessions"
import { keyboardRegistry, type KeyboardShortcut } from "../../lib/keyboard-registry"
import { messageStoreBus } from "../../stores/message-v2/bus"
import { clearSessionRenderCache } from "../message-block"

import { isOpen as isCommandPaletteOpen, hideCommandPalette, showCommandPalette } from "../../stores/command-palette"
import SessionList from "../session-list"
import KeyboardHint from "../keyboard-hint"
import Kbd from "../kbd"
import InstanceWelcomeView from "../instance-welcome-view"
import InfoView from "../info-view"
import InstanceServiceStatus from "../instance-service-status"
import AgentSelector from "../agent-selector"
import ModelSelector from "../model-selector"
import ThinkingSelector from "../thinking-selector"
import CommandPalette from "../command-palette"
import PermissionNotificationBanner from "../permission-notification-banner"
import PermissionApprovalModal from "../permission-approval-modal"
import { TodoListView } from "../tool-call/renderers/todo"
import ContextUsagePanel from "../session/context-usage-panel"
import SessionView from "../session/session-view"
import { formatTokenTotal } from "../../lib/formatters"
import { sseManager } from "../../lib/sse-manager"
import { getLogger } from "../../lib/logger"
import { serverApi } from "../../lib/api-client"
import { requestData } from "../../lib/opencode-api"
import WorktreeSelector from "../worktree-selector"
import { getBackgroundProcesses, loadBackgroundProcesses } from "../../stores/background-processes"
import { BackgroundProcessOutputDialog } from "../background-process-output-dialog"
import { useI18n } from "../../lib/i18n"
import { getDefaultWorktreeSlug, getOrCreateWorktreeClient, getWorktreeSlugForSession } from "../../stores/worktrees"
import { MonacoDiffViewer } from "../file-viewer/monaco-diff-viewer"
import { MonacoFileViewer } from "../file-viewer/monaco-file-viewer"
import {
  SESSION_SIDEBAR_EVENT,
  type SessionSidebarRequestAction,
  type SessionSidebarRequestDetail,
} from "../../lib/session-sidebar-events"

const log = getLogger("session")

interface InstanceShellProps {
  instance: Instance
  escapeInDebounce: boolean
  paletteCommands: Accessor<Command[]>
  onCloseSession: (sessionId: string) => Promise<void> | void
  onNewSession: () => Promise<void> | void
  handleSidebarAgentChange: (sessionId: string, agent: string) => Promise<void>
  handleSidebarModelChange: (sessionId: string, model: { providerId: string; modelId: string }) => Promise<void>
  onExecuteCommand: (command: Command) => void
  tabBarOffset: number
}

const DEFAULT_SESSION_SIDEBAR_WIDTH = 340
const MIN_SESSION_SIDEBAR_WIDTH = 220
const MAX_SESSION_SIDEBAR_WIDTH = 400
const RIGHT_DRAWER_WIDTH = 260
const MIN_RIGHT_DRAWER_WIDTH = 200
const MAX_RIGHT_DRAWER_WIDTH = 1200
const SESSION_CACHE_LIMIT = 5
const LEFT_DRAWER_STORAGE_KEY = "opencode-session-sidebar-width-v8"
const RIGHT_DRAWER_STORAGE_KEY = "opencode-session-right-drawer-width-v1"
const LEFT_PIN_STORAGE_KEY = "opencode-session-left-drawer-pinned-v1"
const RIGHT_PIN_STORAGE_KEY = "opencode-session-right-drawer-pinned-v1"
const RIGHT_PANEL_TAB_STORAGE_KEY = "opencode-session-right-panel-tab-v2"
const LEGACY_RIGHT_PANEL_TAB_STORAGE_KEY = "opencode-session-right-panel-tab-v1"
const RIGHT_PANEL_CHANGES_SPLIT_WIDTH_KEY = "opencode-session-right-panel-changes-split-width-v1"
const RIGHT_PANEL_FILES_SPLIT_WIDTH_KEY = "opencode-session-right-panel-files-split-width-v1"
const RIGHT_PANEL_CHANGES_LIST_OPEN_NONPHONE_KEY = "opencode-session-right-panel-changes-list-open-nonphone-v1"
const RIGHT_PANEL_CHANGES_LIST_OPEN_PHONE_KEY = "opencode-session-right-panel-changes-list-open-phone-v1"
const RIGHT_PANEL_FILES_LIST_OPEN_NONPHONE_KEY = "opencode-session-right-panel-files-list-open-nonphone-v1"
const RIGHT_PANEL_FILES_LIST_OPEN_PHONE_KEY = "opencode-session-right-panel-files-list-open-phone-v1"
const RIGHT_PANEL_CHANGES_DIFF_VIEW_MODE_KEY = "opencode-session-right-panel-changes-diff-view-mode-v1"
const RIGHT_PANEL_CHANGES_DIFF_CONTEXT_MODE_KEY = "opencode-session-right-panel-changes-diff-context-mode-v1"




type LayoutMode = "desktop" | "tablet" | "phone"
type RightPanelTab = "changes" | "files" | "status"

const clampWidth = (value: number) => Math.min(MAX_SESSION_SIDEBAR_WIDTH, Math.max(MIN_SESSION_SIDEBAR_WIDTH, value))
const clampRightWidth = (value: number) => {
  const windowMax = typeof window !== "undefined" ? Math.floor(window.innerWidth * 0.7) : MAX_RIGHT_DRAWER_WIDTH
  const max = Math.max(MIN_RIGHT_DRAWER_WIDTH, windowMax)
  return Math.min(max, Math.max(MIN_RIGHT_DRAWER_WIDTH, value))
}
const getPinStorageKey = (side: "left" | "right") => (side === "left" ? LEFT_PIN_STORAGE_KEY : RIGHT_PIN_STORAGE_KEY)
function readStoredPinState(side: "left" | "right", defaultValue: boolean) {
  if (typeof window === "undefined") return defaultValue
  const stored = window.localStorage.getItem(getPinStorageKey(side))
  if (stored === "true") return true
  if (stored === "false") return false
  return defaultValue
}
function persistPinState(side: "left" | "right", value: boolean) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(getPinStorageKey(side), value ? "true" : "false")
}

function readStoredRightPanelTab(defaultValue: RightPanelTab): RightPanelTab {
  if (typeof window === "undefined") return defaultValue

  const stored = window.localStorage.getItem(RIGHT_PANEL_TAB_STORAGE_KEY)
  if (stored === "status") return "status"
  if (stored === "changes") return "changes"
  if (stored === "files") return "files"

  // Migrate from v1 (where the stored values were the internal tab ids).
  const legacy = window.localStorage.getItem(LEGACY_RIGHT_PANEL_TAB_STORAGE_KEY)
  if (legacy === "status") return "status"
  if (legacy === "browser") return "files"
  if (legacy === "files") return "changes"

  return defaultValue
}

function readStoredPanelWidth(key: string, fallback: number) {
  if (typeof window === "undefined") return fallback
  const stored = window.localStorage.getItem(key)
  if (!stored) return fallback
  const parsed = Number.parseInt(stored, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function readStoredBool(key: string): boolean | null {
  if (typeof window === "undefined") return null
  const stored = window.localStorage.getItem(key)
  if (stored === "true") return true
  if (stored === "false") return false
  return null
}

function readStoredEnum<T extends string>(key: string, allowed: readonly T[]): T | null {
  if (typeof window === "undefined") return null
  const stored = window.localStorage.getItem(key)
  if (!stored) return null
  return (allowed as readonly string[]).includes(stored) ? (stored as T) : null
}

const InstanceShell2: Component<InstanceShellProps> = (props) => {
  const { t } = useI18n()

  const [sessionSidebarWidth, setSessionSidebarWidth] = createSignal(DEFAULT_SESSION_SIDEBAR_WIDTH)
  const [rightDrawerWidth, setRightDrawerWidth] = createSignal(
    typeof window !== "undefined" ? clampRightWidth(window.innerWidth * 0.35) : RIGHT_DRAWER_WIDTH,
  )
  const [leftPinned, setLeftPinned] = createSignal(true)
  const [leftOpen, setLeftOpen] = createSignal(true)
  const [rightPinned, setRightPinned] = createSignal(true)
  const [rightOpen, setRightOpen] = createSignal(true)
  const [cachedSessionIds, setCachedSessionIds] = createSignal<string[]>([])
  const [pendingEvictions, setPendingEvictions] = createSignal<string[]>([])
  const [drawerHost, setDrawerHost] = createSignal<HTMLElement | null>(null)
  const [floatingDrawerTop, setFloatingDrawerTop] = createSignal(0)
  const [floatingDrawerHeight, setFloatingDrawerHeight] = createSignal(0)
  const [leftDrawerContentEl, setLeftDrawerContentEl] = createSignal<HTMLElement | null>(null)
  const [rightDrawerContentEl, setRightDrawerContentEl] = createSignal<HTMLElement | null>(null)
  const [leftToggleButtonEl, setLeftToggleButtonEl] = createSignal<HTMLElement | null>(null)
  const [rightToggleButtonEl, setRightToggleButtonEl] = createSignal<HTMLElement | null>(null)
  const [activeResizeSide, setActiveResizeSide] = createSignal<"left" | "right" | null>(null)
  const [resizeStartX, setResizeStartX] = createSignal(0)
  const [resizeStartWidth, setResizeStartWidth] = createSignal(0)
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

  const [diffViewMode, setDiffViewMode] = createSignal<"split" | "unified">(
    readStoredEnum(RIGHT_PANEL_CHANGES_DIFF_VIEW_MODE_KEY, ["split", "unified"] as const) ?? "unified",
  )
  const [diffContextMode, setDiffContextMode] = createSignal<"expanded" | "collapsed">(
    readStoredEnum(RIGHT_PANEL_CHANGES_DIFF_CONTEXT_MODE_KEY, ["expanded", "collapsed"] as const) ?? "collapsed",
  )

  const [changesSplitWidth, setChangesSplitWidth] = createSignal(320)
  const [filesSplitWidth, setFilesSplitWidth] = createSignal(320)
  const [activeSplitResize, setActiveSplitResize] = createSignal<"changes" | "files" | null>(null)
  const [splitResizeStartX, setSplitResizeStartX] = createSignal(0)
  const [splitResizeStartWidth, setSplitResizeStartWidth] = createSignal(0)

  const [filesListOpen, setFilesListOpen] = createSignal(true)
  const [filesListTouched, setFilesListTouched] = createSignal(false)
  const [changesListOpen, setChangesListOpen] = createSignal(true)
  const [changesListTouched, setChangesListTouched] = createSignal(false)

  createEffect(() => {
    // Default behavior: when nothing is selected, keep the file list open.
    // Once the user explicitly toggles it, we stop auto-opening.
    if (rightPanelTab() !== "files") return
    if (filesListTouched()) return
    if (!browserSelectedPath()) {
      setFilesListOpen(true)
    }
  })

  const [selectedBackgroundProcess, setSelectedBackgroundProcess] = createSignal<BackgroundProcess | null>(null)
  const [showBackgroundOutput, setShowBackgroundOutput] = createSignal(false)
  const [permissionModalOpen, setPermissionModalOpen] = createSignal(false)

  // Worktree selector manages its own dialogs.
  const [showSessionSearch, setShowSessionSearch] = createSignal(false)

  const messageStore = createMemo(() => messageStoreBus.getOrCreate(props.instance.id))

  const desktopQuery = useMediaQuery("(min-width: 1280px)")

  const tabletQuery = useMediaQuery("(min-width: 768px)")

  const layoutMode = createMemo<LayoutMode>(() => {
    if (desktopQuery()) return "desktop"
    if (tabletQuery()) return "tablet"
    return "phone"
  })

  const isPhoneLayout = createMemo(() => layoutMode() === "phone")
  const leftPinningSupported = createMemo(() => layoutMode() !== "phone")
  const rightPinningSupported = createMemo(() => layoutMode() !== "phone")

  const listLayoutKey = createMemo(() => (isPhoneLayout() ? "phone" : "nonphone"))

  const listOpenStorageKey = (tab: "changes" | "files") => {
    const layout = listLayoutKey()
    if (tab === "changes") {
      return layout === "phone" ? RIGHT_PANEL_CHANGES_LIST_OPEN_PHONE_KEY : RIGHT_PANEL_CHANGES_LIST_OPEN_NONPHONE_KEY
    }
    return layout === "phone" ? RIGHT_PANEL_FILES_LIST_OPEN_PHONE_KEY : RIGHT_PANEL_FILES_LIST_OPEN_NONPHONE_KEY
  }

  const persistListOpen = (tab: "changes" | "files", value: boolean) => {
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
  })

  const persistPinIfSupported = (side: "left" | "right", value: boolean) => {
    if (side === "left" && !leftPinningSupported()) return
    if (side === "right" && !rightPinningSupported()) return
    persistPinState(side, value)
  }

  createEffect(() => {
    const instanceId = props.instance.id
    loadBackgroundProcesses(instanceId).catch((error) => {
      log.warn("Failed to load background processes", error)
    })
  })

  createEffect(() => {
    switch (layoutMode()) {
      case "desktop": {
        const leftSaved = readStoredPinState("left", true)
        const rightSaved = readStoredPinState("right", true)
        setLeftPinned(leftSaved)
        setLeftOpen(leftSaved)
        setRightPinned(rightSaved)
        setRightOpen(rightSaved)
        break
      }
      case "tablet": {
        setLeftPinned(true)
        setLeftOpen(true)
        setRightPinned(false)
        setRightOpen(false)
        break
      }
      default:
        setLeftPinned(false)
        setLeftOpen(false)
        setRightPinned(false)
        setRightOpen(false)
        break
    }
  })

  const measureDrawerHost = () => {
    if (typeof window === "undefined") return
    const host = drawerHost()
    if (!host) return
    const rect = host.getBoundingClientRect()
    setFloatingDrawerTop(rect.top)
    setFloatingDrawerHeight(Math.max(0, rect.height))
  }

  onMount(() => {
    if (typeof window === "undefined") return

    const savedLeft = window.localStorage.getItem(LEFT_DRAWER_STORAGE_KEY)
    if (savedLeft) {
      const parsed = Number.parseInt(savedLeft, 10)
      if (Number.isFinite(parsed)) {
        setSessionSidebarWidth(clampWidth(parsed))
      }
    }

    let didLoadRightWidth = false
    const savedRight = window.localStorage.getItem(RIGHT_DRAWER_STORAGE_KEY)
    if (savedRight) {
      const parsed = Number.parseInt(savedRight, 10)
      if (Number.isFinite(parsed)) {
        setRightDrawerWidth(clampRightWidth(parsed))
        didLoadRightWidth = true
      }
    }

    if (!didLoadRightWidth) {
      setRightDrawerWidth(clampRightWidth(window.innerWidth * 0.35))
    }

    setChangesSplitWidth(clampSplitWidth(readStoredPanelWidth(RIGHT_PANEL_CHANGES_SPLIT_WIDTH_KEY, 320)))
    setFilesSplitWidth(clampSplitWidth(readStoredPanelWidth(RIGHT_PANEL_FILES_SPLIT_WIDTH_KEY, 320)))

    const handleResize = () => {
      const width = clampWidth(window.innerWidth * 0.3)
      setSessionSidebarWidth((current) => clampWidth(current || width))
      const fallbackRight = window.innerWidth * 0.35
      setRightDrawerWidth((current) => clampRightWidth(current || fallbackRight))
      measureDrawerHost()
    }

    handleResize()
    window.addEventListener("resize", handleResize)
    onCleanup(() => window.removeEventListener("resize", handleResize))
  })

  onMount(() => {
    if (typeof window === "undefined") return
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<SessionSidebarRequestDetail>).detail
      if (!detail || detail.instanceId !== props.instance.id) return
      handleSidebarRequest(detail.action)
    }
    window.addEventListener(SESSION_SIDEBAR_EVENT, handler)
    onCleanup(() => window.removeEventListener(SESSION_SIDEBAR_EVENT, handler))
  })

  createEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(LEFT_DRAWER_STORAGE_KEY, sessionSidebarWidth().toString())
  })

  createEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(RIGHT_DRAWER_STORAGE_KEY, rightDrawerWidth().toString())
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
    props.tabBarOffset
    requestAnimationFrame(() => measureDrawerHost())
  })

  const allInstanceSessions = createMemo<Map<string, Session>>(() => {
    return sessions().get(props.instance.id) ?? new Map()
  })

  const sessionThreads = createMemo(() => getSessionThreads(props.instance.id))

  const activeSessions = createMemo(() => {
    const parentId = activeParentSessionId().get(props.instance.id)
    if (!parentId) return new Map<string, ReturnType<typeof getSessionFamily>[number]>()
    const sessionFamily = getSessionFamily(props.instance.id, parentId)
    return new Map(sessionFamily.map((s) => [s.id, s]))
  })

  const activeSessionIdForInstance = createMemo(() => {
    return activeSessionMap().get(props.instance.id) || null
  })

  const parentSessionIdForInstance = createMemo(() => {
    return activeParentSessionId().get(props.instance.id) || null
  })

  const activeSessionForInstance = createMemo(() => {
    const sessionId = activeSessionIdForInstance()
    if (!sessionId || sessionId === "info") return null
    return activeSessions().get(sessionId) ?? null
  })

  const activeSessionDiffs = createMemo(() => {
    const session = activeSessionForInstance()
    return session?.diff
  })

  const activeSessionUsage = createMemo(() => {
    const sessionId = activeSessionIdForInstance()
    if (!sessionId) return null
    const store = messageStore()
    return store?.getSessionUsage(sessionId) ?? null
  })

  const activeSessionInfoDetails = createMemo(() => {
    const sessionId = activeSessionIdForInstance()
    if (!sessionId) return null
    return getSessionInfo(props.instance.id, sessionId) ?? null
  })

  const tokenStats = createMemo(() => {
    const usage = activeSessionUsage()
    const info = activeSessionInfoDetails()
    return {
      used: usage?.actualUsageTokens ?? info?.actualUsageTokens ?? 0,
      avail: info?.contextAvailableTokens ?? null,
    }
  })

  const latestTodoSnapshot = createMemo(() => {
    const sessionId = activeSessionIdForInstance()
    if (!sessionId || sessionId === "info") return null
    const store = messageStore()
    if (!store) return null
    const snapshot = store.state.latestTodos[sessionId]
    return snapshot ?? null
  })

  const latestTodoState = createMemo<ToolState | null>(() => {
    const snapshot = latestTodoSnapshot()
    if (!snapshot) return null
    const store = messageStore()
    if (!store) return null
    const message = store.getMessage(snapshot.messageId)
    if (!message) return null
    const partRecord = message.parts?.[snapshot.partId]
    const part = partRecord?.data as { type?: string; tool?: string; state?: ToolState }
    if (!part || part.type !== "tool" || part.tool !== "todowrite") return null
    const state = part.state
    if (!state || state.status !== "completed") return null
    return state
  })

  const backgroundProcessList = createMemo(() => getBackgroundProcesses(props.instance.id))

  const connectionStatus = () => sseManager.getStatus(props.instance.id)
  const connectionStatusClass = () => {
    const status = connectionStatus()
    if (status === "connecting") return "connecting"
    if (status === "connected") return "connected"
    return "disconnected"
  }

  const connectionStatusLabel = () => {
    const status = connectionStatus()
    if (status === "connected") return t("instanceShell.connection.connected")
    if (status === "connecting") return t("instanceShell.connection.connecting")
    if (status === "error" || status === "disconnected") return t("instanceShell.connection.disconnected")
    return t("instanceShell.connection.unknown")
  }

  const handleCommandPaletteClick = () => {
    showCommandPalette(props.instance.id)
  }

  const openBackgroundOutput = (process: BackgroundProcess) => {
    setSelectedBackgroundProcess(process)
    setShowBackgroundOutput(true)
  }

  const closeBackgroundOutput = () => {
    setShowBackgroundOutput(false)
    setSelectedBackgroundProcess(null)
  }

  const stopBackgroundProcess = async (processId: string) => {
    try {
      await serverApi.stopBackgroundProcess(props.instance.id, processId)
    } catch (error) {
      log.warn("Failed to stop background process", error)
    }
  }

  const terminateBackgroundProcess = async (processId: string) => {
    try {
      await serverApi.terminateBackgroundProcess(props.instance.id, processId)
    } catch (error) {
      log.warn("Failed to terminate background process", error)
    }
  }

  const instancePaletteCommands = createMemo(() => props.paletteCommands())
  const paletteOpen = createMemo(() => isCommandPaletteOpen(props.instance.id))

  const keyboardShortcuts = createMemo(() =>
    [keyboardRegistry.get("session-prev"), keyboardRegistry.get("session-next")].filter(
      (shortcut): shortcut is KeyboardShortcut => Boolean(shortcut),
    ),
  )

  interface PendingSidebarAction {
    action: SessionSidebarRequestAction
    id: number
  }

  let sidebarActionId = 0
  const [pendingSidebarAction, setPendingSidebarAction] = createSignal<PendingSidebarAction | null>(null)

  const triggerKeyboardEvent = (target: HTMLElement, options: { key: string; code: string; keyCode: number }) => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: options.key,
        code: options.code,
        keyCode: options.keyCode,
        which: options.keyCode,
        bubbles: true,
        cancelable: true,
      }),
    )
  }

  const focusAgentSelectorControl = () => {
    const agentTrigger = leftDrawerContentEl()?.querySelector("[data-agent-selector]") as HTMLElement | null
    if (!agentTrigger) return false
    agentTrigger.focus()
    setTimeout(() => triggerKeyboardEvent(agentTrigger, { key: "Enter", code: "Enter", keyCode: 13 }), 10)
    return true
  }

  const focusModelSelectorControl = () => {
    const input = leftDrawerContentEl()?.querySelector<HTMLInputElement>("[data-model-selector]")
    if (!input) return false
    input.focus()
    setTimeout(() => triggerKeyboardEvent(input, { key: "ArrowDown", code: "ArrowDown", keyCode: 40 }), 10)
    return true
  }

  const focusVariantSelectorControl = () => {
    const input = leftDrawerContentEl()?.querySelector<HTMLInputElement>("[data-thinking-selector]")
    if (!input) return false
    input.focus()
    setTimeout(() => triggerKeyboardEvent(input, { key: "ArrowDown", code: "ArrowDown", keyCode: 40 }), 10)
    return true
  }

  createEffect(() => {
    const pending = pendingSidebarAction()
    if (!pending) return
    const action = pending.action
    const contentReady = Boolean(leftDrawerContentEl())
    if (!contentReady) {
      return
    }
    if (action === "show-session-list") {
      setPendingSidebarAction(null)
      return
    }
    const handled =
      action === "focus-agent-selector"
        ? focusAgentSelectorControl()
        : action === "focus-model-selector"
          ? focusModelSelectorControl()
          : focusVariantSelectorControl()
    if (handled) {
      setPendingSidebarAction(null)
    }
  })

  const handleSidebarRequest = (action: SessionSidebarRequestAction) => {
    setPendingSidebarAction({ action, id: sidebarActionId++ })
    if (!leftPinned() && !leftOpen()) {
      setLeftOpen(true)
      measureDrawerHost()
    }
  }

  const closeFloatingDrawersIfAny = () => {
    let handled = false
    if (!leftPinned() && leftOpen()) {
      setLeftOpen(false)
      blurIfInside(leftDrawerContentEl())
      focusTarget(leftToggleButtonEl())
      handled = true
    }
    if (!rightPinned() && rightOpen()) {
      setRightOpen(false)
      blurIfInside(rightDrawerContentEl())
      focusTarget(rightToggleButtonEl())
      handled = true
    }
    return handled
  }

  onMount(() => {
    if (typeof window === "undefined") return
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      if (!closeFloatingDrawersIfAny()) return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener("keydown", handleEscape, true)
    onCleanup(() => window.removeEventListener("keydown", handleEscape, true))
  })

  const handleSessionSelect = (sessionId: string) => {
    if (sessionId === "info") {
      setActiveSession(props.instance.id, sessionId)
      return
    }

    const session = allInstanceSessions().get(sessionId)
    if (!session) return

    if (session.parentId === null) {
      setActiveParentSession(props.instance.id, sessionId)
      return
    }

    const parentId = session.parentId
    if (!parentId) return

    batch(() => {
      setActiveParentSession(props.instance.id, parentId)
      setActiveSession(props.instance.id, sessionId)
    })
  }


  const evictSession = (sessionId: string) => {
    if (!sessionId) return
    log.info("Evicting cached session", { instanceId: props.instance.id, sessionId })
    const store = messageStoreBus.getInstance(props.instance.id)
    store?.clearSession(sessionId)
    clearSessionRenderCache(props.instance.id, sessionId)
  }

  const scheduleEvictions = (ids: string[]) => {
    if (!ids.length) return
    setPendingEvictions((current) => {
      const existing = new Set(current)
      const next = [...current]
      ids.forEach((id) => {
        if (!existing.has(id)) {
          next.push(id)
          existing.add(id)
        }
      })
      return next
    })
  }

  createEffect(() => {
    const pending = pendingEvictions()
    if (!pending.length) return
    const cached = new Set(cachedSessionIds())
    const remaining: string[] = []
    pending.forEach((id) => {
      if (cached.has(id)) {
        remaining.push(id)
      } else {
        evictSession(id)
      }
    })
    if (remaining.length !== pending.length) {
      setPendingEvictions(remaining)
    }
  })

  createEffect(() => {
    const instanceSessions = allInstanceSessions()
    const activeId = activeSessionIdForInstance()

    setCachedSessionIds((current) => {
      const next = current.filter((id) => id !== "info" && instanceSessions.has(id))

      const touch = (id: string | null) => {
        if (!id || id === "info") return
        if (!instanceSessions.has(id)) return

        const index = next.indexOf(id)
        if (index !== -1) {
          next.splice(index, 1)
        }
        next.unshift(id)
      }

      touch(activeId)

      const trimmed = next.length > SESSION_CACHE_LIMIT ? next.slice(0, SESSION_CACHE_LIMIT) : next

      const trimmedSet = new Set(trimmed)
      const removed = current.filter((id) => !trimmedSet.has(id))
      if (removed.length) {
        scheduleEvictions(removed)
      }
      return trimmed
    })
  })

  const showEmbeddedSidebarToggle = createMemo(() => !leftPinned() && !leftOpen())

  const drawerContainer = () => {
    const host = drawerHost()
    if (host) return host
    if (typeof document !== "undefined") {
      return document.body
    }
    return undefined
  }

  const fallbackDrawerTop = () => props.tabBarOffset
  const floatingTop = () => {
    const measured = floatingDrawerTop()
    if (measured > 0) return measured
    return fallbackDrawerTop()
  }
  const floatingTopPx = () => `${floatingTop()}px`
  const floatingHeight = () => {
    const measured = floatingDrawerHeight()
    if (measured > 0) return `${measured}px`
    return `calc(100% - ${floatingTop()}px)`
  }

  const scheduleDrawerMeasure = () => {
    if (typeof window === "undefined") {
      measureDrawerHost()
      return
    }
    requestAnimationFrame(() => measureDrawerHost())
  }

  const applyDrawerWidth = (side: "left" | "right", width: number) => {
    if (side === "left") {
      setSessionSidebarWidth(width)
    } else {
      setRightDrawerWidth(width)
    }
    scheduleDrawerMeasure()
  }

  const handleDrawerPointerMove = (clientX: number) => {
    const side = activeResizeSide()
    if (!side) return
    const startWidth = resizeStartWidth()
    const clamp = side === "left" ? clampWidth : clampRightWidth
    const delta = side === "left" ? clientX - resizeStartX() : resizeStartX() - clientX
    const nextWidth = clamp(startWidth + delta)
    applyDrawerWidth(side, nextWidth)
  }

  function stopDrawerResize() {
    setActiveResizeSide(null)
    document.removeEventListener("mousemove", drawerMouseMove)
    document.removeEventListener("mouseup", drawerMouseUp)
    document.removeEventListener("touchmove", drawerTouchMove)
    document.removeEventListener("touchend", drawerTouchEnd)
  }

  function drawerMouseMove(event: MouseEvent) {
    event.preventDefault()
    handleDrawerPointerMove(event.clientX)
  }

  function drawerMouseUp() {
    stopDrawerResize()
  }

  function drawerTouchMove(event: TouchEvent) {
    const touch = event.touches[0]
    if (!touch) return
    event.preventDefault()
    handleDrawerPointerMove(touch.clientX)
  }

  function drawerTouchEnd() {
    stopDrawerResize()
  }

  const startDrawerResize = (side: "left" | "right", clientX: number) => {
    setActiveResizeSide(side)
    setResizeStartX(clientX)
    setResizeStartWidth(side === "left" ? sessionSidebarWidth() : rightDrawerWidth())
    document.addEventListener("mousemove", drawerMouseMove)
    document.addEventListener("mouseup", drawerMouseUp)
    document.addEventListener("touchmove", drawerTouchMove, { passive: false })
    document.addEventListener("touchend", drawerTouchEnd)
  }

  const handleDrawerResizeMouseDown = (side: "left" | "right") => (event: MouseEvent) => {
    event.preventDefault()
    startDrawerResize(side, event.clientX)
  }

  const handleDrawerResizeTouchStart = (side: "left" | "right") => (event: TouchEvent) => {
    const touch = event.touches[0]
    if (!touch) return
    event.preventDefault()
    startDrawerResize(side, touch.clientX)
  }

  onCleanup(() => {
    stopDrawerResize()
  })

  const clampSplitWidth = (value: number) => {
    const min = 200
    const maxByDrawer = Math.max(min, Math.floor(rightDrawerWidth() * 0.65))
    const max = Math.min(560, maxByDrawer)
    return Math.min(max, Math.max(min, Math.floor(value)))
  }

  const persistSplitWidth = (mode: "changes" | "files", width: number) => {
    if (typeof window === "undefined") return
    const key = mode === "changes" ? RIGHT_PANEL_CHANGES_SPLIT_WIDTH_KEY : RIGHT_PANEL_FILES_SPLIT_WIDTH_KEY
    window.localStorage.setItem(key, String(width))
  }

  function stopSplitResize() {
    setActiveSplitResize(null)
    if (typeof document === "undefined") return
    document.removeEventListener("mousemove", splitMouseMove)
    document.removeEventListener("mouseup", splitMouseUp)
    document.removeEventListener("touchmove", splitTouchMove)
    document.removeEventListener("touchend", splitTouchEnd)
  }

  function splitMouseMove(event: MouseEvent) {
    const mode = activeSplitResize()
    if (!mode) return
    event.preventDefault()
    const delta = event.clientX - splitResizeStartX()
    const next = clampSplitWidth(splitResizeStartWidth() + delta)
    if (mode === "changes") setChangesSplitWidth(next)
    else setFilesSplitWidth(next)
  }

  function splitMouseUp() {
    const mode = activeSplitResize()
    if (mode) {
      const width = mode === "changes" ? changesSplitWidth() : filesSplitWidth()
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
    else setFilesSplitWidth(next)
  }

  function splitTouchEnd() {
    const mode = activeSplitResize()
    if (mode) {
      const width = mode === "changes" ? changesSplitWidth() : filesSplitWidth()
      persistSplitWidth(mode, width)
    }
    stopSplitResize()
  }

  const startSplitResize = (mode: "changes" | "files", clientX: number) => {
    if (typeof document === "undefined") return
    setActiveSplitResize(mode)
    setSplitResizeStartX(clientX)
    setSplitResizeStartWidth(mode === "changes" ? changesSplitWidth() : filesSplitWidth())
    document.addEventListener("mousemove", splitMouseMove)
    document.addEventListener("mouseup", splitMouseUp)
    document.addEventListener("touchmove", splitTouchMove, { passive: false })
    document.addEventListener("touchend", splitTouchEnd)
  }

  const handleSplitResizeMouseDown = (mode: "changes" | "files") => (event: MouseEvent) => {
    event.preventDefault()
    startSplitResize(mode, event.clientX)
  }

  const handleSplitResizeTouchStart = (mode: "changes" | "files") => (event: TouchEvent) => {
    const touch = event.touches[0]
    if (!touch) return
    event.preventDefault()
    startSplitResize(mode, touch.clientX)
  }

  onCleanup(() => {
    stopSplitResize()
  })

  type DrawerViewState = "pinned" | "floating-open" | "floating-closed"


  const leftDrawerState = createMemo<DrawerViewState>(() => {
    if (leftPinned()) return "pinned"
    return leftOpen() ? "floating-open" : "floating-closed"
  })

  const rightDrawerState = createMemo<DrawerViewState>(() => {
    if (rightPinned()) return "pinned"
    return rightOpen() ? "floating-open" : "floating-closed"
  })

  const leftAppBarButtonLabel = () => {
    const state = leftDrawerState()
    if (state === "pinned") return t("instanceShell.leftDrawer.toggle.pinned")
    return t("instanceShell.leftDrawer.toggle.open")
  }

  const rightAppBarButtonLabel = () => {
    const state = rightDrawerState()
    if (state === "pinned") return t("instanceShell.rightDrawer.toggle.pinned")
    return t("instanceShell.rightDrawer.toggle.open")
  }

  const leftAppBarButtonIcon = () => {
    return <MenuIcon fontSize="small" />
  }

  const rightAppBarButtonIcon = () => {
    return <MenuIcon fontSize="small" sx={{ transform: "scaleX(-1)" }} />
  }




  const pinLeftDrawer = () => {
    blurIfInside(leftDrawerContentEl())
    batch(() => {
      setLeftPinned(true)
      setLeftOpen(true)
    })
    persistPinIfSupported("left", true)
    measureDrawerHost()
  }

  const unpinLeftDrawer = () => {
    blurIfInside(leftDrawerContentEl())
    batch(() => {
      setLeftPinned(false)
      setLeftOpen(true)
    })
    persistPinIfSupported("left", false)
    measureDrawerHost()
  }

  const pinRightDrawer = () => {
    blurIfInside(rightDrawerContentEl())
    batch(() => {
      setRightPinned(true)
      setRightOpen(true)
    })
    persistPinIfSupported("right", true)
    measureDrawerHost()
  }

  const unpinRightDrawer = () => {
    blurIfInside(rightDrawerContentEl())
    batch(() => {
      setRightPinned(false)
      setRightOpen(true)
    })
    persistPinIfSupported("right", false)
    measureDrawerHost()
  }

  const handleLeftAppBarButtonClick = () => {
    const state = leftDrawerState()
    if (state !== "floating-closed") return
    setLeftOpen(true)
    measureDrawerHost()
  }

  const handleRightAppBarButtonClick = () => {
    const state = rightDrawerState()
    if (state !== "floating-closed") return
    setRightOpen(true)
    measureDrawerHost()
  }


  const focusTarget = (element: HTMLElement | null) => {
    if (!element) return
    requestAnimationFrame(() => {
      element.focus()
    })
  }

  const blurIfInside = (element: HTMLElement | null) => {
    if (typeof document === "undefined" || !element) return
    const active = document.activeElement as HTMLElement | null
    if (active && element.contains(active)) {
      active.blur()
    }
  }

  const closeLeftDrawer = () => {
    if (leftDrawerState() === "pinned") return
    blurIfInside(leftDrawerContentEl())
    setLeftOpen(false)
    focusTarget(leftToggleButtonEl())
  }
  const closeRightDrawer = () => {
    if (rightDrawerState() === "pinned") return
    blurIfInside(rightDrawerContentEl())
    setRightOpen(false)
    focusTarget(rightToggleButtonEl())
  }

  const formattedUsedTokens = () => formatTokenTotal(tokenStats().used)


  const formattedAvailableTokens = () => {
    const avail = tokenStats().avail
    if (typeof avail === "number") {
      return formatTokenTotal(avail)
    }
    return "--"
  }

  const LeftDrawerContent = () => (
    <div class="flex flex-col h-full min-h-0" ref={setLeftDrawerContentEl}>
      <div class="flex flex-col gap-2 px-4 py-3 border-b border-base">
        <div class="flex items-center justify-between gap-2">
          <span class="session-sidebar-title text-sm font-semibold uppercase text-primary">
            {t("instanceShell.leftPanel.sessionsTitle")}
          </span>
          <div class="flex items-center gap-2 text-primary">
            <IconButton
              size="small"
              color="inherit"
              aria-label={t("sessionList.filter.ariaLabel")}
              title={t("sessionList.filter.ariaLabel")}
              aria-pressed={showSessionSearch()}
              onClick={() => setShowSessionSearch((current) => !current)}
              sx={{
                color: showSessionSearch() ? "var(--text-primary)" : "inherit",
                backgroundColor: showSessionSearch() ? "var(--surface-hover)" : "transparent",
                "&:hover": {
                  backgroundColor: "var(--surface-hover)",
                },
              }}
            >
              <Search class={showSessionSearch() ? "w-4 h-4" : "w-4 h-4 opacity-70"} />
            </IconButton>
            <IconButton
              size="small"
              color="inherit"
              aria-label={t("instanceShell.leftPanel.instanceInfo")}
              title={t("instanceShell.leftPanel.instanceInfo")}
              onClick={() => handleSessionSelect("info")}
            >
              <InfoOutlinedIcon fontSize="small" />
            </IconButton>
            <Show when={!isPhoneLayout()}>
              <IconButton
                size="small"
                color="inherit"
                aria-label={leftPinned() ? t("instanceShell.leftDrawer.unpin") : t("instanceShell.leftDrawer.pin")}
                onClick={() => (leftPinned() ? unpinLeftDrawer() : pinLeftDrawer())}
              >
                {leftPinned() ? <PushPinIcon fontSize="small" /> : <PushPinOutlinedIcon fontSize="small" />}
              </IconButton>
            </Show>
            <Show when={leftDrawerState() === "floating-open"}>
              <IconButton
                size="small"
                color="inherit"
                aria-label={t("instanceShell.leftDrawer.toggle.close")}
                title={t("instanceShell.leftDrawer.toggle.close")}
                onClick={closeLeftDrawer}
              >
                <MenuOpenIcon fontSize="small" />
              </IconButton>
            </Show>
          </div>
        </div>
        <div class="session-sidebar-shortcuts">
          <Show when={keyboardShortcuts().length}>
            <KeyboardHint shortcuts={keyboardShortcuts()} separator=" " showDescription={false} />
          </Show>
        </div>
      </div>

      <div class="session-sidebar flex flex-col flex-1 min-h-0">
        <SessionList
          instanceId={props.instance.id}
          threads={sessionThreads()}
          activeSessionId={activeSessionIdForInstance()}
          onSelect={handleSessionSelect}
          onNew={() => {
            const result = props.onNewSession()
            if (result instanceof Promise) {
              void result.catch((error) => log.error("Failed to create session:", error))
            }
          }}
          enableFilterBar={showSessionSearch()}
          showHeader={false}
          showFooter={false}
        />

        <div class="session-sidebar-separator" />
          <Show when={activeSessionForInstance()}>
            {(activeSession) => (
              <>
                <div class="session-sidebar-controls px-4 py-4 border-t border-base flex flex-col gap-3">
                  <WorktreeSelector instanceId={props.instance.id} sessionId={activeSession().id} />

                  <AgentSelector
                    instanceId={props.instance.id}
                    sessionId={activeSession().id}
                    currentAgent={activeSession().agent}
                    onAgentChange={(agent) => props.handleSidebarAgentChange(activeSession().id, agent)}
                  />

                <ModelSelector
                  instanceId={props.instance.id}
                  sessionId={activeSession().id}
                  currentModel={activeSession().model}
                  onModelChange={(model) => props.handleSidebarModelChange(activeSession().id, model)}
                />

                <ThinkingSelector instanceId={props.instance.id} currentModel={activeSession().model} />

                <div class="session-sidebar-selector-hints" aria-hidden="true">
                  <Kbd shortcut="cmd+shift+a" />
                  <Kbd shortcut="cmd+shift+m" />
                  <Kbd shortcut="cmd+shift+t" />
                </div>
              </div>
            </>
          )}
        </Show>
      </div>
    </div>
  )

  const RightDrawerContent = () => {
    const worktreeSlugForViewer = createMemo(() => {
      const sessionId = activeSessionIdForInstance()
      if (sessionId && sessionId !== "info") {
        return getWorktreeSlugForSession(props.instance.id, sessionId)
      }
      return getDefaultWorktreeSlug(props.instance.id)
    })

    createEffect(() => {
      // Reset browser state when worktree context changes.
      worktreeSlugForViewer()
      setBrowserPath(".")
      setBrowserEntries(null)
      setBrowserError(null)
      setBrowserSelectedPath(null)
      setBrowserSelectedContent(null)
      setBrowserSelectedError(null)
      setBrowserSelectedLoading(false)
    })

    const browserClient = createMemo(() => getOrCreateWorktreeClient(props.instance.id, worktreeSlugForViewer()))

    const bestDiffFile = createMemo<string | null>(() => {
      const diffs = activeSessionDiffs()
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
      const diffs = activeSessionDiffs()
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
      if (isPhoneLayout()) {
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

    const renderFilesTabContent = () => {
      const sessionId = activeSessionIdForInstance()
      if (!sessionId || sessionId === "info") {
        return (
          <div class="right-panel-empty">
            <span class="text-xs">{t("instanceShell.sessionChanges.noSessionSelected")}</span>
          </div>
        )
      }

      const diffs = activeSessionDiffs()
      if (diffs === undefined) {
        return (
          <div class="right-panel-empty">
            <span class="text-xs">{t("instanceShell.sessionChanges.loading")}</span>
          </div>
        )
      }

      if (!Array.isArray(diffs) || diffs.length === 0) {
        return (
          <div class="right-panel-empty">
            <span class="text-xs">{t("instanceShell.sessionChanges.empty")}</span>
          </div>
        )
      }

      const sorted = [...diffs].sort((a, b) => String(a.file || "").localeCompare(String(b.file || "")))
      const totals = sorted.reduce(
        (acc, item) => {
          acc.additions += typeof item.additions === "number" ? item.additions : 0
          acc.deletions += typeof item.deletions === "number" ? item.deletions : 0
          return acc
        },
        { additions: 0, deletions: 0 },
      )

      const mostChanged = sorted.reduce((best, item) => {
        const bestAdd = typeof (best as any)?.additions === "number" ? (best as any).additions : 0
        const bestDel = typeof (best as any)?.deletions === "number" ? (best as any).deletions : 0
        const bestScore = bestAdd + bestDel

        const add = typeof (item as any)?.additions === "number" ? (item as any).additions : 0
        const del = typeof (item as any)?.deletions === "number" ? (item as any).deletions : 0
        const score = add + del

        if (score > bestScore) return item
        if (score < bestScore) return best
        return String(item.file || "").localeCompare(String((best as any)?.file || "")) < 0 ? item : best
      }, sorted[0])

      // Auto-select the most-changed file if none selected.
      const currentSelected = selectedFile()
      const selectedFileData = sorted.find((f) => f.file === currentSelected) || mostChanged

      const scopeKey = `${props.instance.id}:${sessionId}`

      const isBinaryDiff = (item: any) => {
        const before = typeof item?.before === "string" ? item.before : ""
        const after = typeof item?.after === "string" ? item.after : ""
        if (before.length === 0 && after.length === 0) {
          // OpenCode stores empty before/after for binaries.
          return true
        }
        return false
      }

      return (
        <div class="files-tab-container">
          <div class="files-tab-header">
            <div class="files-tab-header-row">
              <button
                type="button"
                class="files-toggle-button"
                onClick={() => {
                  setChangesListTouched(true)
                  setChangesListOpen((current) => {
                    const next = !current
                    persistListOpen("changes", next)
                    return next
                  })
                }}
              >
                {changesListOpen() ? "Hide files" : "Show files"}
              </button>

              <span class="files-tab-selected-path" title={selectedFileData?.file || ""}>
                {selectedFileData?.file || ""}
              </span>

              <div class="files-tab-stats" style={{ "flex": "0 0 auto" }}>
                <span class="files-tab-stat files-tab-stat-additions">
                  <span class="files-tab-stat-value">+{totals.additions}</span>
                </span>
                <span class="files-tab-stat files-tab-stat-deletions">
                  <span class="files-tab-stat-value">-{totals.deletions}</span>
                </span>
              </div>
            </div>
          </div>

          <div class="files-tab-body">
            <Show
              when={!isPhoneLayout() && changesListOpen()}
              fallback={
                <div class="file-viewer-panel flex-1">
                  <div class="file-viewer-header">
                    <div class="file-viewer-toolbar">
                      <button
                        type="button"
                        class={`file-viewer-toolbar-button${diffViewMode() === "split" ? " active" : ""}`}
                        aria-pressed={diffViewMode() === "split"}
                        onClick={() => setDiffViewMode("split")}
                      >
                        Split
                      </button>
                      <button
                        type="button"
                        class={`file-viewer-toolbar-button${diffViewMode() === "unified" ? " active" : ""}`}
                        aria-pressed={diffViewMode() === "unified"}
                        onClick={() => setDiffViewMode("unified")}
                      >
                        Unified
                      </button>
                      <button
                        type="button"
                        class={`file-viewer-toolbar-button${diffContextMode() === "collapsed" ? " active" : ""}`}
                        aria-pressed={diffContextMode() === "collapsed"}
                        onClick={() => setDiffContextMode("collapsed")}
                        title="Hide unchanged regions"
                      >
                        Collapsed
                      </button>
                      <button
                        type="button"
                        class={`file-viewer-toolbar-button${diffContextMode() === "expanded" ? " active" : ""}`}
                        aria-pressed={diffContextMode() === "expanded"}
                        onClick={() => setDiffContextMode("expanded")}
                        title="Show full file"
                      >
                        Expanded
                      </button>
                    </div>
                  </div>
                  <div class="file-viewer-content file-viewer-content--monaco">
                    <Show
                      when={selectedFileData}
                      fallback={
                        <div class="file-viewer-empty">
                          <span class="file-viewer-empty-text">{t("instanceShell.filesShell.viewerEmpty")}</span>
                        </div>
                      }
                    >
                      {(file) => (
                        <Show
                          when={!isBinaryDiff(file())}
                          fallback={
                            <div class="file-viewer-empty">
                              <span class="file-viewer-empty-text">Binary file cannot be displayed</span>
                            </div>
                          }
                        >
                          <MonacoDiffViewer
                            scopeKey={scopeKey}
                            path={String(file().file || "")}
                            before={String((file() as any).before || "")}
                            after={String((file() as any).after || "")}
                            viewMode={diffViewMode()}
                            contextMode={diffContextMode()}
                          />
                        </Show>
                      )}
                    </Show>
                  </div>
                </div>
              }
            >
              <div class="files-split" style={{ "--files-pane-width": `${changesSplitWidth()}px` }}>
                <div class="file-list-panel">
                  <div class="file-list-scroll">
                    <For each={sorted}>
                      {(item) => (
                        <div
                          class={`file-list-item ${selectedFileData?.file === item.file ? "file-list-item-active" : ""}`}
                          onClick={() => {
                            setSelectedFile(item.file)
                            if (isPhoneLayout()) {
                              setChangesListOpen(false)
                            }
                          }}
                        >
                          <div class="file-list-item-content">
                            <div class="file-list-item-path" title={item.file}>
                              {item.file}
                            </div>
                            <div class="file-list-item-stats">
                              <span class="file-list-item-additions">+{item.additions}</span>
                              <span class="file-list-item-deletions">-{item.deletions}</span>
                            </div>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
                <div
                  class="file-split-handle"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize file list"
                  onMouseDown={handleSplitResizeMouseDown("changes")}
                  onTouchStart={handleSplitResizeTouchStart("changes")}
                />
                <div class="file-viewer-panel flex-1">
                  <div class="file-viewer-header">
                    <div class="file-viewer-toolbar">
                      <button
                        type="button"
                        class={`file-viewer-toolbar-button${diffViewMode() === "split" ? " active" : ""}`}
                        aria-pressed={diffViewMode() === "split"}
                        onClick={() => setDiffViewMode("split")}
                      >
                        Split
                      </button>
                      <button
                        type="button"
                        class={`file-viewer-toolbar-button${diffViewMode() === "unified" ? " active" : ""}`}
                        aria-pressed={diffViewMode() === "unified"}
                        onClick={() => setDiffViewMode("unified")}
                      >
                        Unified
                      </button>
                      <button
                        type="button"
                        class={`file-viewer-toolbar-button${diffContextMode() === "collapsed" ? " active" : ""}`}
                        aria-pressed={diffContextMode() === "collapsed"}
                        onClick={() => setDiffContextMode("collapsed")}
                        title="Hide unchanged regions"
                      >
                        Collapsed
                      </button>
                      <button
                        type="button"
                        class={`file-viewer-toolbar-button${diffContextMode() === "expanded" ? " active" : ""}`}
                        aria-pressed={diffContextMode() === "expanded"}
                        onClick={() => setDiffContextMode("expanded")}
                        title="Show full file"
                      >
                        Expanded
                      </button>
                    </div>
                  </div>
                  <div class="file-viewer-content file-viewer-content--monaco">
                    <Show
                      when={selectedFileData}
                      fallback={
                        <div class="file-viewer-empty">
                          <span class="file-viewer-empty-text">{t("instanceShell.filesShell.viewerEmpty")}</span>
                        </div>
                      }
                    >
                      {(file) => (
                        <Show
                          when={!isBinaryDiff(file())}
                          fallback={
                            <div class="file-viewer-empty">
                              <span class="file-viewer-empty-text">Binary file cannot be displayed</span>
                            </div>
                          }
                        >
                          <MonacoDiffViewer
                            scopeKey={scopeKey}
                            path={String(file().file || "")}
                            before={String((file() as any).before || "")}
                            after={String((file() as any).after || "")}
                            viewMode={diffViewMode()}
                            contextMode={diffContextMode()}
                          />
                        </Show>
                      )}
                    </Show>
                  </div>
                </div>
              </div>
            </Show>

            <Show when={isPhoneLayout()}>
              <Show when={changesListOpen()}>
                <div class="file-list-overlay" role="dialog" aria-label="Changes">
                  <div class="file-list-overlay-header">
                    <span class="files-tab-selected-path" title={selectedFileData?.file || ""}>
                      {selectedFileData?.file || ""}
                    </span>
                    <button
                      type="button"
                      class="files-toggle-button"
                      onClick={() => {
                        setChangesListTouched(true)
                        setChangesListOpen(false)
                        persistListOpen("changes", false)
                      }}
                      aria-label="Close files"
                    >
                      Close
                    </button>
                  </div>
                  <div class="file-list-scroll">
                    <For each={sorted}>
                      {(item) => (
                        <div
                          class={`file-list-item ${selectedFileData?.file === item.file ? "file-list-item-active" : ""}`}
                          onClick={() => {
                            setSelectedFile(item.file)
                            setChangesListOpen(false)
                          }}
                          title={item.file}
                        >
                          <div class="file-list-item-content">
                            <div class="file-list-item-path" title={item.file}>
                              {item.file}
                            </div>
                            <div class="file-list-item-stats">
                              <span class="file-list-item-additions">+{item.additions}</span>
                              <span class="file-list-item-deletions">-{item.deletions}</span>
                            </div>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>
            </Show>
          </div>
        </div>
      )
    }

    const renderBrowserTabContent = () => {
      if (browserLoading() && browserEntries() === null) {
        return (
          <div class="right-panel-empty">
            <span class="text-xs">Loading files...</span>
          </div>
        )
      }

      const entries = browserEntries() || []
      const sorted = [...entries].sort((a, b) => {
        const aDir = a.type === "directory" ? 0 : 1
        const bDir = b.type === "directory" ? 0 : 1
        if (aDir !== bDir) return aDir - bDir
        return String(a.name || "").localeCompare(String(b.name || ""))
      })

      const parent = getParentPath(browserPath())
      const scopeKey = `${props.instance.id}:${worktreeSlugForViewer()}`

      const toggleFilesList = () => {
        setFilesListTouched(true)
        setFilesListOpen((current) => {
          const next = !current
          persistListOpen("files", next)
          return next
        })
      }

      const headerDisplayedPath = () => browserSelectedPath() || browserPath()

      return (
        <div class="files-tab-container">
          <div class="files-tab-header">
            <div class="files-tab-header-row">
              <button type="button" class="files-toggle-button" onClick={toggleFilesList}>
                {filesListOpen() ? "Hide files" : "Show files"}
              </button>

              <div class="files-tab-stats">
                <span class="files-tab-stat">
                  <span class="files-tab-selected-path" title={headerDisplayedPath()}>
                    {headerDisplayedPath()}
                  </span>
                </span>
                <Show when={browserLoading()}>
                  <span>Loading…</span>
                </Show>
                <Show when={browserError()}>
                  {(err) => <span class="text-error">{err()}</span>}
                </Show>
              </div>
            </div>
          </div>

          <div class="files-tab-body">
            <Show
              when={!isPhoneLayout() && filesListOpen()}
              fallback={
                <div class="file-viewer-panel flex-1">
                  <div class="file-viewer-content file-viewer-content--monaco">
                    <Show
                      when={browserSelectedLoading()}
                      fallback={
                        <Show
                          when={browserSelectedError()}
                          fallback={
                            <Show
                              when={browserSelectedPath() && browserSelectedContent() !== null
                                ? { path: browserSelectedPath() as string, content: browserSelectedContent() as string }
                                : null}
                              fallback={
                                <div class="file-viewer-empty">
                                  <span class="file-viewer-empty-text">Select a file to preview</span>
                                </div>
                              }
                            >
                              {(payload) => (
                                <MonacoFileViewer
                                  scopeKey={scopeKey}
                                  path={payload().path}
                                  content={payload().content}
                                />
                              )}
                            </Show>
                          }
                        >
                          {(err) => (
                            <div class="file-viewer-empty">
                              <span class="file-viewer-empty-text">{err()}</span>
                            </div>
                          )}
                        </Show>
                      }
                    >
                      <div class="file-viewer-empty">
                        <span class="file-viewer-empty-text">Loading…</span>
                      </div>
                    </Show>
                  </div>
                </div>
              }
            >
              <div class="files-split" style={{ "--files-pane-width": `${filesSplitWidth()}px` }}>
                <div class="file-list-panel">
                  <div class="file-list-scroll">
                    <Show when={parent}>
                      {(p) => (
                        <div class="file-list-item" onClick={() => void loadBrowserEntries(p())}>
                          <div class="file-list-item-content">
                            <div class="file-list-item-path" title={p()}>
                              ..
                            </div>
                          </div>
                        </div>
                      )}
                    </Show>

                    <For each={sorted}>
                      {(item) => (
                        <div
                          class={`file-list-item ${browserSelectedPath() === item.path ? "file-list-item-active" : ""}`}
                          onClick={() => {
                            if (item.type === "directory") {
                              void loadBrowserEntries(item.path)
                              return
                            }
                            void openBrowserFile(item.path)
                          }}
                          title={item.path}
                        >
                          <div class="file-list-item-content">
                            <div class="file-list-item-path" title={item.path}>
                              {item.name}
                            </div>
                            <div class="file-list-item-stats">
                              <span class="text-[10px] text-secondary">{item.type}</span>
                            </div>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
                <div
                  class="file-split-handle"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize file list"
                  onMouseDown={handleSplitResizeMouseDown("files")}
                  onTouchStart={handleSplitResizeTouchStart("files")}
                />

                <div class="file-viewer-panel flex-1">
                  <div class="file-viewer-content file-viewer-content--monaco">
                    <Show
                      when={browserSelectedLoading()}
                      fallback={
                        <Show
                          when={browserSelectedError()}
                          fallback={
                            <Show
                              when={browserSelectedPath() && browserSelectedContent() !== null
                                ? { path: browserSelectedPath() as string, content: browserSelectedContent() as string }
                                : null}
                              fallback={
                                <div class="file-viewer-empty">
                                  <span class="file-viewer-empty-text">Select a file to preview</span>
                                </div>
                              }
                            >
                              {(payload) => (
                                <MonacoFileViewer
                                  scopeKey={scopeKey}
                                  path={payload().path}
                                  content={payload().content}
                                />
                              )}
                            </Show>
                          }
                        >
                          {(err) => (
                            <div class="file-viewer-empty">
                              <span class="file-viewer-empty-text">{err()}</span>
                            </div>
                          )}
                        </Show>
                      }
                    >
                      <div class="file-viewer-empty">
                        <span class="file-viewer-empty-text">Loading…</span>
                      </div>
                    </Show>
                  </div>
                </div>
              </div>
            </Show>

            <Show when={isPhoneLayout()}>
              <Show when={filesListOpen()}>
                <div class="file-list-overlay" role="dialog" aria-label="Files">
                  <div class="file-list-overlay-header">
                    <span class="files-tab-selected-path" title={browserPath()}>
                      {browserPath()}
                    </span>
                    <button
                      type="button"
                      class="files-toggle-button"
                      onClick={() => {
                        setFilesListTouched(true)
                        setFilesListOpen(false)
                        persistListOpen("files", false)
                      }}
                      aria-label="Close files"
                    >
                      Close
                    </button>
                  </div>
                  <div class="file-list-scroll">
                    <Show when={parent}>
                      {(p) => (
                        <div class="file-list-item" onClick={() => void loadBrowserEntries(p())}>
                          <div class="file-list-item-content">
                            <div class="file-list-item-path" title={p()}>
                              ..
                            </div>
                          </div>
                        </div>
                      )}
                    </Show>

                    <For each={sorted}>
                      {(item) => (
                        <div
                          class={`file-list-item ${browserSelectedPath() === item.path ? "file-list-item-active" : ""}`}
                          onClick={() => {
                            if (item.type === "directory") {
                              void loadBrowserEntries(item.path)
                              return
                            }
                            void openBrowserFile(item.path)
                          }}
                          title={item.path}
                        >
                          <div class="file-list-item-content">
                            <div class="file-list-item-path" title={item.path}>
                              {item.name}
                            </div>
                            <div class="file-list-item-stats">
                              <span class="text-[10px] text-secondary">{item.type}</span>
                            </div>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>
            </Show>
          </div>
        </div>
      )
    }

    const renderStatusSessionChanges = () => {
      const sessionId = activeSessionIdForInstance()
      if (!sessionId || sessionId === "info") {
        return (
          <div class="right-panel-empty right-panel-empty--left">
            <span class="text-xs">{t("instanceShell.sessionChanges.noSessionSelected")}</span>
          </div>
        )
      }

      const diffs = activeSessionDiffs()
      if (diffs === undefined) {
        return (
          <div class="right-panel-empty right-panel-empty--left">
            <span class="text-xs">{t("instanceShell.sessionChanges.loading")}</span>
          </div>
        )
      }

      if (!Array.isArray(diffs) || diffs.length === 0) {
        return (
          <div class="right-panel-empty right-panel-empty--left">
            <span class="text-xs">{t("instanceShell.sessionChanges.empty")}</span>
          </div>
        )
      }

      const sorted = [...diffs].sort((a, b) => String(a.file || "").localeCompare(String(b.file || "")))
      const totals = sorted.reduce(
        (acc, item) => {
          acc.additions += typeof item.additions === "number" ? item.additions : 0
          acc.deletions += typeof item.deletions === "number" ? item.deletions : 0
          return acc
        },
        { additions: 0, deletions: 0 },
      )

      const openChangesTab = (file?: string) => {
        if (file) {
          setSelectedFile(file)
        }
        setRightPanelTab("changes")
      }

      return (
        <div class="flex flex-col gap-3 min-h-0">
          <div class="flex items-center justify-between gap-2 text-[11px] text-secondary">
            <span>{t("instanceShell.sessionChanges.filesChanged", { count: sorted.length })}</span>
            <span class="flex items-center gap-2">
              <span style={{ color: "var(--session-status-idle-fg)" }}>{`+${totals.additions}`}</span>
              <span style={{ color: "var(--session-status-working-fg)" }}>{`-${totals.deletions}`}</span>
            </span>
          </div>

          <div class="rounded-md border border-base bg-surface-secondary p-2 max-h-[40vh] overflow-y-auto">
            <div class="flex flex-col">
              <For each={sorted}>
                {(item) => (
                  <button
                    type="button"
                    class="border-b border-base last:border-b-0 text-left hover:bg-surface-muted rounded-sm"
                    onClick={() => openChangesTab(item.file)}
                    title={t("instanceShell.sessionChanges.actions.show")}
                  >
                    <div class="flex items-center justify-between gap-3">
                      <div
                        class="text-xs font-mono text-primary min-w-0 flex-1 overflow-hidden whitespace-nowrap"
                        title={item.file}
                        style="text-overflow: ellipsis; direction: rtl; text-align: left; unicode-bidi: plaintext;"
                      >
                        {item.file}
                      </div>
                      <div class="flex items-center gap-2 text-[11px] flex-shrink-0">
                        <span style={{ color: "var(--session-status-idle-fg)" }}>{`+${item.additions}`}</span>
                        <span style={{ color: "var(--session-status-working-fg)" }}>{`-${item.deletions}`}</span>
                      </div>
                    </div>
                  </button>
                )}
              </For>
            </div>
          </div>
        </div>
      )
    }

    const renderPlanSectionContent = () => {
      const sessionId = activeSessionIdForInstance()
      if (!sessionId || sessionId === "info") {
        return (
          <div class="right-panel-empty right-panel-empty--left">
            <span class="text-xs">{t("instanceShell.plan.noSessionSelected")}</span>
          </div>
        )
      }
      const todoState = latestTodoState()
      if (!todoState) {
        return (
          <div class="right-panel-empty right-panel-empty--left">
            <span class="text-xs">{t("instanceShell.plan.empty")}</span>
          </div>
        )
      }
      return <TodoListView state={todoState} emptyLabel={t("instanceShell.plan.empty")} showStatusLabel={false} />
    }

    const renderBackgroundProcesses = () => {
      const processes = backgroundProcessList()
      if (processes.length === 0) {
        return (
          <div class="right-panel-empty right-panel-empty--left">
            <span class="text-xs">{t("instanceShell.backgroundProcesses.empty")}</span>
          </div>
        )
      }

      return (
        <div class="flex flex-col gap-2">
          <For each={processes}>
            {(process) => (
              <div class="status-process-card">
                <div class="status-process-header">
                  <span class="status-process-title">{process.title}</span>
                  <div class="status-process-meta">
                    <span>{t("instanceShell.backgroundProcesses.status", { status: process.status })}</span>
                    <Show when={typeof process.outputSizeBytes === "number"}>
                      <span>
                        {t("instanceShell.backgroundProcesses.output", {
                          sizeKb: Math.round((process.outputSizeBytes ?? 0) / 1024),
                        })}
                      </span>
                    </Show>
                  </div>
                </div>
                <div class="status-process-actions">
                  <button
                    type="button"
                    class="button-tertiary w-full p-1 inline-flex items-center justify-center"
                    onClick={() => openBackgroundOutput(process)}
                    aria-label={t("instanceShell.backgroundProcesses.actions.output")}
                    title={t("instanceShell.backgroundProcesses.actions.output")}
                  >
                    <TerminalSquare class="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    class="button-tertiary w-full p-1 inline-flex items-center justify-center"
                    disabled={process.status !== "running"}
                    onClick={() => stopBackgroundProcess(process.id)}
                    aria-label={t("instanceShell.backgroundProcesses.actions.stop")}
                    title={t("instanceShell.backgroundProcesses.actions.stop")}
                  >
                    <XOctagon class="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    class="button-tertiary w-full p-1 inline-flex items-center justify-center"
                    onClick={() => terminateBackgroundProcess(process.id)}
                    aria-label={t("instanceShell.backgroundProcesses.actions.terminate")}
                    title={t("instanceShell.backgroundProcesses.actions.terminate")}
                  >
                    <Trash2 class="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}
          </For>
        </div>
      )
    }

    const statusSections = [
      {
        id: "session-changes",
        labelKey: "instanceShell.rightPanel.sections.sessionChanges",
        render: renderStatusSessionChanges,
      },
      {
        id: "plan",
        labelKey: "instanceShell.rightPanel.sections.plan",
        render: renderPlanSectionContent,
      },
      {
        id: "background-processes",
        labelKey: "instanceShell.rightPanel.sections.backgroundProcesses",
        render: renderBackgroundProcesses,
      },
      {
        id: "mcp",
        labelKey: "instanceShell.rightPanel.sections.mcp",
        render: () => (
          <InstanceServiceStatus
            initialInstance={props.instance}
            sections={["mcp"]}
            showSectionHeadings={false}
            class="space-y-2"
          />
        ),
      },
      {
        id: "lsp",
        labelKey: "instanceShell.rightPanel.sections.lsp",
        render: () => (
          <InstanceServiceStatus
            initialInstance={props.instance}
            sections={["lsp"]}
            showSectionHeadings={false}
            class="space-y-2"
          />
        ),
      },
      {
        id: "plugins",
        labelKey: "instanceShell.rightPanel.sections.plugins",
        render: () => (
          <InstanceServiceStatus
            initialInstance={props.instance}
            sections={["plugins"]}
            showSectionHeadings={false}
            class="space-y-2"
          />
        ),
      },
    ]

    createEffect(() => {
      const currentExpanded = new Set(rightPanelExpandedItems())
      if (statusSections.every((section) => currentExpanded.has(section.id))) return
      setRightPanelExpandedItems(statusSections.map((section) => section.id))
    })

    const handleAccordionChange = (values: string[]) => {
      setRightPanelExpandedItems(values)
    }

    const isSectionExpanded = (id: string) => rightPanelExpandedItems().includes(id)

    const renderStatusTabContent = () => (
      <div class="status-tab-container">
        <Show when={activeSessionForInstance()}>
          {(activeSession) => (
            <ContextUsagePanel
              instanceId={props.instance.id}
              sessionId={activeSession().id}
              class="status-tab-context-panel"
            />
          )}
        </Show>

        <Accordion.Root
          class="right-panel-accordion"
          collapsible
          multiple
          value={rightPanelExpandedItems()}
          onChange={handleAccordionChange}
        >
          <For each={statusSections}>
            {(section) => (
              <Accordion.Item
                value={section.id}
                class="right-panel-accordion-item"
              >
                <Accordion.Header>
                  <Accordion.Trigger class="right-panel-accordion-trigger">
                    <span>{t(section.labelKey)}</span>
                    <ChevronDown
                      class={`right-panel-accordion-chevron ${isSectionExpanded(section.id) ? "right-panel-accordion-chevron-expanded" : ""}`}
                    />
                  </Accordion.Trigger>
                </Accordion.Header>
                <Accordion.Content class="right-panel-accordion-content">
                  {section.render()}
                </Accordion.Content>
              </Accordion.Item>
            )}
          </For>
        </Accordion.Root>
      </div>
    )

    const tabClass = (tab: RightPanelTab) =>
      `right-panel-tab ${rightPanelTab() === tab ? "right-panel-tab-active" : "right-panel-tab-inactive"}`

    return (
      <div class="flex flex-col h-full" ref={setRightDrawerContentEl}>
        <div class="right-panel-tab-bar">
          <div class="tab-container">
            <div class="tab-scroll">
              <div class="tab-strip">
                <div class="tab-strip-shortcuts text-primary">
                  <Show when={rightDrawerState() === "floating-open"}>
                    <IconButton
                      size="small"
                      color="inherit"
                      aria-label={t("instanceShell.rightDrawer.toggle.close")}
                      title={t("instanceShell.rightDrawer.toggle.close")}
                      onClick={closeRightDrawer}
                    >
                      <MenuOpenIcon fontSize="small" sx={{ transform: "scaleX(-1)" }} />
                    </IconButton>
                  </Show>
                  <Show when={!isPhoneLayout()}>
                    <IconButton
                      size="small"
                      color="inherit"
                      aria-label={rightPinned() ? t("instanceShell.rightDrawer.unpin") : t("instanceShell.rightDrawer.pin")}
                      onClick={() => (rightPinned() ? unpinRightDrawer() : pinRightDrawer())}
                    >
                      {rightPinned() ? <PushPinIcon fontSize="small" /> : <PushPinOutlinedIcon fontSize="small" />}
                    </IconButton>
                  </Show>
                </div>

                <div class="tab-strip-tabs" role="tablist" aria-label={t("instanceShell.rightPanel.tabs.ariaLabel")}>
                  <button
                    type="button"
                    role="tab"
                    class={tabClass("changes")}
                    aria-selected={rightPanelTab() === "changes"}
                    onClick={() => setRightPanelTab("changes")}
                  >
                    <span class="tab-label">{t("instanceShell.rightPanel.tabs.changes")}</span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    class={tabClass("files")}
                    aria-selected={rightPanelTab() === "files"}
                    onClick={() => setRightPanelTab("files")}
                  >
                    <span class="tab-label">{t("instanceShell.rightPanel.tabs.files")}</span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    class={tabClass("status")}
                    aria-selected={rightPanelTab() === "status"}
                    onClick={() => setRightPanelTab("status")}
                  >
                    <span class="tab-label">{t("instanceShell.rightPanel.tabs.status")}</span>
                  </button>
                </div>

                <div class="tab-strip-spacer" />
              </div>
            </div>
          </div>
        </div>

        <div class="flex-1 overflow-y-auto">
          <Show when={rightPanelTab() === "changes"}>{renderFilesTabContent()}</Show>
          <Show when={rightPanelTab() === "files"}>{renderBrowserTabContent()}</Show>
          <Show when={rightPanelTab() === "status"}>{renderStatusTabContent()}</Show>
        </div>
      </div>
    )
  }

  const renderLeftPanel = () => {
    if (leftPinned()) {
      return (
        <Box
          class="session-sidebar-container"
          sx={{
            width: `${sessionSidebarWidth()}px`,
            flexShrink: 0,
            borderRight: "1px solid var(--border-base)",
            backgroundColor: "var(--surface-secondary)",
            height: "100%",
            minHeight: 0,
            position: "relative",
          }}
        >
          <div
            class="session-resize-handle session-resize-handle--left"
            onMouseDown={handleDrawerResizeMouseDown("left")}
            onTouchStart={handleDrawerResizeTouchStart("left")}
            role="presentation"
            aria-hidden="true"
          />
          <LeftDrawerContent />
        </Box>
      )
    }
    const container = drawerContainer()
    const modalProps = container ? { container: container as Element } : undefined
    return (
      <Drawer
        anchor="left"
        variant="temporary"
        open={leftOpen()}
        onClose={closeLeftDrawer}
        ModalProps={modalProps}
        sx={{
          "& .MuiDrawer-paper": {
            width: isPhoneLayout() ? "100vw" : `${sessionSidebarWidth()}px`,
            boxSizing: "border-box",
            borderRight: isPhoneLayout() ? "none" : "1px solid var(--border-base)",
            backgroundColor: "var(--surface-secondary)",
            backgroundImage: "none",
            color: "var(--text-primary)",
            boxShadow: "none",
            borderRadius: 0,
            top: floatingTopPx(),
            height: floatingHeight(),
          },

          "& .MuiBackdrop-root": {
            backgroundColor: "transparent",
          },
        }}
      >
        <Show when={!isPhoneLayout()}>
          <div
            class="session-resize-handle session-resize-handle--left"
            onMouseDown={handleDrawerResizeMouseDown("left")}
            onTouchStart={handleDrawerResizeTouchStart("left")}
            role="presentation"
            aria-hidden="true"
          />
        </Show>
        <LeftDrawerContent />
      </Drawer>
    )
  }


  const renderRightPanel = () => {
    if (rightPinned()) {
      return (
        <Box
          class="session-right-panel"
          sx={{
            width: `${rightDrawerWidth()}px`,
            flexShrink: 0,
            borderLeft: "1px solid var(--border-base)",
            backgroundColor: "var(--surface-secondary)",
            height: "100%",
            minHeight: 0,
            position: "relative",
          }}
        >
          <div
            class="session-resize-handle session-resize-handle--right"
            onMouseDown={handleDrawerResizeMouseDown("right")}
            onTouchStart={handleDrawerResizeTouchStart("right")}
            role="presentation"
            aria-hidden="true"
          />
          <RightDrawerContent />
        </Box>
      )
    }
    const container = drawerContainer()
    const modalProps = container ? { container: container as Element } : undefined
    return (
      <Drawer
        anchor="right"
        variant="temporary"
        open={rightOpen()}
        onClose={closeRightDrawer}
        ModalProps={modalProps}
        sx={{
          "& .MuiDrawer-paper": {
            width: isPhoneLayout() ? "100vw" : `${rightDrawerWidth()}px`,
            boxSizing: "border-box",
            borderLeft: isPhoneLayout() ? "none" : "1px solid var(--border-base)",
            backgroundColor: "var(--surface-secondary)",
            backgroundImage: "none",
            color: "var(--text-primary)",
            boxShadow: "none",
            borderRadius: 0,
            top: floatingTopPx(),
            height: floatingHeight(),
          },
          "& .MuiBackdrop-root": {
            backgroundColor: "transparent",
          },
        }}
      >
        <Show when={!isPhoneLayout()}>
          <div
            class="session-resize-handle session-resize-handle--right"
            onMouseDown={handleDrawerResizeMouseDown("right")}
            onTouchStart={handleDrawerResizeTouchStart("right")}
            role="presentation"
            aria-hidden="true"
          />
        </Show>
        <RightDrawerContent />
      </Drawer>

    )
  }

  const hasSessions = createMemo(() => activeSessions().size > 0)

  const showingInfoView = createMemo(() => activeSessionIdForInstance() === "info")

  const sessionLayout = (
    <div
      class="session-shell-panels flex flex-1 min-h-0 overflow-x-hidden"
      ref={(element) => {
        setDrawerHost(element)
        measureDrawerHost()
      }}
    >
      {renderLeftPanel()}

      <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowX: "hidden" }}>
        <AppBar position="sticky" color="default" elevation={0} class="border-b border-base">
          <Toolbar variant="dense" class="session-toolbar flex flex-wrap items-center gap-2 py-0 min-h-[40px]">
            <Show
              when={!isPhoneLayout()}
              fallback={
                <div class="flex flex-col w-full gap-1.5">
                  <div class="flex flex-wrap items-center justify-between gap-2 w-full">
                    <Show when={leftDrawerState() === "floating-closed"}>
                      <IconButton
                        ref={setLeftToggleButtonEl}
                        color="inherit"
                        onClick={handleLeftAppBarButtonClick}
                        aria-label={leftAppBarButtonLabel()}
                        size="small"
                        aria-expanded={leftDrawerState() !== "floating-closed"}
                      >
                        {leftAppBarButtonIcon()}
                      </IconButton>
                    </Show>

                    <div class="flex flex-wrap items-center gap-1 justify-center">
                      <PermissionNotificationBanner
                        instanceId={props.instance.id}
                        onClick={() => setPermissionModalOpen(true)}
                      />
                      <button
                        type="button"
                        class="connection-status-button px-2 py-0.5 text-xs"
                        onClick={handleCommandPaletteClick}
                        aria-label={t("instanceShell.commandPalette.openAriaLabel")}
                        style={{ flex: "0 0 auto", width: "auto" }}
                      >
                        {t("instanceShell.commandPalette.button")}
                      </button>
                      <span class="connection-status-shortcut-hint">
                        <Kbd shortcut="cmd+shift+p" />
                      </span>
                      <span
                        class={`status-indicator ${connectionStatusClass()}`}
                        aria-label={t("instanceShell.connection.ariaLabel", { status: connectionStatusLabel() })}
                      >
                        <span class="status-dot" />
                      </span>
                    </div>

                    <Show when={rightDrawerState() === "floating-closed"}>
                      <IconButton
                        ref={setRightToggleButtonEl}
                        color="inherit"
                        onClick={handleRightAppBarButtonClick}
                        aria-label={rightAppBarButtonLabel()}
                        size="small"
                        aria-expanded={rightDrawerState() !== "floating-closed"}
                      >
                        {rightAppBarButtonIcon()}
                      </IconButton>
                    </Show>
                  </div>

                  <div class="flex flex-wrap items-center justify-center gap-2 pb-1">
                    <div class="inline-flex items-center gap-1 rounded-full border border-base px-2 py-0.5 text-xs text-primary">
                      <span class="uppercase text-[10px] tracking-wide text-muted">
                        {t("instanceShell.metrics.usedLabel")}
                      </span>
                      <span class="font-semibold text-primary">{formattedUsedTokens()}</span>
                    </div>
                    <div class="inline-flex items-center gap-1 rounded-full border border-base px-2 py-0.5 text-xs text-primary">
                      <span class="uppercase text-[10px] tracking-wide text-muted">
                        {t("instanceShell.metrics.availableLabel")}
                      </span>
                      <span class="font-semibold text-primary">{formattedAvailableTokens()}</span>
                    </div>
                  </div>
                </div>
              }
            >
              <div class="session-toolbar-left flex items-center gap-3 min-w-0">
                <Show when={leftDrawerState() === "floating-closed"}>
                  <IconButton
                    ref={setLeftToggleButtonEl}
                    color="inherit"
                    onClick={handleLeftAppBarButtonClick}
                    aria-label={leftAppBarButtonLabel()}
                    size="small"
                    aria-expanded={leftDrawerState() !== "floating-closed"}
                  >
                    {leftAppBarButtonIcon()}
                  </IconButton>
                </Show>

                <Show when={!showingInfoView()}>
                  <div class="inline-flex items-center gap-1 rounded-full border border-base px-2 py-0.5 text-xs text-primary">
                    <span class="uppercase text-[10px] tracking-wide text-muted">
                      {t("instanceShell.metrics.usedLabel")}
                    </span>
                    <span class="font-semibold text-primary">{formattedUsedTokens()}</span>
                  </div>
                  <div class="inline-flex items-center gap-1 rounded-full border border-base px-2 py-0.5 text-xs text-primary">
                    <span class="uppercase text-[10px] tracking-wide text-muted">
                      {t("instanceShell.metrics.availableLabel")}
                    </span>
                    <span class="font-semibold text-primary">{formattedAvailableTokens()}</span>
                  </div>
                </Show>
              </div>

              <div class="session-toolbar-center flex-1 flex items-center justify-center gap-2 min-w-[160px]">
                <PermissionNotificationBanner
                  instanceId={props.instance.id}
                  onClick={() => setPermissionModalOpen(true)}
                />
                <button
                  type="button"
                  class="connection-status-button px-2 py-0.5 text-xs"
                  onClick={handleCommandPaletteClick}
                  aria-label={t("instanceShell.commandPalette.openAriaLabel")}
                  style={{ flex: "0 0 auto", width: "auto" }}
                >
                  {t("instanceShell.commandPalette.button")}
                </button>
                <span class="connection-status-shortcut-hint">
                  <Kbd shortcut="cmd+shift+p" />
                </span>
              </div>

              <div class="session-toolbar-right flex items-center gap-3">
                <div class="connection-status-meta flex items-center gap-3">
                  <Show when={connectionStatus() === "connected"}>
                    <span class="status-indicator connected">
                      <span class="status-dot" />
                      <span class="status-text">{t("instanceShell.connection.connected")}</span>
                    </span>
                  </Show>
                  <Show when={connectionStatus() === "connecting"}>
                    <span class="status-indicator connecting">
                      <span class="status-dot" />
                      <span class="status-text">{t("instanceShell.connection.connecting")}</span>
                    </span>
                  </Show>
                  <Show when={connectionStatus() === "error" || connectionStatus() === "disconnected"}>
                    <span class="status-indicator disconnected">
                      <span class="status-dot" />
                      <span class="status-text">{t("instanceShell.connection.disconnected")}</span>
                    </span>
                  </Show>
                </div>
                <Show when={rightDrawerState() === "floating-closed"}>
                  <IconButton
                    ref={setRightToggleButtonEl}
                    color="inherit"
                    onClick={handleRightAppBarButtonClick}
                    aria-label={rightAppBarButtonLabel()}
                    size="small"
                    aria-expanded={rightDrawerState() !== "floating-closed"}
                  >
                    {rightAppBarButtonIcon()}
                  </IconButton>
                </Show>
              </div>
            </Show>
          </Toolbar>
        </AppBar>

        <Box
          component="main"
          sx={{ flexGrow: 1, minHeight: 0, display: "flex", flexDirection: "column", overflowX: "hidden" }}
          class="content-area"
        >
          <Show
            when={showingInfoView()}
            fallback={
              <Show
                when={cachedSessionIds().length > 0 && activeSessionIdForInstance()}
                fallback={
                  <div class="flex items-center justify-center h-full">
                    <div class="text-center text-gray-500 dark:text-gray-400">
                      <p class="mb-2">{t("instanceShell.empty.title")}</p>
                      <p class="text-sm">{t("instanceShell.empty.description")}</p>
                    </div>
                  </div>
                }
              >
                <For each={cachedSessionIds()}>
                  {(sessionId) => {
                    const isActive = () => activeSessionIdForInstance() === sessionId
                    return (
                      <div
                        class="session-cache-pane flex flex-col flex-1 min-h-0"
                        style={{ display: isActive() ? "flex" : "none" }}
                        data-session-id={sessionId}
                        aria-hidden={!isActive()}
                      >
                        <SessionView
                          sessionId={sessionId}
                          activeSessions={activeSessions()}
                          instanceId={props.instance.id}
                          instanceFolder={props.instance.folder}
                          escapeInDebounce={props.escapeInDebounce}
                          showSidebarToggle={showEmbeddedSidebarToggle()}
                          onSidebarToggle={() => setLeftOpen(true)}
                          forceCompactStatusLayout={showEmbeddedSidebarToggle()}
                          isActive={isActive()}
                        />
                      </div>
                    )
                  }}
                </For>
              </Show>
            }
          >
            <div class="info-view-pane flex flex-col flex-1 min-h-0 overflow-y-auto">
              <InfoView instanceId={props.instance.id} />
            </div>
          </Show>
        </Box>
      </Box>

      {renderRightPanel()}
    </div>
  )

  return (
    <>
      <div class="instance-shell2 flex flex-col flex-1 min-h-0">
        <Show when={hasSessions()} fallback={<InstanceWelcomeView instance={props.instance} />}>
          {sessionLayout}
        </Show>
      </div>

      <CommandPalette
        open={paletteOpen()}
        onClose={() => hideCommandPalette(props.instance.id)}
        commands={instancePaletteCommands()}
        onExecute={props.onExecuteCommand}
      />

      <BackgroundProcessOutputDialog
        open={showBackgroundOutput()}
        instanceId={props.instance.id}
        process={selectedBackgroundProcess()}
        onClose={closeBackgroundOutput}
      />

      <PermissionApprovalModal
        instanceId={props.instance.id}
        isOpen={permissionModalOpen()}
        onClose={() => setPermissionModalOpen(false)}
      />
    </>
  )
}

export default InstanceShell2
