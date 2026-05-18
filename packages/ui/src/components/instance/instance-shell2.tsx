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
import type { BackgroundProcess } from "../../../../server/src/api-types"
import { keyboardRegistry, type KeyboardShortcut } from "../../lib/keyboard-registry"

import { isOpen as isCommandPaletteOpen, hideCommandPalette, showCommandPalette } from "../../stores/command-palette"
import Kbd from "../kbd"
import InstanceWelcomeView from "../instance-welcome-view"
import InfoView from "../info-view"
import CommandPalette from "../command-palette"
import PermissionNotificationBanner from "../permission-notification-banner"
import PermissionApprovalModal from "../permission-approval-modal"
import SessionView from "../session/session-view"
import MessageSection from "../message-section"
import PromptAttachmentsBar from "../prompt-input/PromptAttachmentsBar"
import { formatTokenTotal } from "../../lib/formatters"
import ContextMeter from "../context-meter"
import { sseManager } from "../../lib/sse-manager"
import { getLogger } from "../../lib/logger"
import { serverApi } from "../../lib/api-client"
import { loadBackgroundProcesses } from "../../stores/background-processes"
import { BackgroundProcessOutputDialog } from "../background-process-output-dialog"
import PromptInput from "../prompt-input"
import { useI18n } from "../../lib/i18n"
import { getPermissionQueueLength, getQuestionQueueLength } from "../../stores/instances"
import SessionSidebar from "./shell/SessionSidebar"
import { useSessionSidebarRequests } from "./shell/useSessionSidebarRequests"
import RightPanel from "./shell/right-panel/RightPanel"
import { useDrawerChrome } from "./shell/useDrawerChrome"
import { getRetrySeconds, getSessionIdleFadeClass, getSessionRetry, getSessionStatus, shouldShowSessionStatus } from "../../stores/session-status"
import { Eye, Maximize2, MessageSquareText, Search, ShieldAlert } from "lucide-solid"
import type { PromptInputApi } from "../prompt-input/types"
import type { Attachment } from "../../types/attachment"
import { setAgentModelPreference, useConfig } from "../../stores/preferences"
import { showPromptDialog } from "../../stores/alerts"
import { openSessionPreview, sessionPreviews, showSessionChat, showSessionPreview } from "../../stores/session-previews"
import { createSession, executeCustomCommand, getDefaultModel, providers, runShellCommand, sendMessage, setActiveParentSession, updateSessionModel } from "../../stores/sessions"
import { getAttachments, removeAttachment } from "../../stores/attachments"

import type { LayoutMode } from "./shell/types"
import {
  DEFAULT_SESSION_SIDEBAR_WIDTH,
  LEFT_DRAWER_STORAGE_KEY,
  RIGHT_DRAWER_STORAGE_KEY,
  RIGHT_DRAWER_WIDTH,
  clampRightWidth,
  clampWidth,
} from "./shell/storage"
import { useDrawerHostMeasure } from "./shell/useDrawerHostMeasure"
import { useDrawerResize } from "./shell/useDrawerResize"
import { useSessionCache } from "./shell/useSessionCache"
import { useInstanceSessionContext } from "./shell/useInstanceSessionContext"
import { isPermissionAutoAcceptEnabled } from "../../stores/permission-auto-accept"

