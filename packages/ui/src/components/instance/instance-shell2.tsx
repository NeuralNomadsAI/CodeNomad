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
import { Accordion } from "@kobalte/core"
import {
  ChevronDown,
  PanelLeftOpen,
  PanelLeftClose,
  PanelRightOpen,
  PanelRightClose,
  Pin,
  PinOff,
  HelpCircle,
  FileText,
  Clock,
  FolderGit,
  GitBranch,
  Eye,
  Edit3,
  PenLine,
  Plus,
  Trash2,
  CheckCircle,
  XCircle,
  Loader2,
  ListChecks,
} from "lucide-solid"
import { Separator } from "../ui/separator"
import { cn } from "../../lib/cn"
import type { Instance } from "../../types/instance"
import type { Command } from "../../lib/commands"
import {
  activeParentSessionId,
  activeSessionId as activeSessionMap,
  getSessionFamily,
  getSessionInfo,
  setActiveSession,
  loading as sessionLoading,
} from "../../stores/sessions"
import { keyboardRegistry, type KeyboardShortcut } from "../../lib/keyboard-registry"
import { messageStoreBus } from "../../stores/message-v2/bus"
import { clearSessionRenderCache } from "../message-block"
import { buildCustomCommandEntries } from "../../lib/command-utils"
import { getCommands as getInstanceCommands } from "../../stores/commands"
import { isOpen as isCommandPaletteOpen, hideCommandPalette, showCommandPalette } from "../../stores/command-palette"
import SessionList from "../session-list"
import KeyboardHint from "../keyboard-hint"
import InstanceWelcomeView from "../instance-welcome-view"
import InfoView from "../info-view"
import AgentSelector from "../agent-selector"
import ModelSelector from "../model-selector"
import ThinkingSelector from "../thinking-selector"
import PermissionToggle from "../permission-toggle"
import CommandPalette from "../command-palette"
import ShortcutsDialog from "../shortcuts-dialog"
import Kbd from "../kbd"
import { TodoListView } from "../tool-call/renderers/todo"
import ContextProgressBar from "../context-progress-bar"
import SessionView from "../session/session-view"
import {
  getFilesTouched,
  getRecentActions,
  getGitStatus,
  updateGitStatus,
  type FileOperationType,
  type RecentAction,
} from "../../stores/workspace-state"
import { serverApi } from "../../lib/api-client"
import { formatTokenTotal } from "../../lib/formatters"
import { sseManager } from "../../lib/sse-manager"
import { getLogger } from "../../lib/logger"
import {
  SESSION_SIDEBAR_EVENT,
  type SessionSidebarRequestAction,
  type SessionSidebarRequestDetail,
} from "../../lib/session-sidebar-events"
import { useConfig } from "../../stores/preferences"
import { registerSidebarControls, unregisterSidebarControls } from "../../stores/sidebar-controls"

const log = getLogger("session")

function createMediaQuery(query: string): () => boolean {
  if (typeof window === "undefined") return () => false
  const mql = window.matchMedia(query)
  const [matches, setMatches] = createSignal(mql.matches)
  const handler = (event: MediaQueryListEvent) => setMatches(event.matches)
  mql.addEventListener("change", handler)
  onCleanup(() => mql.removeEventListener("change", handler))
  return matches
}

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

const DEFAULT_SESSION_SIDEBAR_WIDTH = 280
const MIN_SESSION_SIDEBAR_WIDTH = 220
const MAX_SESSION_SIDEBAR_WIDTH = 360
const RIGHT_DRAWER_WIDTH = 260
const MIN_RIGHT_DRAWER_WIDTH = 200
const MAX_RIGHT_DRAWER_WIDTH = 380
const SESSION_CACHE_LIMIT = 2
const APP_BAR_HEIGHT = 56
const LEFT_DRAWER_STORAGE_KEY = "opencode-session-sidebar-width-v8"
const RIGHT_DRAWER_STORAGE_KEY = "opencode-session-right-drawer-width-v1"
const LEFT_PIN_STORAGE_KEY = "opencode-session-left-drawer-pinned-v1"
const RIGHT_PIN_STORAGE_KEY = "opencode-session-right-drawer-pinned-v1"




type LayoutMode = "desktop" | "tablet" | "phone"

