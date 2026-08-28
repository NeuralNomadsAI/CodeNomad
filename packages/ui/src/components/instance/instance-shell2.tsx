import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
  type Component,
} from "solid-js"
import AppBar from "@suid/material/AppBar"
import Box from "@suid/material/Box"
import Drawer from "@suid/material/Drawer"
import IconButton from "@suid/material/IconButton"
import Toolbar from "@suid/material/Toolbar"
import useMediaQuery from "@suid/material/useMediaQuery"
import type { Instance } from "../../types/instance"
import type { Command } from "../../lib/commands"
import { keyboardRegistry, type KeyboardShortcut } from "../../lib/keyboard-registry"

import { isOpen as isCommandPaletteOpen, hideCommandPalette, showCommandPalette } from "../../stores/command-palette"
import InstanceWelcomeView from "../instance-welcome-view"
import InfoView from "../info-view"
import CommandPalette from "../command-palette"
import PermissionNotificationBanner from "../permission-notification-banner"
import PermissionApprovalModal from "../permission-approval-modal"
import { getFormRequestAutoOpenId } from "../form-request-auto-open"
import { shouldRenderFormInFallback } from "../form-request-tool-target"
import { messageStoreBus } from "../../stores/message-v2/bus"
import SessionView from "../session/session-view"
import MessageSection from "../message-section"
import PromptAttachmentsBar from "../prompt-input/PromptAttachmentsBar"
import { formatTokenTotal } from "../../lib/formatters"
import ContextMeter from "../context-meter"
import ActionOverflowMenu, { type ActionOverflowMenuItem } from "../action-overflow-menu"
import { sseManager } from "../../lib/sse-manager"
import { getLogger } from "../../lib/logger"
import PromptInput from "../prompt-input"
import { useI18n } from "../../lib/i18n"
import { activeInterruption, getPermissionQueueLength } from "../../stores/instances"
import { getFormQueue } from "../../stores/forms"
import SessionSidebar from "./shell/SessionSidebar"
import { useSessionSidebarRequests } from "./shell/useSessionSidebarRequests"
import RightPanel from "./shell/right-panel/RightPanel"
import { useDrawerChrome } from "./shell/useDrawerChrome"
import { getRetrySeconds, getSessionIdleFadeClass, getSessionRetry, getSessionStatus, shouldShowSessionStatus } from "../../stores/session-status"
import { Command as CommandIcon, Eye, Maximize2, MessageSquareText, Search, ShieldAlert } from "lucide-solid"
import type { PromptInputApi } from "../prompt-input/types"
import type { Attachment } from "../../types/attachment"
import { setAgentModelPreference, useConfig } from "../../stores/preferences"
import { showAlertDialog } from "../../stores/alerts"
import {
  DEFAULT_PREVIEW_URL,
  getSessionPreview,
  openSessionPreview,
  restoreSessionPreview,
  sessionPreviews,
  showSessionChat,
  showSessionPreview,
} from "../../stores/session-previews"
import { createSession, executeCustomCommand, getDefaultModel, providers, runShellCommand, sendMessage, setActiveParentSession, updateSessionModel } from "../../stores/sessions"
import { addAttachment, clearAttachments, getAttachments, removeAttachment } from "../../stores/attachments"

import type { LayoutMode } from "./shell/types"
import {
  DEFAULT_SESSION_SIDEBAR_WIDTH,
  LEFT_DRAWER_STORAGE_KEY,
  MIN_RIGHT_DRAWER_WIDTH,
  MIN_SESSION_SIDEBAR_WIDTH,
  RIGHT_DRAWER_STORAGE_KEY,
  RIGHT_DRAWER_WIDTH,
  clampRightWidth,
  clampWidth,
} from "./shell/storage"
import { useDrawerHostMeasure } from "./shell/useDrawerHostMeasure"
import { useDrawerResize } from "./shell/useDrawerResize"
import { clampEmbeddedDrawerWidth } from "./shell/drawer-layout"
import { useSessionCache } from "./shell/useSessionCache"
import { useInstanceSessionContext } from "./shell/useInstanceSessionContext"
import { isPermissionAutoAcceptEnabled } from "../../stores/permission-auto-accept"
import { readClientLayoutValue, writeClientLayoutValue } from "../../stores/client-state"
import { runtimeEnv } from "../../lib/runtime-env"

const log = getLogger("session")
const OPEN_SESSION_SEARCH_EVENT = "codenomad:open-session-search"
const NO_SESSION_DRAFT_SESSION_ID = "__no_session_draft__"
const MIN_SESSION_CENTER_WIDTH = 480
type SessionCenterWidthStep = "narrow" | "medium" | "wide"

function getSessionCenterWidthStep(width: number): SessionCenterWidthStep {
  if (width < 768) return "narrow"
  if (width < 1280) return "medium"
  return "wide"
}

interface InstanceShellProps {
  instance: Instance
  // Provided by App-level instance tabs; lets us pause heavy rendering
  // work for inactive instances while keeping them mounted for fast switching.
  isActiveInstance?: boolean
  escapeInDebounce: boolean
  paletteCommands: Accessor<Command[]>
  onCloseSession: (sessionId: string) => Promise<void> | void
  onNewSession: () => Promise<void> | void
  handleSidebarAgentChange: (sessionId: string, agent: string) => Promise<void>
  handleSidebarModelChange: (sessionId: string, model: { providerId: string; modelId: string }) => Promise<void>
  onExecuteCommand: (command: Command) => void
  tabBarOffset: number

