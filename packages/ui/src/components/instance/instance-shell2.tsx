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
  Settings,
  HelpCircle,
} from "lucide-solid"
import AppBar from "@suid/material/AppBar"
import Box from "@suid/material/Box"
import Divider from "@suid/material/Divider"
import Drawer from "@suid/material/Drawer"
import Toolbar from "@suid/material/Toolbar"
import Typography from "@suid/material/Typography"
import useMediaQuery from "@suid/material/useMediaQuery"
import type { Instance } from "../../types/instance"
import type { Command } from "../../lib/commands"
import {
  activeParentSessionId,
  activeSessionId as activeSessionMap,
  getSessionFamily,
  getSessionInfo,
  setActiveSession,
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
import InstanceServiceStatus from "../instance-service-status"
import InstanceMcpControl from "../instance-mcp-control"
import AdvancedSettingsModal from "../advanced-settings-modal"
import AgentSelector from "../agent-selector"
import ModelSelector from "../model-selector"
import CommandPalette from "../command-palette"
import ShortcutsDialog from "../shortcuts-dialog"
import Kbd from "../kbd"
import { TodoListView } from "../tool-call/renderers/todo"
import ContextProgressBar from "../context-progress-bar"
import SessionView from "../session/session-view"
import { formatTokenTotal } from "../../lib/formatters"
import { sseManager } from "../../lib/sse-manager"
import { getLogger } from "../../lib/logger"
import {
  SESSION_SIDEBAR_EVENT,
  type SessionSidebarRequestAction,
  type SessionSidebarRequestDetail,
} from "../../lib/session-sidebar-events"
import { useConfig } from "../../stores/preferences"

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
  const [rightPanelExpandedItems, setRightPanelExpandedItems] = createSignal<string[]>(["lsp", "mcp"])
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = createSignal(false)
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

  const desktopQuery = useMediaQuery("(min-width: 1280px)")

  const tabletQuery = useMediaQuery("(min-width: 768px)")

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
      inputTokens: info?.inputTokens ?? 0,
      outputTokens: info?.outputTokens ?? 0,
      cost: info?.isSubscriptionModel ? 0 : (info?.cost ?? 0),
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

  const connectionStatus = () => sseManager.getStatus(props.instance.id)
  const connectionStatusClass = () => {
    const status = connectionStatus()
    if (status === "connecting") return "connecting"
    if (status === "connected") return "connected"
    return "disconnected"
  }

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
      <div class="session-sidebar flex flex-col flex-1 min-h-0">
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

        <Divider />
        <Show when={activeSessionForInstance()}>
          {(activeSession) => (
            <>
              <div class="session-sidebar-controls px-4 py-4 pb-6 border-t border-base flex flex-col gap-3">
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
            </>
          )}
        </Show>
      </div>
    </div>
  )

  const RightDrawerContent = () => {
    const renderPlanSectionContent = () => {
      const sessionId = activeSessionIdForInstance()
      if (!sessionId || sessionId === "info") {
        return <p class="text-xs text-secondary">Select a session to view plan.</p>
      }
      const todoState = latestTodoState()
      if (!todoState) {
        return <p class="text-xs text-secondary">Nothing planned yet.</p>
      }
      return <TodoListView state={todoState} emptyLabel="Nothing planned yet." showStatusLabel={false} />
    }

    const sections = [
      {
        id: "lsp",
        label: "LSP Servers",
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
         id: "mcp",
         label: "MCP Servers",
         render: () => (
           <InstanceMcpControl
             instance={props.instance}
             class="space-y-2"
             onManage={() => setAdvancedSettingsOpen(true)}
           />
         ),
       },
      {
        id: "plan",
        label: "Plan",
        render: renderPlanSectionContent,
      },
    ]

    createEffect(() => {
      const currentExpanded = new Set(rightPanelExpandedItems())
      if (sections.every((section) => currentExpanded.has(section.id))) return
      setRightPanelExpandedItems(sections.map((section) => section.id))
    })

    const handleAccordionChange = (values: string[]) => {
      setRightPanelExpandedItems(values)
    }

    const isSectionExpanded = (id: string) => rightPanelExpandedItems().includes(id)

    return (
      <div class="flex flex-col h-full" ref={setRightDrawerContentEl}>
          <div class="control-panel-header">
            <Typography variant="subtitle2" class="control-panel-title">
              Status Panel
            </Typography>
            <div class="control-panel-actions">
              <button
                type="button"
                class="icon-button icon-button--md icon-button--ghost"
                aria-label="Open advanced settings"
                onClick={() => setAdvancedSettingsOpen(true)}
              >
                <Settings class="w-4 h-4" />
              </button>
              <Show when={!isPhoneLayout()}>
                <button
                  type="button"
                  class="icon-button icon-button--md icon-button--ghost"
                  aria-label={rightPinned() ? "Unpin right drawer" : "Pin right drawer"}
                  onClick={() => (rightPinned() ? unpinRightDrawer() : pinRightDrawer())}
                >
                  {rightPinned() ? <Pin class="w-4 h-4" /> : <PinOff class="w-4 h-4" />}
                </button>
              </Show>
            </div>
          </div>
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
                  class="control-panel-section"
                >
                  <Accordion.Header>
                    <Accordion.Trigger class="control-panel-trigger">
                      <span>{section.label}</span>
                      <ChevronDown
                        class={`h-4 w-4 transition-transform duration-150 ${isSectionExpanded(section.id) ? "rotate-180" : ""}`}
                      />
                    </Accordion.Trigger>
                  </Accordion.Header>
                  <Accordion.Content class="control-panel-content text-sm text-primary">
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
        <RightDrawerContent />
      </Drawer>

    )
  }

  const hasSessions = createMemo(() => activeSessions().size > 0)

  const showingInfoView = createMemo(() => activeSessionIdForInstance() === "info")

  const sessionLayout = (
    <div
      class="session-shell-panels flex flex-col flex-1 min-h-0 overflow-x-hidden"
      ref={(element) => {
        setDrawerHost(element)
        measureDrawerHost()
      }}
    >
      <AdvancedSettingsModal
        open={advancedSettingsOpen()}
        onClose={() => setAdvancedSettingsOpen(false)}
        selectedBinary={selectedBinary()}
        onBinaryChange={(binary) => {
          setSelectedBinary(binary)
          updateLastUsedBinary(binary)
        }}
      />

      <AppBar position="sticky" color="default" elevation={0} class="border-b border-base">
        <Toolbar variant="dense" class="session-toolbar flex flex-wrap items-center gap-2 py-0 min-h-[40px]">
          <Show
            when={!isPhoneLayout()}
            fallback={
              <div class="flex flex-col w-full gap-1.5">
                <div class="flex flex-wrap items-center justify-between gap-2 w-full">
                  <button
                    ref={setLeftToggleButtonEl}
                    type="button"
                    class="icon-button icon-button--md icon-button--ghost"
                    onClick={handleLeftAppBarButtonClick}
                    aria-label={leftAppBarButtonLabel()}
                    aria-expanded={leftDrawerState() !== "floating-closed"}
                    disabled={leftDrawerState() === "pinned"}
                  >
                    {leftAppBarButtonIcon()}
                  </button>

                  <div class="flex flex-wrap items-center gap-1 justify-center">
                    <button
                      type="button"
                      class="connection-status-button px-2 py-0.5 text-xs"
                      onClick={handleCommandPaletteClick}
                      aria-label="Open command palette"
                      style={{ flex: "0 0 auto", width: "auto" }}
                    >
                      Command Palette
                    </button>
                    <span class="connection-status-shortcut-hint">
                      <Kbd shortcut="cmd+shift+p" />
                    </span>
                    <span
                      class={`status-indicator ${connectionStatusClass()}`}
                      aria-label={`Connection ${connectionStatus()}`}
                    >
                      <span class="status-dot" />
                    </span>
                  </div>

                  <button
                    ref={setRightToggleButtonEl}
                    type="button"
                    class="icon-button icon-button--md icon-button--ghost"
                    onClick={handleRightAppBarButtonClick}
                    aria-label={rightAppBarButtonLabel()}
                    aria-expanded={rightDrawerState() !== "floating-closed"}
                    disabled={rightDrawerState() === "pinned"}
                  >
                    {rightAppBarButtonIcon()}
                  </button>
                </div>

                <div class="header-stats-bar header-stats-bar--compact">
                  <div class="header-stats-pill header-stats-pill--compact">
                    <span class="header-stats-label">In</span>
                    <span class="header-stats-value">{formatTokenTotal(tokenStats().inputTokens)}</span>
                  </div>
                  <div class="header-stats-pill header-stats-pill--compact">
                    <span class="header-stats-label">Out</span>
                    <span class="header-stats-value">{formatTokenTotal(tokenStats().outputTokens)}</span>
                  </div>
                  <ContextProgressBar
                    used={tokenStats().used}
                    available={tokenStats().avail}
                    size="md"
                    showLabels={false}
                    class="header-context-progress"
                  />
                  <div class="header-stats-pill header-stats-pill--compact">
                    <span class="header-stats-label">Cost</span>
                    <span class="header-stats-value">${tokenStats().cost.toFixed(2)}</span>
                  </div>
                </div>
              </div>
            }
          >
             <div class="session-toolbar-left flex items-center gap-3 min-w-0">
               <button
                 ref={setLeftToggleButtonEl}
                 type="button"
                 class="icon-button icon-button--md icon-button--ghost"
                 onClick={handleLeftAppBarButtonClick}
                 aria-label={leftAppBarButtonLabel()}
                 aria-expanded={leftDrawerState() !== "floating-closed"}
                 disabled={leftDrawerState() === "pinned"}
               >
                 {leftAppBarButtonIcon()}
               </button>

               <button
                 type="button"
                 class="icon-button icon-button--md icon-button--ghost"
                 onClick={() => setShortcutsDialogOpen(true)}
                 aria-label="Keyboard shortcuts"
                 title="Keyboard shortcuts"
               >
                 <HelpCircle class="w-4 h-4" />
               </button>
             </div>


              <Show
                when={!showingInfoView()}
                fallback={
                  <div class="session-toolbar-center flex-1 flex items-center justify-center gap-2 min-w-[160px]">
                    <button
                      type="button"
                      class="connection-status-button px-2 py-0.5 text-xs"
                      onClick={handleCommandPaletteClick}
                      aria-label="Open command palette"
                    >
                      Command Palette
                    </button>
                    <Kbd shortcut="cmd+shift+p" />
                  </div>
                }
              >
                <div class="header-stats-bar">
                  <div class="header-stats-pill">
                    <span class="header-stats-label">In</span>
                    <span class="header-stats-value">{formatTokenTotal(tokenStats().inputTokens)}</span>
                  </div>
                  <div class="header-stats-pill">
                    <span class="header-stats-label">Out</span>
                    <span class="header-stats-value">{formatTokenTotal(tokenStats().outputTokens)}</span>
                  </div>
                  <ContextProgressBar
                    used={tokenStats().used}
                    available={tokenStats().avail}
                    size="md"
                    showLabels={false}
                    class="header-context-progress"
                  />
                  <div class="header-stats-pill">
                    <span class="header-stats-label">Cost</span>
                    <span class="header-stats-value">${tokenStats().cost.toFixed(2)}</span>
                  </div>
                </div>
              </Show>


            <div class="session-toolbar-right flex items-center gap-3">
              <div class="connection-status-meta flex items-center gap-3">
                <Show when={connectionStatus() === "connected"}>
                  <span class="status-indicator connected">
                    <span class="status-dot" />
                    <span class="status-text">Connected</span>
                  </span>
                </Show>
                <Show when={connectionStatus() === "connecting"}>
                  <span class="status-indicator connecting">
                    <span class="status-dot" />
                    <span class="status-text">Connecting...</span>
                  </span>
                </Show>
                <Show when={connectionStatus() === "error" || connectionStatus() === "disconnected"}>
                  <span class="status-indicator disconnected">
                    <span class="status-dot" />
                    <span class="status-text">Disconnected</span>
                  </span>
                </Show>
              </div>
              <button
                ref={setRightToggleButtonEl}
                type="button"
                class="icon-button icon-button--md icon-button--ghost"
                onClick={handleRightAppBarButtonClick}
                aria-label={rightAppBarButtonLabel()}
                aria-expanded={rightDrawerState() !== "floating-closed"}
                disabled={rightDrawerState() === "pinned"}
              >
                {rightAppBarButtonIcon()}
              </button>
            </div>
          </Show>
        </Toolbar>
      </AppBar>

      <Box sx={{ display: "flex", flex: 1, minHeight: 0, overflowX: "hidden" }}>
        {renderLeftPanel()}

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
        </Box>

        {renderRightPanel()}
      </Box>
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

      <ShortcutsDialog
        open={shortcutsDialogOpen()}
        onClose={() => setShortcutsDialogOpen(false)}
      />
    </>
  )
}

export default InstanceShell2