const log = getLogger("session")
const OPEN_SESSION_SEARCH_EVENT = "codenomad:open-session-search"
const NO_SESSION_DRAFT_SESSION_ID = "__no_session_draft__"
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

  const [selectedBackgroundProcess, setSelectedBackgroundProcess] = createSignal<BackgroundProcess | null>(null)
  const [showBackgroundOutput, setShowBackgroundOutput] = createSignal(false)
  const [permissionModalOpen, setPermissionModalOpen] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  const [sessionPromptApis, setSessionPromptApis] = createSignal<Record<string, PromptInputApi | null>>({})
  const [draftAgent, setDraftAgent] = createSignal("")
  const [draftModel, setDraftModel] = createSignal({ providerId: "", modelId: "" })
  const [draftModelManuallySelected, setDraftModelManuallySelected] = createSignal(false)
  const [draftPromptInputApi, setDraftPromptInputApi] = createSignal<PromptInputApi | null>(null)

  // Worktree selector manages its own dialogs.
  const [showSessionSearch, setShowSessionSearch] = createSignal(false)

  const {
    allInstanceSessions,
    sessionThreads,
    activeSessions,
    activeSessionIdForInstance,
    activeSessionForInstance,
    activeSessionDiffs,
    latestTodoState,
    tokenStats,
    backgroundProcessList,
    handleSessionSelect,
  } = useInstanceSessionContext({
    instanceId: () => props.instance.id,
  })

  const desktopQuery = useMediaQuery("(min-width: 1280px)")

  const tabletQuery = useMediaQuery("(min-width: 768px)")
  const compactHeaderQuery = useMediaQuery("(max-width: 1024px)")

  const layoutMode = createMemo<LayoutMode>(() => {
    if (desktopQuery()) return "desktop"
    if (tabletQuery()) return "tablet"
    return "phone"
  })

  const isPhoneLayout = createMemo(() => layoutMode() === "phone")
  const compactHeaderLayout = createMemo(() => isPhoneLayout() || compactHeaderQuery())
  const mobileFullscreen = createMemo(() => props.mobileFullscreenMode && isPhoneLayout())
  const compactPromptLayout = createMemo(() => layoutMode() !== "desktop")
  const leftPinningSupported = createMemo(() => layoutMode() !== "phone")
  const rightPinningSupported = createMemo(() => layoutMode() !== "phone")

  const { setDrawerHost, drawerContainer, measureDrawerHost, floatingTopPx, floatingHeight } = useDrawerHostMeasure(
    () => props.tabBarOffset,
  )

  const drawerChrome = useDrawerChrome({
    t,
    layoutMode,
    leftPinningSupported,
    rightPinningSupported,
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
    setLeftOpen,
    setRightOpen,
    leftDrawerState,
    rightDrawerState,
    pinLeft: pinLeftDrawer,
    unpinLeft: unpinLeftDrawer,
    pinRight: pinRightDrawer,
    unpinRight: unpinRightDrawer,
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

  createEffect(() => {
    const instanceId = props.instance.id
    loadBackgroundProcesses(instanceId).catch((error) => {
      log.warn("Failed to load background processes", error)
    })
  })

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
     if (typeof window === "undefined") return
     window.localStorage.setItem(LEFT_DRAWER_STORAGE_KEY, sessionSidebarWidth().toString())
   })

  createEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(RIGHT_DRAWER_STORAGE_KEY, rightDrawerWidth().toString())
  })

  createEffect(() => {
    if (typeof window === "undefined") return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => window.clearInterval(timer))
  })

  createEffect(() => {
    const element = sessionCenterEl()
    if (!element || typeof ResizeObserver === "undefined") return

    const updateWidthStep = (width: number) => {
      setSessionCenterWidthStep(getSessionCenterWidthStep(width))
    }

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

  const pendingRequestCount = createMemo(() => {
    const permissions = getPermissionQueueLength(props.instance.id)
    const questions = getQuestionQueueLength(props.instance.id)
    return permissions + questions
  })
  const hasPendingRequests = createMemo(() => {
    return pendingRequestCount() > 0
  })

  const activePromptInputApi = createMemo(() => {
    const sessionId = activeSessionIdForInstance()
    if (!sessionId || sessionId === "info") return null
    return sessionPromptApis()[sessionId] ?? null
  })

  const activeSessionPreview = createMemo(() => {
    const sessionId = activeSessionIdForInstance()
    return sessionId ? sessionPreviews().get(sessionId) ?? null : null
  })

  const registerSessionPromptApi = (sessionId: string, api: PromptInputApi | null) => {
    setSessionPromptApis((current) => ({
      ...current,
      [sessionId]: api,
    }))
  }

  async function handleOpenPreview() {
    const sessionId = activeSessionIdForInstance()
    if (!sessionId || sessionId === "info") return

    const url = await showPromptDialog(t("sessionPreview.open.prompt"), {
      title: t("sessionPreview.open.title"),
      inputLabel: t("sessionPreview.open.label"),
      inputPlaceholder: t("sessionPreview.open.placeholder"),
      confirmLabel: t("sessionPreview.open.confirm"),
      cancelLabel: t("sessionPreview.open.cancel"),
    })
    const normalized = url?.trim()
    if (!normalized) return
    await openSessionPreview(sessionId, normalized)
  }

  function handleShowPreview() {
    const sessionId = activeSessionIdForInstance()
    if (!sessionId || sessionId === "info") return
    showSessionPreview(sessionId)
  }

  function handlePreviewButtonClick() {
    const sessionId = activeSessionIdForInstance()
    if (!sessionId || sessionId === "info") return

    const preview = activeSessionPreview()
    if (preview?.mode === "preview") {
      showSessionChat(sessionId)
      return
    }

    if (preview) {
      showSessionPreview(sessionId)
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
    const needsQuestion = Boolean(activeSession?.pendingQuestion)
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
        {pill.text}
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
        {t("instanceShell.yoloMode.badge")}
      </span>
    )
  }

  const renderSessionHeaderIndicators = () => (
    <div class="flex items-center flex-wrap justify-center gap-2">
      {renderYoloModePill()}
      <Show when={hasPendingRequests()} fallback={renderActiveSessionStatusPill()}>
        <PermissionNotificationBanner
          instanceId={props.instance.id}
          onClick={() => setPermissionModalOpen(true)}
        />
      </Show>
    </div>
  )

  const handleCommandPaletteClick = () => {
    showCommandPalette(props.instance.id)
  }

  const handleChatSearchClick = () => {
    if (typeof window === "undefined") return
    window.dispatchEvent(new CustomEvent(OPEN_SESSION_SEARCH_EVENT))
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

  const { handleDrawerResizeMouseDown, handleDrawerResizeTouchStart } = useDrawerResize({
    sessionSidebarWidth,
    rightDrawerWidth,
    setSessionSidebarWidth,
    setRightDrawerWidth,
    clampLeft: clampWidth,
    clampRight: clampRightWidth,
    measureDrawerHost,
  })


  const renderLeftPanel = () => {
    if (leftPinned()) {
      return (
        <Box
          class="session-sidebar-container"
          sx={{
            width: `${sessionSidebarWidth()}px`,
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
            isPhoneLayout={isPhoneLayout}
            drawerState={leftDrawerState}
            leftPinned={leftPinned}
            onSelectSession={handleSessionSelect}
            onNewSession={props.onNewSession}
            onSidebarAgentChange={props.handleSidebarAgentChange}
            onSidebarModelChange={props.handleSidebarModelChange}
            onDraftAgentChange={handleDraftAgentChange}
            onDraftModelChange={handleDraftModelChange}
            onPinLeftDrawer={pinLeftDrawer}
            onUnpinLeftDrawer={unpinLeftDrawer}
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
        anchor={isRTL() ? "right" : "left"}
        variant="temporary"
        open={leftOpen()}
        onClose={closeLeftDrawer}
        ModalProps={modalProps}
        sx={{
          zIndex: 60,
          // The tab bar sits outside the floating drawer. Let its controls
          // receive the gesture; click-away handling above still closes the
          // drawer when the target is not inside the drawer content.
          pointerEvents: "none",
          "& .MuiDrawer-paper": {
            pointerEvents: "auto",
            width: isPhoneLayout() ? "100vw" : `${sessionSidebarWidth()}px`,
            boxSizing: "border-box",
            borderInlineEnd: isPhoneLayout() ? "none" : "1px solid var(--border-base)",
            backgroundColor: "var(--surface-secondary)",
            backgroundImage: "none",
            color: "var(--text-primary)",
            boxShadow: "none",
            borderRadius: 0,
            top: floatingTopPx(),
            height: floatingHeight(),
          },

          // Keep backdrop dismissal for the area below the tab bar without
          // covering the tab bar itself.
          "& .MuiBackdrop-root": {
            pointerEvents: "auto",
            backgroundColor: "transparent",
            top: floatingTopPx(),
            height: floatingHeight(),
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
          isPhoneLayout={isPhoneLayout}
          drawerState={leftDrawerState}
          leftPinned={leftPinned}
          onSelectSession={handleSessionSelect}
          onNewSession={props.onNewSession}
          onSidebarAgentChange={props.handleSidebarAgentChange}
          onSidebarModelChange={props.handleSidebarModelChange}
          onDraftAgentChange={handleDraftAgentChange}
          onDraftModelChange={handleDraftModelChange}
          onPinLeftDrawer={pinLeftDrawer}
          onUnpinLeftDrawer={unpinLeftDrawer}
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
            width: `${rightDrawerWidth()}px`,
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
            activeSessionDiffs={activeSessionDiffs}
            latestTodoState={latestTodoState}
            backgroundProcessList={backgroundProcessList}
            onOpenBackgroundOutput={openBackgroundOutput}
            onStopBackgroundProcess={stopBackgroundProcess}
            onTerminateBackgroundProcess={terminateBackgroundProcess}
            isPhoneLayout={isPhoneLayout}
            rightDrawerWidth={rightDrawerWidth}
            rightDrawerWidthInitialized={rightDrawerWidthInitialized}
            rightDrawerState={rightDrawerState}
            rightPinned={rightPinned}
            onCloseRightDrawer={closeRightDrawer}
            onPinRightDrawer={pinRightDrawer}
            onUnpinRightDrawer={unpinRightDrawer}
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
        anchor={isRTL() ? "left" : "right"}
        variant="temporary"
        open={rightOpen()}
        onClose={closeRightDrawer}
        ModalProps={modalProps}
        sx={{
          zIndex: 60,
          // See the matching override on the left drawer for rationale.
          pointerEvents: "none",
          "& .MuiDrawer-paper": {
            pointerEvents: "auto",
            width: isPhoneLayout() ? "100vw" : `${rightDrawerWidth()}px`,
            boxSizing: "border-box",
            borderInlineStart: isPhoneLayout() ? "none" : "1px solid var(--border-base)",
            backgroundColor: "var(--surface-secondary)",
            backgroundImage: "none",
            color: "var(--text-primary)",
            boxShadow: "none",
            borderRadius: 0,
            top: floatingTopPx(),
            height: floatingHeight(),
          },
          "& .MuiBackdrop-root": {
            pointerEvents: "auto",
            backgroundColor: "transparent",
            top: floatingTopPx(),
            height: floatingHeight(),
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
        <RightPanel
          t={t}
          instanceId={props.instance.id}
          instance={props.instance}
          activeSessionId={activeSessionIdForInstance}
          activeSession={activeSessionForInstance}
          activeSessionDiffs={activeSessionDiffs}
          latestTodoState={latestTodoState}
          backgroundProcessList={backgroundProcessList}
          onOpenBackgroundOutput={openBackgroundOutput}
          onStopBackgroundProcess={stopBackgroundProcess}
          onTerminateBackgroundProcess={terminateBackgroundProcess}
          isPhoneLayout={isPhoneLayout}
          rightDrawerWidth={rightDrawerWidth}
          rightDrawerWidthInitialized={rightDrawerWidthInitialized}
          rightDrawerState={rightDrawerState}
          rightPinned={rightPinned}
          onCloseRightDrawer={closeRightDrawer}
          onPinRightDrawer={pinRightDrawer}
          onUnpinRightDrawer={unpinRightDrawer}
          promptInputApi={activePromptInputApi}
          setContentEl={setRightDrawerContentEl}
        />
      </Drawer>

    )
  }

  const showingInfoView = createMemo(() => activeSessionIdForInstance() === "info")

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

  async function createAndActivateDraftSession() {
    const agent = draftAgent()
    const model = draftModel()
    if (agent && model.providerId && model.modelId) {
      await setAgentModelPreference(props.instance.id, agent, model)
    }
    const session = await createSession(props.instance.id, agent || undefined)
    if (model.providerId && model.modelId) {
      await updateSessionModel(props.instance.id, session.id, model)
    }
    setActiveParentSession(props.instance.id, session.id)
    return session
  }

  async function handleFirstPromptSend(prompt: string, attachments: Attachment[]) {
    const session = await createAndActivateDraftSession()
    await sendMessage(props.instance.id, session.id, prompt, attachments)
  }

  async function handleFirstPromptCommand(commandName: string, args: string) {
    const session = await createAndActivateDraftSession()
    await executeCustomCommand(props.instance.id, session.id, commandName, args)
  }

  async function handleFirstPromptShell(command: string) {
    const session = await createAndActivateDraftSession()
    await runShellCommand(props.instance.id, session.id, command)
  }

  const sessionLayout = (
    <div
      class="session-shell-panels flex flex-1 min-h-0 overflow-x-hidden"
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
        sx={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowX: "hidden" }}
      >
        <Show when={!mobileFullscreen()}>
          <AppBar position="sticky" color="default" elevation={0} class="border-b border-base">
            <Toolbar variant="dense" class="session-toolbar flex flex-wrap items-center gap-2 py-0 min-h-[40px]">
              <Show
                when={!compactHeaderLayout()}
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

                    <div class="flex-1 flex items-center justify-center min-w-0">
                      {renderSessionHeaderIndicators()}
                    </div>

                    <div class="flex flex-wrap items-center justify-center gap-1">
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
                      <button
                        type="button"
                        class="connection-status-button command-palette-button"
                        onClick={handleCommandPaletteClick}
                        aria-label={t("instanceShell.commandPalette.openAriaLabel")}
                        style={{ flex: "0 0 auto", width: "auto" }}
                      >
                        {t("instanceShell.commandPalette.button")}
                      </button>
                      <span class="connection-status-shortcut-hint kbd-hint">
                        <Kbd shortcut="cmd+shift+p" />
                     </span>
                     </div>

                    <div class="flex-1 flex items-center justify-center min-w-0">
                      <span
                        class={`status-indicator ${connectionStatusClass()}`}
                        aria-label={t("instanceShell.connection.ariaLabel", { status: connectionStatusLabel() })}
                      >
                        <span class="status-dot" />
                      </span>
                    </div>

                    <Show when={isPhoneLayout() && !props.mobileFullscreenMode}>
                      <IconButton
                        color="inherit"
                        onClick={props.onEnterMobileFullscreen}
                        aria-label={t("instanceShell.fullscreen.enter")}
                        title={t("instanceShell.fullscreen.enter")}
                        size="small"
                      >
                        <Maximize2 class="w-5 h-5" aria-hidden="true" />
                      </IconButton>
                    </Show>

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
                </div>
              }
            >
              <div class="session-toolbar-left flex-1 flex items-center gap-3 min-w-0">
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
                  <ContextMeter
                    usedTokens={tokenStats().used}
                    availableTokens={tokenStats().avail}
                    formatTokens={formatTokenTotal}
                    usedLabel={t("instanceShell.metrics.usedLabel")}
                    availableLabel={t("instanceShell.metrics.availableLabel")}
                  />
                </Show>

                <div class="ml-auto flex items-center session-header-hints">
                  {renderSessionHeaderIndicators()}
                </div>
              </div>

              <div class="session-toolbar-center flex items-center justify-center gap-2 min-w-[160px]">
                <button
                  type="button"
                  class="connection-status-button command-palette-button"
                  onClick={handleCommandPaletteClick}
                  aria-label={t("instanceShell.commandPalette.openAriaLabel")}
                  style={{ flex: "0 0 auto", width: "auto" }}
                >
                  {t("instanceShell.commandPalette.button")}
                </button>
              </div>

              <div class="session-toolbar-right flex-1 flex items-center gap-3">
                <span class="connection-status-shortcut-hint kbd-hint">
                  <Kbd shortcut="cmd+shift+p" />
                </span>

                <div class="ms-auto flex items-center gap-3">
                <div class="connection-status-meta flex items-center gap-3">
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
              </div>
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
                        <SessionView
                          sessionId={sessionId}
                          activeSessions={activeSessions()}
                          instanceId={props.instance.id}
                          instanceFolder={props.instance.folder}
                          escapeInDebounce={props.escapeInDebounce}
                          isPhoneLayout={isPhoneLayout()}
                          compactPromptLayout={compactPromptLayout()}
                          registerSessionPromptApi={registerSessionPromptApi}
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