  // In-memory only: mobile immersive/fullscreen mode.
  mobileFullscreenMode: boolean
  onEnterMobileFullscreen: () => void
  onExitMobileFullscreen: () => void
}

const InstanceShell2: Component<InstanceShellProps> = (props) => {
  const { t, locale } = useI18n()
  const { preferences } = useConfig()
  const isRTL = () => locale() === "he"

  const [sessionSidebarWidth, setSessionSidebarWidth] = createSignal(DEFAULT_SESSION_SIDEBAR_WIDTH)
  const [rightDrawerWidth, setRightDrawerWidth] = createSignal(
    typeof window !== "undefined" ? clampRightWidth(window.innerWidth * 0.35) : RIGHT_DRAWER_WIDTH,
  )
  const [rightDrawerWidthInitialized, setRightDrawerWidthInitialized] = createSignal(false)
  const [leftDrawerContentEl, setLeftDrawerContentEl] = createSignal<HTMLElement | null>(null)
  const [rightDrawerContentEl, setRightDrawerContentEl] = createSignal<HTMLElement | null>(null)
  const [leftToggleButtonEl, setLeftToggleButtonEl] = createSignal<HTMLElement | null>(null)
  const [rightToggleButtonEl, setRightToggleButtonEl] = createSignal<HTMLElement | null>(null)
  const [sessionCenterEl, setSessionCenterEl] = createSignal<HTMLElement | null>(null)
  const [sessionCenterWidthStep, setSessionCenterWidthStep] = createSignal<SessionCenterWidthStep>("wide")
  const [headerDensity, setHeaderDensity] = createSignal(0)
  let sessionToolbarEl: HTMLElement | undefined
  let headerLeftEl: HTMLElement | undefined
  let headerRightEl: HTMLElement | undefined
  let headerIndicatorsEl: HTMLElement | undefined

  const [permissionModalOpen, setPermissionModalOpen] = createSignal(false)
  let lastAutoOpenedFormId: string | null = null
  const [now, setNow] = createSignal(Date.now())
  const [sessionPromptApis, setSessionPromptApis] = createSignal<Record<string, PromptInputApi | null>>({})
  const pendingFirstPromptText = new Map<string, string>()
  const [draftAgent, setDraftAgent] = createSignal("")
  const [draftModel, setDraftModel] = createSignal({ providerId: "", modelId: "" })
  const [draftModelManuallySelected, setDraftModelManuallySelected] = createSignal(false)
  const [draftPromptInputApi, setDraftPromptInputApi] = createSignal<PromptInputApi | null>(null)
  const [focusConversationSessionId, setFocusConversationSessionId] = createSignal<string | null>(null)

  // Worktree selector manages its own dialogs.
  const [showSessionSearch, setShowSessionSearch] = createSignal(false)

  const {
    allInstanceSessions,
    sessionThreads,
    activeSessions,
    activeSessionIdForInstance,
    activeSessionForInstance,
    latestTodoState,
    tokenStats,
    handleSessionSelect,
  } = useInstanceSessionContext({
    instanceId: () => props.instance.id,
  })

  createEffect(() => {
    const active = activeInterruption().get(props.instance.id)
    const form = active?.kind === "form"
      ? getFormQueue(props.instance.id).find((entry) => entry.id === active.id)
      : undefined
    if (form && !shouldRenderFormInFallback(form, activeSessionIdForInstance(), messageStoreBus.getOrCreate(props.instance.id))) {
      lastAutoOpenedFormId = form.id
      return
    }

    const formId = getFormRequestAutoOpenId(active, lastAutoOpenedFormId)
    if (!formId) return
    lastAutoOpenedFormId = formId
    setPermissionModalOpen(true)
  })

  const desktopQuery = useMediaQuery("(min-width: 1280px)")

  const tabletQuery = useMediaQuery("(min-width: 768px)")

  const layoutMode = createMemo<LayoutMode>(() => {
    if (desktopQuery()) return "desktop"
    if (tabletQuery()) return "tablet"
    return "phone"
  })

  const isPhoneLayout = createMemo(() => layoutMode() === "phone")
  const mobileFullscreen = createMemo(() => props.mobileFullscreenMode)
  const compactPromptLayout = createMemo(() => layoutMode() !== "desktop")

  const { setDrawerHost, drawerContainer, drawerHostWidth, measureDrawerHost } = useDrawerHostMeasure()

  const drawerChrome = useDrawerChrome({
    t,
    hostWidth: drawerHostWidth,
    minimumCenterWidth: MIN_SESSION_CENTER_WIDTH,
    minimumLeftWidth: MIN_SESSION_SIDEBAR_WIDTH,
    minimumRightWidth: MIN_RIGHT_DRAWER_WIDTH,
    leftWidth: sessionSidebarWidth,
    rightWidth: rightDrawerWidth,
    leftDrawerContentEl,
    rightDrawerContentEl,
    leftToggleButtonEl,
    rightToggleButtonEl,
    measureDrawerHost,
  })

  const {
    leftPinned,
    leftOpen,
    rightPinned,
    rightOpen,
    leftPanelWidth,
    rightPanelWidth,
    setLeftOpen,
    setRightOpen,
    leftDrawerState,
    rightDrawerState,
    closeLeft: closeLeftDrawer,
    closeRight: closeRightDrawer,
    closeFloatingDrawersIfAny,
    leftAppBarButtonLabel,
    rightAppBarButtonLabel,
    leftAppBarButtonIcon,
    rightAppBarButtonIcon,
    handleLeftAppBarButtonClick,
    handleRightAppBarButtonClick,
  } = drawerChrome

  // When the user switches away from this instance (e.g., taps a different
  // instance/project tab while a floating drawer is open on phone), close any
  // open floating drawers so the previous instance's drawer doesn't remain
  // visually or interactively open when its tab regains focus later.
  let wasActiveInstance = Boolean(props.isActiveInstance)
  createEffect(() => {
    const isActive = Boolean(props.isActiveInstance)
    if (wasActiveInstance && !isActive) {
      closeFloatingDrawersIfAny()
    }
    wasActiveInstance = isActive
  })

  onMount(() => {
    if (typeof document === "undefined") return

    const handleFloatingDrawerPointerDown = (event: PointerEvent) => {
      if (!props.isActiveInstance) return

      const hasFloatingDrawerOpen = (!leftPinned() && leftOpen()) || (!rightPinned() && rightOpen())
      if (!hasFloatingDrawerOpen) return

      const target = event.target
      if (!(target instanceof Node)) return

      const leftContent = leftDrawerContentEl()
      const rightContent = rightDrawerContentEl()
      const leftPaper = leftContent?.closest(".MuiDrawer-paper")
      const rightPaper = rightContent?.closest(".MuiDrawer-paper")
      if (leftPaper?.contains(target) || rightPaper?.contains(target)) return

      if (!leftPinned() && leftOpen()) setLeftOpen(false)
      if (!rightPinned() && rightOpen()) setRightOpen(false)
    }

    document.addEventListener("pointerdown", handleFloatingDrawerPointerDown, true)
    onCleanup(() => document.removeEventListener("pointerdown", handleFloatingDrawerPointerDown, true))
  })

  onMount(() => {
    if (typeof window === "undefined") return

    const savedLeft = readClientLayoutValue(LEFT_DRAWER_STORAGE_KEY)
    if (savedLeft) {
      const parsed = Number.parseInt(savedLeft, 10)
      if (Number.isFinite(parsed)) {
        setSessionSidebarWidth(clampWidth(parsed))
      }
    }

    let didLoadRightWidth = false
    const savedRight = readClientLayoutValue(RIGHT_DRAWER_STORAGE_KEY)
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

    setRightDrawerWidthInitialized(true)

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

  createEffect(() => {
    if (!props.isActiveInstance || mobileFullscreen() || typeof ResizeObserver === "undefined") return
    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!sessionToolbarEl || !headerLeftEl || !headerRightEl || !headerIndicatorsEl) return

        const gap = 8
        let density = 4
        for (let candidate = 0; candidate <= 4; candidate += 1) {
          sessionCenterEl()?.setAttribute("data-session-header-density", String(candidate))
          const leftRect = headerLeftEl.getBoundingClientRect()
          const rightRect = headerRightEl.getBoundingClientRect()
          const indicatorsRect = headerIndicatorsEl.getBoundingClientRect()
          const sidesFit = leftRect.right + gap <= rightRect.left
          const indicatorsFit = indicatorsRect.width === 0 ||
            (indicatorsRect.left >= leftRect.right + gap && indicatorsRect.right <= rightRect.left - gap)
          if (!sidesFit || !indicatorsFit) continue
          density = candidate
          break
        }
        sessionCenterEl()?.setAttribute("data-session-header-density", String(density))
        setHeaderDensity(density)
      })
    }
    const observer = new ResizeObserver(measure)
    ;[sessionToolbarEl, headerLeftEl, headerRightEl, headerIndicatorsEl]
      .forEach((element) => element && observer.observe(element))
    measureDrawerHost()
    measure()
    onCleanup(() => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    })
  })

  createEffect(() => {
    writeClientLayoutValue(LEFT_DRAWER_STORAGE_KEY, sessionSidebarWidth().toString())
  })

  createEffect(() => {
    writeClientLayoutValue(RIGHT_DRAWER_STORAGE_KEY, rightDrawerWidth().toString())
  })

  createEffect(() => {
    if (typeof window === "undefined") return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => window.clearInterval(timer))
  })

  createEffect(() => {
    if (!props.isActiveInstance) return
    const element = sessionCenterEl()
    if (!element || typeof ResizeObserver === "undefined") return

    const updateWidthStep = (width: number) => {
      if (width <= 0) return
      setSessionCenterWidthStep(getSessionCenterWidthStep(width))
    }

    measureDrawerHost()
    updateWidthStep(element.getBoundingClientRect().width)

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? element.getBoundingClientRect().width
      updateWidthStep(width)
    })
    observer.observe(element)

    onCleanup(() => observer.disconnect())
  })

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

  const hasPendingRequests = createMemo(() => {
    const permissions = getPermissionQueueLength(props.instance.id)
    return permissions + getFormQueue(props.instance.id).length > 0
  })

  const activePromptInputApi = createMemo(() => {
    const sessionId = activeSessionIdForInstance()
    if (!sessionId || sessionId === "info") return null
    return sessionPromptApis()[sessionId] ?? null
  })

  const activeSessionPreview = createMemo(() => {
    const sessionId = activeSessionIdForInstance()
    return sessionId ? getSessionPreview(sessionId, props.instance.folder) : null
  })

  createEffect(() => {
    const sessionId = activeSessionIdForInstance()
    if (!sessionId || sessionId === "info" || sessionPreviews().has(props.instance.folder)) return
    void restoreSessionPreview(sessionId, props.instance.folder).catch((error) => log.warn("Failed to restore web preview", { sessionId, error }))
  })

  const registerSessionPromptApi = (sessionId: string, api: PromptInputApi | null) => {
    setSessionPromptApis((current) => ({
      ...current,
      [sessionId]: api,
    }))
    const text = api ? pendingFirstPromptText.get(sessionId) : undefined
    if (api && text !== undefined) {
      pendingFirstPromptText.delete(sessionId)
      api.setPromptText(text, { focus: true })
    }
  }

  async function handleOpenPreview() {
    const sessionId = activeSessionIdForInstance()
    if (!sessionId || sessionId === "info") return
    try {
      const restored = await restoreSessionPreview(sessionId, props.instance.folder)
      if (restored) showSessionPreview(props.instance.folder)
      else await openSessionPreview(sessionId, DEFAULT_PREVIEW_URL, props.instance.folder)
    } catch (error) {
      showAlertDialog(t("sessionPreview.open.title"), {
        title: t("sessionPreview.open.title"),
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    }
  }

  function handlePreviewButtonClick() {
    const sessionId = activeSessionIdForInstance()
    if (!sessionId || sessionId === "info") return

    const preview = activeSessionPreview()
    if (preview?.mode === "preview") {
      showSessionChat(props.instance.folder)
      return
    }

    if (preview) {
      showSessionPreview(props.instance.folder)
      return
    }
    void handleOpenPreview()
  }

  const previewToggleLabel = createMemo(() => {
    const preview = activeSessionPreview()
    return preview?.mode === "preview" ? t("sessionPreview.chat.button") : t("sessionPreview.open.button")
  })

  const PreviewToggleIcon = createMemo(() => activeSessionPreview()?.mode === "preview" ? MessageSquareText : Eye)

  const yoloModeEnabled = createMemo(() => {
    const session = activeSessionForInstance()
    if (!session) return false
    return isPermissionAutoAcceptEnabled(props.instance.id, session.id)
  })

  const activeSessionStatusPill = createMemo(() => {
    const activeSessionId = activeSessionIdForInstance()
    if (!activeSessionId || activeSessionId === "info") return null

    const activeSession = activeSessionForInstance()
    const needsPermission = Boolean(activeSession?.pendingPermission)
    const needsQuestion = Boolean(activeSession?.pendingForm)
    const needsInput = needsPermission || needsQuestion

    if (needsInput) {
      return {
        className: "session-permission",
        text: needsPermission
          ? t("sessionList.status.needsPermission")
          : t("sessionList.status.needsInput"),
        showAlertIcon: true,
      }
    }

    const status = getSessionStatus(props.instance.id, activeSessionId)
    const retry = getSessionRetry(props.instance.id, activeSessionId)
    const showStatus = shouldShowSessionStatus(
      props.instance.id,
      activeSessionId,
      now(),
      preferences().keepUnseenSubagentIdleStatus,
    )
    if (!showStatus) {
      return null
    }
    const text = retry
      ? (() => {
          const seconds = getRetrySeconds(retry.next, now())
          return seconds > 0 ? t("sessionList.status.retryingIn", { seconds: String(seconds) }) : t("sessionList.status.retrying")
        })()
      : status === "working"
        ? t("sessionList.status.working")
        : status === "compacting"
          ? t("sessionList.status.compacting")
          : t("sessionList.status.idle")

    const baseClassName = `session-${retry ? "retrying" : status}`
    const fadeClassName = getSessionIdleFadeClass(props.instance.id, activeSessionId)

    return {
      className: fadeClassName ? `${baseClassName} ${fadeClassName}` : baseClassName,
      text,
      showAlertIcon: false,
      title: retry
        ? t("sessionList.status.retryTooltip", {
            message: retry.message,
            attempt: String(retry.attempt),
          })
        : undefined,
    }
  })

  const renderActiveSessionStatusPill = () => {
    const pill = activeSessionStatusPill()
    if (!pill) return null
    return (
      <span
        class={`status-indicator session-status session-status-list ${pill.className} notranslate`}
        title={pill.title}
        translate="no"
      >
        {pill.showAlertIcon ? <ShieldAlert class="w-3.5 h-3.5" aria-hidden="true" /> : <span class="status-dot" />}
        <span class="session-status-text">{pill.text}</span>
      </span>
    )
  }

  const renderYoloModePill = () => {
    if (!yoloModeEnabled()) return null
    return (
      <span
        class="status-indicator session-status session-status-list session-yolo-mode"
        aria-label={t("instanceShell.yoloMode.badgeAriaLabel")}
        title={t("instanceShell.yoloMode.badgeAriaLabel")}
      >
        <span class="status-dot" />
        <span class="session-status-text">{t("instanceShell.yoloMode.badge")}</span>
      </span>
    )
  }

  const renderSessionHeaderIndicators = () => (
    <div ref={(element) => { headerIndicatorsEl = element }} class="session-header-indicators flex items-center justify-center gap-2">
      <Show when={hasPendingRequests()} fallback={renderActiveSessionStatusPill()}>
        <PermissionNotificationBanner
          instanceId={props.instance.id}
          onClick={() => setPermissionModalOpen(true)}
        />
      </Show>
      {renderYoloModePill()}
    </div>
  )

  const renderPreviewToggleButton = () => (
    <Show when={!showingInfoView()}>
      <IconButton
        color="inherit"
        onClick={handlePreviewButtonClick}
        aria-label={previewToggleLabel()}
        title={previewToggleLabel()}
        size="small"
      >
        {(() => {
          const Icon = PreviewToggleIcon()
          return <Icon class="w-5 h-5" aria-hidden="true" />
        })()}
      </IconButton>
    </Show>
  )

  const renderHeaderThirdActionButton = () => runtimeEnv.platform === "mobile" ? (
    <IconButton
      color="inherit"
      onClick={props.onEnterMobileFullscreen}
      aria-label={t("instanceShell.fullscreen.enter")}
      title={t("instanceShell.fullscreen.enter")}
      size="small"
    >
      <Maximize2 class="w-5 h-5" aria-hidden="true" />
    </IconButton>
  ) : renderPreviewToggleButton()

  const handleCommandPaletteClick = () => {
    showCommandPalette(props.instance.id)
  }

  const handleChatSearchClick = () => {
    if (typeof window === "undefined") return
    window.dispatchEvent(new CustomEvent(OPEN_SESSION_SEARCH_EVENT))
  }

  const headerActionMenuItems = (): ActionOverflowMenuItem[] => {
    const items: ActionOverflowMenuItem[] = [{
      key: "commands",
      label: t("instanceShell.commandPalette.openAriaLabel"),
      icon: <CommandIcon class="w-4 h-4" aria-hidden="true" />,
      onSelect: handleCommandPaletteClick,
    }]
    if (showingInfoView()) return items
    const PreviewIcon = PreviewToggleIcon()
    items.push(
      {
        key: "search",
        label: t("instanceShell.chatSearch.openAriaLabel"),
        icon: <Search class="w-4 h-4" aria-hidden="true" />,
        onSelect: handleChatSearchClick,
      },
      {
        key: runtimeEnv.platform === "mobile" ? "fullscreen" : "preview",
        label: runtimeEnv.platform === "mobile" ? t("instanceShell.fullscreen.enter") : previewToggleLabel(),
        icon: runtimeEnv.platform === "mobile"
          ? <Maximize2 class="w-4 h-4" aria-hidden="true" />
          : <PreviewIcon class="w-4 h-4" aria-hidden="true" />,
        onSelect: runtimeEnv.platform === "mobile" ? props.onEnterMobileFullscreen : handlePreviewButtonClick,
      },
    )
    return items
  }

  const instancePaletteCommands = createMemo(() => props.paletteCommands())
  const paletteOpen = createMemo(() => isCommandPaletteOpen(props.instance.id))

   const keyboardShortcuts = createMemo(() =>
     [keyboardRegistry.get("session-prev"), keyboardRegistry.get("session-next")].filter(
       (shortcut): shortcut is KeyboardShortcut => Boolean(shortcut),
     ),
   )

   useSessionSidebarRequests({
     instanceId: () => props.instance.id,
     sidebarContentEl: leftDrawerContentEl,
     leftPinned,
     leftOpen,
     setLeftOpen,
     measureDrawerHost,
   })

  const { cachedSessionIds } = useSessionCache({
    instanceId: () => props.instance.id,
    instanceSessions: allInstanceSessions,
    activeSessionId: activeSessionIdForInstance,
  })

  const showEmbeddedSidebarToggle = createMemo(() => !leftPinned() && !leftOpen())

  const clampLeftDrawerWidth = (width: number) => leftPinned()
    ? clampEmbeddedDrawerWidth(
      width,
      MIN_SESSION_SIDEBAR_WIDTH,
      Math.max(MIN_SESSION_SIDEBAR_WIDTH, drawerHostWidth() - MIN_SESSION_CENTER_WIDTH - (rightPinned() ? rightPanelWidth() : 0)),
      sessionSidebarWidth(),
    )
    : clampWidth(width)
  const clampRightDrawerWidth = (width: number) => rightPinned()
    ? clampEmbeddedDrawerWidth(
      clampRightWidth(width),
      MIN_RIGHT_DRAWER_WIDTH,
      Math.max(MIN_RIGHT_DRAWER_WIDTH, drawerHostWidth() - MIN_SESSION_CENTER_WIDTH - (leftPinned() ? leftPanelWidth() : 0)),
      rightDrawerWidth(),
    )
    : clampRightWidth(width)

  const { handleDrawerResizeMouseDown, handleDrawerResizeTouchStart } = useDrawerResize({
    sessionSidebarWidth: leftPanelWidth,
    rightDrawerWidth: rightPanelWidth,
    setSessionSidebarWidth,
    setRightDrawerWidth,
    clampLeft: clampLeftDrawerWidth,
    clampRight: clampRightDrawerWidth,
    measureDrawerHost,
  })


  const renderLeftPanel = () => {
    if (leftPinned()) {
      return (
        <Box
          class="session-sidebar-container"
          sx={{
            width: `${leftPanelWidth()}px`,
            flexShrink: 0,
            borderInlineEnd: "1px solid var(--border-base)",
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
          <SessionSidebar
            t={t}
            instanceId={props.instance.id}
            threads={sessionThreads}
            activeSessionId={activeSessionIdForInstance}
            activeSession={activeSessionForInstance}
            draftAgent={draftAgent}
            draftModel={draftModel}
            showSearch={showSessionSearch}
            onToggleSearch={() => setShowSessionSearch((current) => !current)}
            keyboardShortcuts={keyboardShortcuts}
            drawerState={leftDrawerState}
            onSelectSession={handleSessionSelect}
            onNewSession={props.onNewSession}
            onSidebarAgentChange={props.handleSidebarAgentChange}
            onSidebarModelChange={props.handleSidebarModelChange}
            onDraftAgentChange={handleDraftAgentChange}
            onDraftModelChange={handleDraftModelChange}
            onCloseLeftDrawer={closeLeftDrawer}
            setContentEl={setLeftDrawerContentEl}
          />
        </Box>
      )
    }
    const container = drawerContainer()
    const modalProps = container ? { container: container as Element } : undefined
    return (
      <Drawer
        class="session-floating-drawer"
        anchor={isRTL() ? "right" : "left"}
        variant="temporary"
        open={leftOpen()}
        onClose={closeLeftDrawer}
        ModalProps={modalProps}
      >
        <SessionSidebar
          t={t}
          instanceId={props.instance.id}
          threads={sessionThreads}
          activeSessionId={activeSessionIdForInstance}
          activeSession={activeSessionForInstance}
          draftAgent={draftAgent}
          draftModel={draftModel}
          showSearch={showSessionSearch}
          onToggleSearch={() => setShowSessionSearch((current) => !current)}
          keyboardShortcuts={keyboardShortcuts}
          drawerState={leftDrawerState}
          onSelectSession={handleSessionSelect}
          onNewSession={props.onNewSession}
          onSidebarAgentChange={props.handleSidebarAgentChange}
          onSidebarModelChange={props.handleSidebarModelChange}
          onDraftAgentChange={handleDraftAgentChange}
          onDraftModelChange={handleDraftModelChange}
          onCloseLeftDrawer={closeLeftDrawer}
          setContentEl={setLeftDrawerContentEl}
        />
      </Drawer>
    )
  }


  const renderRightPanel = () => {
    if (rightPinned()) {
      return (
        <Box
          class="session-right-panel"
          sx={{
            width: `${rightPanelWidth()}px`,
            flexShrink: 0,
            borderInlineStart: "1px solid var(--border-base)",
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
          <RightPanel
            t={t}
            instanceId={props.instance.id}
            instance={props.instance}
            activeSessionId={activeSessionIdForInstance}
            activeSession={activeSessionForInstance}
            latestTodoState={latestTodoState}
            isPhoneLayout={isPhoneLayout}
            rightDrawerWidth={rightPanelWidth}
            rightDrawerWidthInitialized={rightDrawerWidthInitialized}
            onCloseRightDrawer={closeRightDrawer}
            promptInputApi={activePromptInputApi}
            setContentEl={setRightDrawerContentEl}
          />
        </Box>
      )
    }
    const container = drawerContainer()
    const modalProps = container ? { container: container as Element } : undefined
    return (
      <Drawer
        class="session-floating-drawer"
        anchor={isRTL() ? "left" : "right"}
        variant="temporary"
        open={rightOpen()}
        onClose={closeRightDrawer}
        ModalProps={modalProps}
      >
        <RightPanel
          t={t}
          instanceId={props.instance.id}
          instance={props.instance}
          activeSessionId={activeSessionIdForInstance}
          activeSession={activeSessionForInstance}
          latestTodoState={latestTodoState}
          isPhoneLayout={isPhoneLayout}
          rightDrawerWidth={drawerHostWidth}
          rightDrawerWidthInitialized={rightDrawerWidthInitialized}
          onCloseRightDrawer={closeRightDrawer}
          promptInputApi={activePromptInputApi}
          setContentEl={setRightDrawerContentEl}
        />
      </Drawer>

    )
  }

  const showingInfoView = createMemo(() => activeSessionIdForInstance() === "info")
  const activeSessionTitle = createMemo(() => {
    if (showingInfoView()) return null
    const title = activeSessionForInstance()?.title?.trim()
    return title || t("sessionList.session.untitled")
  })
  const showHeaderLeftSlot = createMemo(() => !leftPinned())
  const showHeaderSessionTitle = createMemo(() => !leftOpen() && Boolean(activeSessionTitle()))

  const renderActiveSessionHeaderTitle = () => (
    <Show when={showHeaderSessionTitle()}>
      <span
        class="session-header-active-title"
        dir="auto"
        title={activeSessionTitle() ?? undefined}
      >
        {activeSessionTitle()}
      </span>
    </Show>
  )

  const renderHeaderLeftSlot = () => (
    <Show when={showHeaderLeftSlot() && leftDrawerState() === "floating-closed"}>
      <span class="session-header-drawer-toggle session-header-drawer-toggle--left">
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
      </span>
    </Show>
  )

  const isLaunching = createMemo(() => props.instance.status === "starting")

  createEffect(() => {
    const agent = draftAgent()
    providers().get(props.instance.id)
    if (!agent || draftModelManuallySelected()) return

    let cancelled = false
    void getDefaultModel(props.instance.id, agent).then((model) => {
      if (!cancelled) setDraftModel(model)
    }).catch((error) => log.warn("Failed to resolve draft model", error))

    onCleanup(() => {
      cancelled = true
    })
  })

  async function handleDraftAgentChange(agent: string) {
    setDraftAgent(agent)
    setDraftModelManuallySelected(false)
    const model = await getDefaultModel(props.instance.id, agent)
    setDraftModel(model)
  }

  async function handleDraftModelChange(model: { providerId: string; modelId: string }) {
    setDraftModel(model)
    setDraftModelManuallySelected(true)
  }

  const draftAttachments = createMemo(() => getAttachments(props.instance.id, NO_SESSION_DRAFT_SESSION_ID))

  function registerDraftPromptInputApi(api: PromptInputApi) {
    setDraftPromptInputApi(api)
    return () => {
      setDraftPromptInputApi((current) => (current === api ? null : current))
    }
  }

  function getActiveCreatedSessionPane(sessionId: string) {
    if (activeSessionIdForInstance() !== sessionId) return null
    const pane = sessionCenterEl()?.querySelector<HTMLElement>('.session-cache-pane[data-session-active="true"]')
    return pane?.dataset.sessionId === sessionId ? pane : null
  }

  function focusCreatedSessionPrompt(sessionId: string) {
    const textarea = getActiveCreatedSessionPane(sessionId)?.querySelector<HTMLTextAreaElement>(".prompt-input")
    if (!textarea || textarea.disabled) return
    try {
      textarea.focus({ preventScroll: true })
    } catch {
      textarea.focus()
    }
  }

  let draftSessionCreation: ReturnType<typeof createSession> | undefined

  function createAndActivateDraftSession() {
    if (draftSessionCreation) return draftSessionCreation
    const creation = (async () => {
      const agent = draftAgent()
      const model = draftModel()
      if (agent && model.providerId && model.modelId) {
        await setAgentModelPreference(props.instance.id, agent, model)
      }
      const session = await createSession(props.instance.id, agent || undefined)
      if (model.providerId && model.modelId) {
        await updateSessionModel(props.instance.id, session.id, model)
      }
      if (!window.matchMedia?.("(pointer: coarse)")?.matches || window.matchMedia?.("(any-pointer: fine)")?.matches) {
        setFocusConversationSessionId(session.id)
      }
      setActiveParentSession(props.instance.id, session.id)
      return session
    })()
    draftSessionCreation = creation
    void creation.finally(() => {
      if (draftSessionCreation === creation) draftSessionCreation = undefined
    }).catch(() => undefined)
    return creation
  }

  async function runFirstPromptSubmission(
    submit: (sessionId: string) => Promise<void>,
    draft?: { text: string; attachments: Attachment[] },
  ) {
    const session = await createAndActivateDraftSession()
    try {
      await submit(session.id)
    } catch (error) {
      if (draft) {
        const api = sessionPromptApis()[session.id]
        if ((!api || !api.getPromptText()) && getAttachments(props.instance.id, session.id).length === 0) {
          clearAttachments(props.instance.id, session.id)
          for (const attachment of draft.attachments) addAttachment(props.instance.id, session.id, attachment)
          if (api) api.setPromptText(draft.text, { focus: true })
          else pendingFirstPromptText.set(session.id, draft.text)
        }
      }
      focusCreatedSessionPrompt(session.id)
      throw error
    }
  }

  async function handleFirstPromptSend(prompt: string, attachments: Attachment[]) {
    await runFirstPromptSubmission(async (sessionId) => {
      await sendMessage(props.instance.id, sessionId, prompt, attachments)
    }, { text: prompt, attachments })
  }

  async function handleFirstPromptCommand(commandName: string, args: string) {
    await runFirstPromptSubmission((sessionId) => executeCustomCommand(props.instance.id, sessionId, commandName, args))
  }

  async function handleFirstPromptShell(command: string) {
    await runFirstPromptSubmission((sessionId) => runShellCommand(props.instance.id, sessionId, command))
  }

  /** Return to the last conversation */
  const handleBackToConversation = () => {
    const sessionIds = cachedSessionIds()
    if (sessionIds.length > 0) {
      handleSessionSelect(sessionIds[0])
    }
  }
  const sessionLayout = (
    <div
      class="session-shell-panels relative flex flex-1 min-h-0 overflow-x-hidden"
      ref={(element) => {
        setDrawerHost(element)
        measureDrawerHost()
      }}
    >
      {renderLeftPanel()}

      <Box
        class="session-center-column"
        ref={setSessionCenterEl}
        data-session-center-width={sessionCenterWidthStep()}
        data-session-header-density={String(headerDensity())}
        sx={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowX: "hidden" }}
      >
        <Show when={!mobileFullscreen()}>
          <AppBar position="sticky" color="default" elevation={0} class="border-b border-base">
            <Toolbar ref={(element) => { sessionToolbarEl = element }} variant="dense" class="session-toolbar flex items-center gap-2 py-0 min-h-[40px]">
              {renderHeaderLeftSlot()}

              <div ref={(element) => { headerLeftEl = element }} class="session-toolbar-left flex-1 flex items-center gap-3 min-w-0">
                <Show when={!showingInfoView()}>
                  <ContextMeter
                    usedTokens={tokenStats().used}
                    availableTokens={tokenStats().avail}
                    formatTokens={formatTokenTotal}
                    usedLabel={t("instanceShell.metrics.usedLabel")}
                    availableLabel={t("instanceShell.metrics.availableLabel")}
                  />
                </Show>

              </div>

              <div class="session-header-center session-header-hints">
                {renderSessionHeaderIndicators()}
                {renderActiveSessionHeaderTitle()}
              </div>

              <div ref={(element) => { headerRightEl = element }} class="session-toolbar-right flex-1 flex items-center gap-3">
                <div class="ms-auto flex items-center gap-3">
                  <div class="connection-status-meta flex items-center gap-3">
                    <div class="session-header-actions-slot">
                      <div class="session-header-expanded-actions flex items-center gap-3">
                        <IconButton
                          color="inherit"
                          onClick={handleCommandPaletteClick}
                          aria-label={t("instanceShell.commandPalette.openAriaLabel")}
                          title={t("instanceShell.commandPalette.openAriaLabel")}
                          size="small"
                        >
                          <CommandIcon class="w-5 h-5" aria-hidden="true" />
                        </IconButton>
                        <Show when={!showingInfoView()}>
                          <IconButton
                            color="inherit"
                            onClick={handleChatSearchClick}
                            aria-label={t("instanceShell.chatSearch.openAriaLabel")}
                            title={t("instanceShell.chatSearch.openAriaLabel")}
                            size="small"
                          >
                            <Search class="w-5 h-5" aria-hidden="true" />
                          </IconButton>
                          {renderHeaderThirdActionButton()}
                        </Show>
                      </div>
                      <ActionOverflowMenu
                        items={headerActionMenuItems()}
                        label={t("messageItem.actions.more")}
                        triggerClass="session-header-actions-menu"
                      />
                    </div>
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
                </div>
              </div>

              <Show when={rightDrawerState() === "floating-closed"}>
                <span class="session-header-drawer-toggle session-header-drawer-toggle--right">
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
                </span>
              </Show>
            </Toolbar>
          </AppBar>
        </Show>

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
                  <div class="session-view">
                    <MessageSection
                      instanceId={props.instance.id}
                      sessionId={NO_SESSION_DRAFT_SESSION_ID}
                      loading={false}
                      emptyStateVariant="no-session"
                      isActive={props.isActiveInstance}
                      showSidebarToggle={showEmbeddedSidebarToggle()}
                      onSidebarToggle={() => setLeftOpen(true)}
                      forceCompactStatusLayout={showEmbeddedSidebarToggle()}
                    />

                    <Show when={draftAttachments().length > 0}>
                      <PromptAttachmentsBar
                        attachments={draftAttachments()}
                        onRemoveAttachment={(attachmentId) => {
                          const api = draftPromptInputApi()
                          if (api) {
                            api.removeAttachment(attachmentId)
                            return
                          }
                          removeAttachment(props.instance.id, NO_SESSION_DRAFT_SESSION_ID, attachmentId)
                        }}
                        onExpandTextAttachment={(attachmentId) => draftPromptInputApi()?.expandTextAttachment(attachmentId)}
                      />
                    </Show>

                    <PromptInput
                      instanceId={props.instance.id}
                      instanceFolder={props.instance.folder}
                      sessionId={NO_SESSION_DRAFT_SESSION_ID}
                      isActive={props.isActiveInstance}
                      compactLayout={compactPromptLayout()}
                      onSend={handleFirstPromptSend}
                      onCommand={handleFirstPromptCommand}
                      onRunShell={handleFirstPromptShell}
                      escapeInDebounce={props.escapeInDebounce}
                      registerPromptInputApi={registerDraftPromptInputApi}
                    />
                  </div>
                }
              >
                <For each={cachedSessionIds()}>
                  {(sessionId) => {
                    const isActive = () => Boolean(props.isActiveInstance) && activeSessionIdForInstance() === sessionId
                    return (
                      <div
                        class="session-cache-pane flex flex-col flex-1 min-h-0"
                        style={{ display: isActive() ? "flex" : "none" }}
                        data-session-id={sessionId}
                        data-instance-id={props.instance.id}
                        data-session-active={isActive() ? "true" : "false"}
                        aria-hidden={!isActive()}
                      >
                        <Show when={isActive()}>
                          <SessionView
                            sessionId={sessionId}
                            activeSessions={activeSessions()}
                            instanceId={props.instance.id}
                            instanceFolder={props.instance.folder}
                            escapeInDebounce={props.escapeInDebounce}
                            isPhoneLayout={isPhoneLayout()}
                            compactPromptLayout={compactPromptLayout()}
                            focusConversationOnActivate={focusConversationSessionId() === sessionId}
                            onConversationFocusHandled={() => {
                              if (focusConversationSessionId() === sessionId) setFocusConversationSessionId(null)
                            }}
                            registerSessionPromptApi={registerSessionPromptApi}
                            showSidebarToggle={showEmbeddedSidebarToggle()}
                            onSidebarToggle={() => setLeftOpen(true)}
                            forceCompactStatusLayout={showEmbeddedSidebarToggle()}
                            isActive={isActive()}
                          />
                        </Show>
                      </div>
                    )
                  }}
                </For>
              </Show>
            }
          >
            <div class="info-view-pane flex flex-col flex-1 min-h-0 overflow-y-auto">
              <InfoView instanceId={props.instance.id} onBackToConversation={handleBackToConversation} />
            </div>
          </Show>
        </Box>
      </Box>

      {renderRightPanel()}
    </div>
  )

  return (
    <>
      <div
        class="instance-shell2 flex flex-col flex-1 min-h-0"
        data-instance-id={props.instance.id}
      >
        <Show when={!isLaunching()} fallback={<InstanceWelcomeView instance={props.instance} />}>
          {sessionLayout}
        </Show>
      </div>

      <CommandPalette
        open={paletteOpen()}
        onClose={() => hideCommandPalette(props.instance.id)}
        commands={instancePaletteCommands()}
        onExecute={props.onExecuteCommand}
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