const clampWidth = (value: number) => Math.min(MAX_SESSION_SIDEBAR_WIDTH, Math.max(MIN_SESSION_SIDEBAR_WIDTH, value))
const clampRightWidth = (value: number) => Math.min(MAX_RIGHT_DRAWER_WIDTH, Math.max(MIN_RIGHT_DRAWER_WIDTH, value))
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

const InstanceShell2: Component<InstanceShellProps> = (props) => {
  const [sessionSidebarWidth, setSessionSidebarWidth] = createSignal(DEFAULT_SESSION_SIDEBAR_WIDTH)
  const [rightDrawerWidth, setRightDrawerWidth] = createSignal(RIGHT_DRAWER_WIDTH)
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
  const [rightPanelExpandedItems, setRightPanelExpandedItems] = createSignal<string[]>(["tasks", "git", "actions", "files"])
  const [shortcutsDialogOpen, setShortcutsDialogOpen] = createSignal(false)

  const { preferences, updateLastUsedBinary } = useConfig()
  const [selectedBinary, setSelectedBinary] = createSignal(preferences().lastUsedBinary || "opencode")

  createEffect(() => {
    const next = preferences().lastUsedBinary
    if (next && next !== selectedBinary()) {
      setSelectedBinary(next)
    }
  })

  const messageStore = createMemo(() => messageStoreBus.getOrCreate(props.instance.id))

  const desktopQuery = createMediaQuery("(min-width: 1280px)")
  const tabletQuery = createMediaQuery("(min-width: 768px)")

  const layoutMode = createMemo<LayoutMode>(() => {
    if (desktopQuery()) return "desktop"
    if (tabletQuery()) return "tablet"
    return "phone"
  })

  const isPhoneLayout = createMemo(() => layoutMode() === "phone")
  const leftPinningSupported = createMemo(() => layoutMode() === "desktop")
  const rightPinningSupported = createMemo(() => layoutMode() !== "phone")

  const persistPinIfSupported = (side: "left" | "right", value: boolean) => {
    if (side === "left" && !leftPinningSupported()) return
    if (side === "right" && !rightPinningSupported()) return
    persistPinState(side, value)
  }

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
        const rightSaved = readStoredPinState("right", true)
        setLeftPinned(false)
        setLeftOpen(false)
        setRightPinned(rightSaved)
        setRightOpen(rightSaved)
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
    const toolbar = host.querySelector<HTMLElement>(".session-toolbar")
    const toolbarHeight = toolbar?.offsetHeight ?? APP_BAR_HEIGHT
    setFloatingDrawerTop(rect.top + toolbarHeight)
    setFloatingDrawerHeight(Math.max(0, rect.height - toolbarHeight))
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

    const savedRight = window.localStorage.getItem(RIGHT_DRAWER_STORAGE_KEY)
    if (savedRight) {
      const parsed = Number.parseInt(savedRight, 10)
      if (Number.isFinite(parsed)) {
        setRightDrawerWidth(clampRightWidth(parsed))
      }
    }

    const handleResize = () => {
      const width = clampWidth(window.innerWidth * 0.3)
      setSessionSidebarWidth((current) => clampWidth(current || width))
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
    props.tabBarOffset
    requestAnimationFrame(() => measureDrawerHost())
  })

  // Fetch git status when instance is ready
  createEffect(() => {
    if (props.instance.status !== "ready") return
    const folder = props.instance.folder
    if (!folder) return

    // Fetch git status
    serverApi.fetchGitStatus(folder).then((result) => {
      if (result.available) {
        updateGitStatus(props.instance.id, {
          branch: result.branch ?? "unknown",
          ahead: result.ahead ?? 0,
          behind: result.behind ?? 0,
          staged: result.staged ?? [],
          modified: result.modified ?? [],
          untracked: result.untracked ?? [],
        })
      }
    }).catch((err) => {
      log.warn("Failed to fetch git status", err)
    })
  })

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

  // Auto-expand tasks section when there are pending todos
  createEffect(() => {
    const todoState = latestTodoState()
    if (!todoState?.todos?.length) return
    const hasPending = todoState.todos.some(t => t.status !== "completed")
    if (hasPending) {
      setRightPanelExpandedItems((prev) => {
        if (prev.includes("tasks")) return prev
        return [...prev, "tasks"]
      })
    }
  })

  const connectionStatus = () => sseManager.getStatus(props.instance.id)
  const connectionStatusClass = () => {
    const status = connectionStatus()
    if (status === "connecting") return "connecting"
    if (status === "connected") return "connected"
    return "disconnected"
  }

  // Register sidebar toggle controls into the shared store so session-tabs.tsx can render them
  createEffect(() => {
    registerSidebarControls({
      onLeftToggle: handleLeftAppBarButtonClick,
      onRightToggle: handleRightAppBarButtonClick,
      leftLabel: leftAppBarButtonLabel(),
      rightLabel: rightAppBarButtonLabel(),
      leftIcon: leftDrawerState() === "floating-closed" ? "open" : "close",
      rightIcon: rightDrawerState() === "floating-closed" ? "open" : "close",
      leftDisabled: leftDrawerState() === "pinned",
      rightDisabled: rightDrawerState() === "pinned",
    })
  })

  onCleanup(() => {
    unregisterSidebarControls()
  })

  const handleCommandPaletteClick = () => {
    showCommandPalette(props.instance.id)
  }

  const customCommands = createMemo(() => buildCustomCommandEntries(props.instance.id, getInstanceCommands(props.instance.id)))

  const instancePaletteCommands = createMemo(() => [...props.paletteCommands(), ...customCommands()])
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
    const handled = action === "focus-agent-selector" ? focusAgentSelectorControl() : focusModelSelectorControl()
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
    setActiveSession(props.instance.id, sessionId)
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
    const sessionsMap = activeSessions()
    const parentId = parentSessionIdForInstance()
    const activeId = activeSessionIdForInstance()
    setCachedSessionIds((current) => {
      const next: string[] = []
      const append = (id: string | null) => {
        if (!id || id === "info") return
        if (!sessionsMap.has(id)) return
        if (next.includes(id)) return
        next.push(id)
      }

      append(parentId)
      append(activeId)

      const limit = parentId ? SESSION_CACHE_LIMIT + 1 : SESSION_CACHE_LIMIT
      const trimmed = next.length > limit ? next.slice(0, limit) : next
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

  const fallbackDrawerTop = () => APP_BAR_HEIGHT + props.tabBarOffset
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
    if (state === "pinned") return "Left drawer pinned"
    if (state === "floating-closed") return "Open left drawer"
    return "Close left drawer"
  }

  const rightAppBarButtonLabel = () => {
    const state = rightDrawerState()
    if (state === "pinned") return "Right drawer pinned"
    if (state === "floating-closed") return "Open right drawer"
    return "Close right drawer"
  }

  const leftAppBarButtonIcon = () => {
    const state = leftDrawerState()
    if (state === "floating-closed") return <PanelLeftOpen class="w-4 h-4" />
    return <PanelLeftClose class="w-4 h-4" />
  }

  const rightAppBarButtonIcon = () => {
    const state = rightDrawerState()
    if (state === "floating-closed") return <PanelRightOpen class="w-4 h-4" />
    return <PanelRightClose class="w-4 h-4" />
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
    if (state === "pinned") return
    if (state === "floating-closed") {
      setLeftOpen(true)
      measureDrawerHost()
      return
    }
    blurIfInside(leftDrawerContentEl())
    setLeftOpen(false)
    focusTarget(leftToggleButtonEl())
    measureDrawerHost()
  }

  const handleRightAppBarButtonClick = () => {
    const state = rightDrawerState()
    if (state === "pinned") return
    if (state === "floating-closed") {
      setRightOpen(true)
      measureDrawerHost()
      return
    }
    blurIfInside(rightDrawerContentEl())
    setRightOpen(false)
    focusTarget(rightToggleButtonEl())
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
      <div class="flex flex-col min-h-0 bg-secondary flex-1">
        <SessionList
          instanceId={props.instance.id}
          sessions={activeSessions()}
          activeSessionId={activeSessionIdForInstance()}
          onSelect={handleSessionSelect}
          onClose={(id) => {
            const result = props.onCloseSession(id)
            if (result instanceof Promise) {
              void result.catch((error) => log.error("Failed to close session:", error))
            }
          }}
          onNew={() => {
            const result = props.onNewSession()
            if (result instanceof Promise) {
              void result.catch((error) => log.error("Failed to create session:", error))
            }
          }}
          showHeader={false}
          showFooter={false}
          leftPinned={leftPinned()}
          onTogglePin={() => (leftPinned() ? unpinLeftDrawer() : pinLeftDrawer())}
          isPhoneLayout={isPhoneLayout()}
        />

        <Separator />
        <Show when={activeSessionForInstance()}>
          {(activeSession) => (
            <>
              <div class="flex flex-col bg-muted px-4 py-4 pb-6 border-t border-border">
                {/* Session group */}
                <div class="flex flex-col gap-4 [&>*]:w-full">
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
                </div>

                <Separator class="my-4" />

                {/* Reasoning group */}
                <div class="flex flex-col gap-4 [&>*]:w-full">
                  <ThinkingSelector
                    currentModelId={`${activeSession().model.providerId}/${activeSession().model.modelId}`}
                    instanceId={props.instance.id}
                  />
                </div>

                <Separator class="my-4" />

                {/* Permissions group */}
                <div class="flex flex-col gap-4 [&>*]:w-full">
                  <PermissionToggle
                    instanceId={props.instance.id}
                    sessionId={activeSession().id}
                  />
                </div>
              </div>
            </>
          )}
        </Show>
      </div>
    </div>
  )

  const RightDrawerContent = () => {
    // Workspace data
    const filesTouched = createMemo(() => getFilesTouched(props.instance.id))
    const recentActions = createMemo(() => getRecentActions(props.instance.id))
    const gitStatus = createMemo(() => getGitStatus(props.instance.id))

    // Helper functions for workspace rendering
    const getOperationIcon = (op: FileOperationType) => {
      switch (op) {
        case "read": return <Eye class="w-3 h-3" />
        case "edit": return <Edit3 class="w-3 h-3" />
        case "write": return <PenLine class="w-3 h-3" />
        case "create": return <Plus class="w-3 h-3" />
        case "delete": return <Trash2 class="w-3 h-3" />
        default: return <FileText class="w-3 h-3" />
      }
    }

    const getOperationClass = (op: FileOperationType) => {
      switch (op) {
        case "read": return "text-info"
        case "edit": return "text-warning"
        case "write": return "text-success"
        case "create": return "text-success"
        case "delete": return "text-destructive"
        default: return "text-muted-foreground"
      }
    }

    const getStatusIcon = (status: RecentAction["status"]) => {
      switch (status) {
        case "running": return <Loader2 class="w-3 h-3 animate-spin" />
        case "complete": return <CheckCircle class="w-3 h-3" />
        case "error": return <XCircle class="w-3 h-3" />
      }
    }

    const getStatusClass = (status: RecentAction["status"]) => {
      switch (status) {
        case "running": return "text-info"
        case "complete": return "text-success"
        case "error": return "text-destructive"
      }
    }

    const formatRelativeTime = (timestamp: number) => {
      const seconds = Math.floor((Date.now() - timestamp) / 1000)
      if (seconds < 60) return "just now"
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return `${minutes}m ago`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours}h ago`
      return `${Math.floor(hours / 24)}d ago`
    }

    const getFileName = (path: string) => {
      const parts = path.replace(/\\/g, "/").split("/")
      return parts[parts.length - 1] || path
    }

    const getRelativePath = (fullPath: string) => {
      const folder = props.instance.folder?.replace(/\\/g, "/") || ""
      const path = fullPath.replace(/\\/g, "/")
      if (folder && path.startsWith(folder)) {
        return path.slice(folder.length).replace(/^\//, "")
      }
      return path
    }

    const renderPlanSectionContent = () => {
      const sessionId = activeSessionIdForInstance()
      if (!sessionId || sessionId === "info") {
        return <p class="text-xs text-muted-foreground">Select a session to view plan.</p>
      }
      const todoState = latestTodoState()
      if (!todoState) {
        return <p class="text-xs text-muted-foreground">Nothing planned yet.</p>
      }
      return <TodoListView state={todoState} emptyLabel="Nothing planned yet." showStatusLabel={false} />
    }

    // Files Touched section content
    const renderFilesTouchedContent = () => (
      <Show
        when={filesTouched().length > 0}
        fallback={<p class="text-xs text-muted-foreground italic py-2">No files touched yet</p>}
      >
        <ul class="space-y-0.5">
          <For each={filesTouched().slice(0, 20)}>
            {(file) => (
              <li>
                <button type="button" class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors hover:bg-accent text-left" title={file.path}>
                  <span class={`flex-shrink-0 ${getOperationClass(file.operation)}`}>
                    {getOperationIcon(file.operation)}
                  </span>
                  <span class="font-medium text-foreground truncate">{getFileName(file.path)}</span>
                  <span class="text-muted-foreground truncate ml-auto" title={file.path}>{getRelativePath(file.path)}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
        <Show when={filesTouched().length > 20}>
          <p class="text-xs text-muted-foreground mt-2 text-center">+{filesTouched().length - 20} more files</p>
        </Show>
      </Show>
    )

    // Recent Actions section content
    const renderRecentActionsContent = () => (
      <Show
        when={recentActions().length > 0}
        fallback={<p class="text-xs text-muted-foreground italic py-2">No recent actions</p>}
      >
        <ul class="space-y-0.5">
          <For each={recentActions().slice(0, 15)}>
            {(action) => (
              <li class={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${getStatusClass(action.status)}`}>
                <span class="flex-shrink-0">{getStatusIcon(action.status)}</span>
                <span class="truncate text-foreground" title={action.summary}>{action.summary}</span>
                <span class="ml-auto text-muted-foreground flex-shrink-0">{formatRelativeTime(action.timestamp)}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    )

    // Git Status section content
    const renderGitStatusContent = () => (
      <Show
        when={gitStatus()}
        fallback={<p class="text-xs text-muted-foreground italic py-2">Git status not available</p>}
      >
        {(status) => (
          <div class="space-y-3">
            <div class="flex items-center gap-2 text-sm">
              <GitBranch class="w-4 h-4 text-info" />
              <span class="font-medium text-foreground">{status().branch}</span>
              <Show when={status().ahead > 0 || status().behind > 0}>
                <span class="flex items-center gap-1 text-xs">
                  <Show when={status().ahead > 0}>
                    <span class="text-success">+{status().ahead}</span>
                  </Show>
                  <Show when={status().behind > 0}>
                    <span class="text-destructive">-{status().behind}</span>
                  </Show>
                </span>
              </Show>
            </div>
            <Show when={status().staged.length > 0}>
              <div class="space-y-1">
                <span class="text-xs font-medium text-success">Staged ({status().staged.length})</span>
                <ul class="space-y-0.5">
                  <For each={status().staged.slice(0, 5)}>
                    {(file) => <li class="text-xs text-muted-foreground truncate pl-2" title={file}>{getFileName(file)}</li>}
                  </For>
                  <Show when={status().staged.length > 5}>
                    <li class="text-xs text-muted-foreground italic pl-2">+{status().staged.length - 5} more</li>
                  </Show>
                </ul>
              </div>
            </Show>
            <Show when={status().modified.length > 0}>
              <div class="space-y-1">
                <span class="text-xs font-medium text-warning">Modified ({status().modified.length})</span>
                <ul class="space-y-0.5">
                  <For each={status().modified.slice(0, 5)}>
                    {(file) => <li class="text-xs text-muted-foreground truncate pl-2" title={file}>{getFileName(file)}</li>}
                  </For>
                  <Show when={status().modified.length > 5}>
                    <li class="text-xs text-muted-foreground italic pl-2">+{status().modified.length - 5} more</li>
                  </Show>
                </ul>
              </div>
            </Show>
            <Show when={status().untracked.length > 0}>
              <div class="space-y-1">
                <span class="text-xs font-medium text-muted-foreground">Untracked ({status().untracked.length})</span>
                <ul class="space-y-0.5">
                  <For each={status().untracked.slice(0, 5)}>
                    {(file) => <li class="text-xs text-muted-foreground truncate pl-2" title={file}>{getFileName(file)}</li>}
                  </For>
                  <Show when={status().untracked.length > 5}>
                    <li class="text-xs text-muted-foreground italic pl-2">+{status().untracked.length - 5} more</li>
                  </Show>
                </ul>
              </div>
            </Show>
            <Show when={status().staged.length === 0 && status().modified.length === 0 && status().untracked.length === 0}>
              <p class="text-xs text-success italic">Working tree clean</p>
            </Show>
          </div>
        )}
      </Show>
    )

    // 4 peer sections - Tasks first, then Git, Actions, Files
    const sections = [
      {
        id: "tasks",
        label: "Tasks",
        icon: () => <ListChecks class="w-4 h-4" />,
        count: () => {
          const todoState = latestTodoState()
          if (!todoState?.todos?.length) return null
          const pending = todoState.todos.filter(t => t.status !== "completed").length
          return pending > 0 ? pending : null
        },
        render: renderPlanSectionContent,
      },
      {
        id: "git",
        label: "Git Status",
        icon: () => <FolderGit class="w-4 h-4" />,
        count: () => {
          const status = gitStatus()
          if (!status) return null
          return `${status.branch}${status.ahead > 0 ? ` ↑${status.ahead}` : ""}${status.behind > 0 ? ` ↓${status.behind}` : ""}`
        },
        render: renderGitStatusContent,
      },
      {
        id: "actions",
        label: "Recent Actions",
        icon: () => <Clock class="w-4 h-4" />,
        count: () => recentActions().length,
        render: renderRecentActionsContent,
      },
      {
        id: "files",
        label: "Files Touched",
        icon: () => <FileText class="w-4 h-4" />,
        count: () => filesTouched().length,
        render: renderFilesTouchedContent,
      },
    ]

    const handleAccordionChange = (values: string[]) => {
      setRightPanelExpandedItems(values)
    }

    const isSectionExpanded = (id: string) => rightPanelExpandedItems().includes(id)

    return (
      <div class="flex flex-col h-full" ref={setRightDrawerContentEl}>
        {/* Pin button row - no header */}
        <Show when={!isPhoneLayout()}>
          <div class="flex justify-end px-3 py-2 border-b border-border">
            <button
              type="button"
              class="inline-flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              aria-label={rightPinned() ? "Unpin right drawer" : "Pin right drawer"}
              onClick={() => (rightPinned() ? unpinRightDrawer() : pinRightDrawer())}
            >
              {rightPinned() ? <Pin class="w-4 h-4" /> : <PinOff class="w-4 h-4" />}
            </button>
          </div>
        </Show>
        <div class="flex-1 overflow-y-auto">
          <Accordion.Root
            class="flex flex-col"
            collapsible
            multiple
            value={rightPanelExpandedItems()}
            onChange={handleAccordionChange}
          >
            <For each={sections}>
              {(section) => (
                <Accordion.Item
                  value={section.id}
                  class="border-b border-border"
                >
                  <Accordion.Header>
                    <Accordion.Trigger class="flex items-center justify-between w-full px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer">
                      <span class="flex items-center gap-2">
                        {section.icon()}
                        {section.label}
                      </span>
                      <span class="flex items-center gap-2">
                        <Show when={section.count() !== null}>
                          <span class="text-xs font-normal text-muted-foreground">{section.count()}</span>
                        </Show>
                        <ChevronDown
                          class={`h-4 w-4 transition-transform duration-150 ${isSectionExpanded(section.id) ? "rotate-180" : ""}`}
                        />
                      </span>
                    </Accordion.Trigger>
                  </Accordion.Header>
                  <Accordion.Content class="px-3 py-2 text-sm text-primary">
                    {section.render()}
                  </Accordion.Content>
                </Accordion.Item>
              )}
            </For>
          </Accordion.Root>
        </div>
      </div>
    )
  }

  const renderLeftPanel = () => {
    if (leftPinned()) {
      return (
        <div
          class="flex flex-col h-full bg-background border-r border-border"
          style={{
            width: `${sessionSidebarWidth()}px`,
            "flex-shrink": "0",
            "border-right": "1px solid hsl(var(--border))",
            "background-color": "hsl(var(--surface-2))",
            height: "100%",
            "min-height": "0",
            position: "relative",
          }}
        >
          <div
            class="absolute top-0 w-1 h-full cursor-col-resize bg-transparent transition-colors z-10 hover:bg-primary right-0"
            onMouseDown={handleDrawerResizeMouseDown("left")}
            onTouchStart={handleDrawerResizeTouchStart("left")}
            role="presentation"
            aria-hidden="true"
          />
          <LeftDrawerContent />
        </div>
      )
    }
    return (
      <Show when={leftOpen()}>
        <div
          class="fixed inset-0 z-40"
          onClick={closeLeftDrawer}
          role="presentation"
        />
        <div
          class="fixed z-50 shadow-xl"
          style={{
            left: "0",
            top: floatingTopPx(),
            height: floatingHeight(),
            width: isPhoneLayout() ? "100vw" : `${sessionSidebarWidth()}px`,
            "border-right": isPhoneLayout() ? "none" : "1px solid hsl(var(--border))",
            "background-color": "hsl(var(--surface-2))",
          }}
        >
          <LeftDrawerContent />
        </div>
      </Show>
    )
  }


  const renderRightPanel = () => {
    if (rightPinned()) {
      return (
        <div
          class="flex flex-col h-full"
          style={{
            width: `${rightDrawerWidth()}px`,
            "flex-shrink": "0",
            "border-left": "1px solid hsl(var(--border))",
            "background-color": "hsl(var(--surface-2))",
            height: "100%",
            "min-height": "0",
            position: "relative",
          }}
        >
          <div
            class="absolute top-0 w-1 h-full cursor-col-resize bg-transparent transition-colors z-10 hover:bg-primary left-0"
            onMouseDown={handleDrawerResizeMouseDown("right")}
            onTouchStart={handleDrawerResizeTouchStart("right")}
            role="presentation"
            aria-hidden="true"
          />
          <RightDrawerContent />
        </div>
      )
    }
    return (
      <Show when={rightOpen()}>
        <div
          class="fixed inset-0 z-40"
          onClick={closeRightDrawer}
          role="presentation"
        />
        <div
          class="fixed z-50 shadow-xl"
          style={{
            right: "0",
            top: floatingTopPx(),
            height: floatingHeight(),
            width: isPhoneLayout() ? "100vw" : `${rightDrawerWidth()}px`,
            "border-left": isPhoneLayout() ? "none" : "1px solid hsl(var(--border))",
            "background-color": "hsl(var(--surface-2))",
          }}
        >
          <RightDrawerContent />
        </div>
      </Show>
    )
  }

  const hasSessions = createMemo(() => activeSessions().size > 0)

  // Check if we're still fetching sessions for this instance (initial load)
  const isFetchingSessions = createMemo(() => {
    return Boolean(sessionLoading().fetchingSessions.get(props.instance.id))
  })

  const showingInfoView = createMemo(() => activeSessionIdForInstance() === "info")

  const sessionLayout = (
    <div
      class="session-shell-panels flex flex-col flex-1 min-h-0 overflow-x-hidden"
      ref={(element) => {
        setDrawerHost(element)
        measureDrawerHost()
      }}
    >
      <div class="flex flex-1 min-h-0 overflow-x-hidden">
        {renderLeftPanel()}

        <main class="flex-grow min-h-0 flex flex-col overflow-x-hidden content-area">
          <Show
            when={showingInfoView()}
            fallback={
              <Show
                when={cachedSessionIds().length > 0 && activeSessionIdForInstance()}
                fallback={
                  <div class="flex items-center justify-center h-full">
                    <div class="text-center text-muted-foreground">
                      <p class="mb-2">No session selected</p>
                      <p class="text-sm">Select a session to view messages</p>
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
        </main>

        {renderRightPanel()}
      </div>
    </div>
  )

  return (
    <>
      <div class="instance-shell2 flex flex-col flex-1 min-h-0">
        <Show
          when={!isFetchingSessions()}
          fallback={
            <div class="flex-1 flex items-center justify-center">
              <div class="text-center text-muted-foreground">
                <div class="w-8 h-8 border-2 border-border border-t-primary rounded-full animate-spin mb-2 mx-auto" />
                <p class="text-sm">Loading sessions...</p>
              </div>
            </div>
          }
        >
          <Show when={hasSessions()} fallback={<InstanceWelcomeView instance={props.instance} />}>
            {sessionLayout}
          </Show>
        </Show>
      </div>

      <CommandPalette
        open={paletteOpen()}
        onClose={() => hideCommandPalette(props.instance.id)}
        commands={instancePaletteCommands()}
        onExecute={props.onExecuteCommand}
      />

      <ShortcutsDialog
        open={shortcutsDialogOpen()}
        onClose={() => setShortcutsDialogOpen(false)}
      />
    </>
  )
}

export default InstanceShell2
