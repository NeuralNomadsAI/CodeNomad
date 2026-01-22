import { createSignal, Show, createEffect, createMemo, onCleanup } from "solid-js"
import { messageStoreBus } from "../stores/message-v2/bus"
import { useTheme } from "../lib/theme"
import { useGlobalCache } from "../lib/hooks/use-global-cache"
import { useConfig } from "../stores/preferences"
import { activeInterruption, sendPermissionResponse, sendQuestionReject, sendQuestionReply } from "../stores/instances"
import type { PermissionRequestLike } from "../types/permission"
import { getPermissionSessionId } from "../types/permission"
import type { QuestionRequest } from "@opencode-ai/sdk/v2"
import { resolveToolRenderer } from "./tool-call/renderers"
import { QuestionToolBlock } from "./tool-call/question-block"
import { PermissionToolBlock } from "./tool-call/permission-block"
import { createAnsiContentRenderer } from "./tool-call/ansi-render"
import { createDiffContentRenderer } from "./tool-call/diff-render"
import { createMarkdownContentRenderer } from "./tool-call/markdown-render"
import { extractDiagnostics, diagnosticFileName } from "./tool-call/diagnostics"
import { renderDiagnosticsSection } from "./tool-call/diagnostics-section"
import type {
  DiffPayload,
  DiffRenderOptions,
  MarkdownRenderOptions,
  AnsiRenderOptions,
  ToolCallPart,
  ToolRendererContext,
  ToolScrollHelpers,
} from "./tool-call/types"
import { getRelativePath, getToolIcon, getToolName, isToolStateCompleted, isToolStateError, isToolStateRunning, getDefaultToolAction } from "./tool-call/utils"
import { resolveTitleForTool } from "./tool-call/tool-title"
import { getLogger } from "../lib/logger"

const log = getLogger("session")

type ToolState = import("@opencode-ai/sdk").ToolState

const TOOL_CALL_CACHE_SCOPE = "tool-call"
const TOOL_SCROLL_SENTINEL_MARGIN_PX = 48
const TOOL_SCROLL_INTENT_WINDOW_MS = 600
const TOOL_SCROLL_INTENT_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"])

function makeRenderCacheKey(
  toolCallId?: string | null,
  messageId?: string,
  partId?: string | null,
  variant = "default",
) {
  const messageComponent = messageId ?? "unknown-message"
  const toolCallComponent = partId ?? toolCallId ?? "unknown-tool-call"
  return `${messageComponent}:${toolCallComponent}:${variant}`
}


interface ToolCallProps {
  toolCall: ToolCallPart
  toolCallId?: string
  messageId?: string
  messageVersion?: number
  partVersion?: number
  instanceId: string
  sessionId: string
  onContentRendered?: () => void
 }





export default function ToolCall(props: ToolCallProps) {
  const { preferences, setDiffViewMode } = useConfig()
  const { isDark } = useTheme()
  const toolCallMemo = createMemo(() => props.toolCall)
  const toolName = createMemo(() => toolCallMemo()?.tool || "")
  const toolCallIdentifier = createMemo(() => {
    const partId = toolCallMemo()?.id
    if (!partId) {
      throw new Error("Tool call requires a part id")
    }
    return partId
  })
  const toolState = createMemo(() => toolCallMemo()?.state)

  const cacheContext = createMemo(() => ({
    toolCallId: toolCallIdentifier(),
    messageId: props.messageId,
    partId: toolCallMemo()?.id ?? null,
  }))

  const store = createMemo(() => messageStoreBus.getOrCreate(props.instanceId))
  const activeRequest = createMemo(() => activeInterruption().get(props.instanceId) ?? null)

  const cacheVersion = createMemo(() => {
    if (typeof props.partVersion === "number") {
      return String(props.partVersion)
    }
    if (typeof props.messageVersion === "number") {
      return String(props.messageVersion)
    }
    return "noversion"
  })

  const messageVersionAccessor = createMemo(() => props.messageVersion)
  const partVersionAccessor = createMemo(() => props.partVersion)

  const createVariantCache = (variant: string | (() => string), version?: () => string) =>
    useGlobalCache({
      instanceId: () => props.instanceId,
      sessionId: () => props.sessionId,
      scope: TOOL_CALL_CACHE_SCOPE,
      cacheId: () => {
        const context = cacheContext()
        const resolvedVariant = typeof variant === "function" ? variant() : variant
        return makeRenderCacheKey(context.toolCallId || undefined, context.messageId, context.partId, resolvedVariant)
      },
      version: () => (version ? version() : cacheVersion()),
    })

  const diffCache = createVariantCache("diff")
  const permissionDiffCache = createVariantCache("permission-diff")
  const ansiRunningCache = createVariantCache("ansi-running", () => "running")
  const ansiFinalCache = createVariantCache("ansi-final")

  const permissionState = createMemo(() => store().getPermissionState(props.messageId, toolCallIdentifier()))
  const pendingPermission = createMemo(() => {
    const state = permissionState()
    if (state) {
      return { permission: state.entry.permission, active: state.active }
    }
    return toolCallMemo()?.pendingPermission
  })

  const questionState = createMemo(() => store().getQuestionState(props.messageId, toolCallIdentifier()))
  const pendingQuestion = createMemo(() => {
    const state = questionState()
    if (state) {
      return { request: state.entry.request as QuestionRequest, active: state.active }
    }
    return undefined
  })

  const toolOutputDefaultExpanded = createMemo(() => (preferences().toolOutputExpansion || "expanded") === "expanded")
  const diagnosticsDefaultExpanded = createMemo(() => (preferences().diagnosticsExpansion || "expanded") === "expanded")

  const defaultExpandedForTool = createMemo(() => {
    const prefExpanded = toolOutputDefaultExpanded()
    const toolName = toolCallMemo()?.tool || ""
    if (toolName === "read") {
      return false
    }
    return prefExpanded
  })

  const [userExpanded, setUserExpanded] = createSignal<boolean | null>(null)

  const isPermissionActive = createMemo(() => {
    const pending = pendingPermission()
    if (!pending?.permission) return false
    const active = activeRequest()
    return active?.kind === "permission" && active.id === pending.permission.id
  })

  const isQuestionActive = createMemo(() => {
    const pending = pendingQuestion()
    if (!pending?.request) return false
    const active = activeRequest()
    return active?.kind === "question" && active.id === pending.request.id
  })

  const expanded = () => {
    if (isPermissionActive() || isQuestionActive()) return true
    const override = userExpanded()
    if (override !== null) return override
    return defaultExpandedForTool()
  }

  const permissionDetails = createMemo(() => pendingPermission()?.permission)
  const questionDetails = createMemo(() => pendingQuestion()?.request)

  const activePermissionKey = createMemo(() => {
    const permission = permissionDetails()
    return permission && isPermissionActive() ? permission.id : ""
  })

  const activeQuestionKey = createMemo(() => {
    const request = questionDetails()
    return request && isQuestionActive() ? request.id : ""
  })
  const [permissionSubmitting, setPermissionSubmitting] = createSignal(false)
  const [permissionError, setPermissionError] = createSignal<string | null>(null)
  const [diagnosticsOverride, setDiagnosticsOverride] = createSignal<boolean | undefined>(undefined)

  const diagnosticsExpanded = () => {
    if (isPermissionActive() || isQuestionActive()) return true
    const override = diagnosticsOverride()
    if (override !== undefined) return override
    return diagnosticsDefaultExpanded()
  }
  const diagnosticsEntries = createMemo(() => {
    const state = toolState()
    if (!state) return []
    return extractDiagnostics(state)
  })

  const [scrollContainer, setScrollContainer] = createSignal<HTMLDivElement | undefined>()
  const [bottomSentinel, setBottomSentinel] = createSignal<HTMLDivElement | null>(null)
  const [autoScroll, setAutoScroll] = createSignal(true)
  const [bottomSentinelVisible, setBottomSentinelVisible] = createSignal(true)

  let toolCallRootRef: HTMLDivElement | undefined
  let scrollContainerRef: HTMLDivElement | undefined
  let detachScrollIntentListeners: (() => void) | undefined

  let pendingScrollFrame: number | null = null
  let pendingAnchorScroll: number | null = null
  let userScrollIntentUntil = 0
  let lastKnownScrollTop = 0

  function restoreScrollPosition(forceBottom = false) {
    const container = scrollContainerRef
    if (!container) return
    if (forceBottom) {
      container.scrollTop = container.scrollHeight
      lastKnownScrollTop = container.scrollTop
    } else {
      container.scrollTop = lastKnownScrollTop
    }
  }

  const persistScrollSnapshot = (element?: HTMLElement | null) => {
    if (!element) return
    lastKnownScrollTop = element.scrollTop
  }

  const handleScrollRendered = () => {
    requestAnimationFrame(() => {
      restoreScrollPosition(autoScroll())
      if (!expanded()) return
      scheduleAnchorScroll()
    })
  }

  const initializeScrollContainer = (element: HTMLDivElement | null | undefined) => {
    scrollContainerRef = element || undefined
    setScrollContainer(scrollContainerRef)
    if (scrollContainerRef) {
      restoreScrollPosition(autoScroll())
    }
  }


  function markUserScrollIntent() {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now()
    userScrollIntentUntil = now + TOOL_SCROLL_INTENT_WINDOW_MS
  }

  function hasUserScrollIntent() {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now()
    return now <= userScrollIntentUntil
  }

  function attachScrollIntentListeners(element: HTMLDivElement) {
    if (detachScrollIntentListeners) {
      detachScrollIntentListeners()
      detachScrollIntentListeners = undefined
    }
    const handlePointerIntent = () => markUserScrollIntent()
    const handleKeyIntent = (event: KeyboardEvent) => {
      if (TOOL_SCROLL_INTENT_KEYS.has(event.key)) {
        markUserScrollIntent()
      }
    }
    element.addEventListener("wheel", handlePointerIntent, { passive: true })
    element.addEventListener("pointerdown", handlePointerIntent)
    element.addEventListener("touchstart", handlePointerIntent, { passive: true })
    element.addEventListener("keydown", handleKeyIntent)
    detachScrollIntentListeners = () => {
      element.removeEventListener("wheel", handlePointerIntent)
      element.removeEventListener("pointerdown", handlePointerIntent)
      element.removeEventListener("touchstart", handlePointerIntent)
      element.removeEventListener("keydown", handleKeyIntent)
    }
  }

  function scheduleAnchorScroll(immediate = false) {
    if (!autoScroll()) return
    const sentinel = bottomSentinel()
    const container = scrollContainerRef
    if (!sentinel || !container) return
    if (pendingAnchorScroll !== null) {
      cancelAnimationFrame(pendingAnchorScroll)
      pendingAnchorScroll = null
    }
    pendingAnchorScroll = requestAnimationFrame(() => {
      pendingAnchorScroll = null
      const containerRect = container.getBoundingClientRect()
      const sentinelRect = sentinel.getBoundingClientRect()
      const delta = sentinelRect.bottom - containerRect.bottom + TOOL_SCROLL_SENTINEL_MARGIN_PX
      if (Math.abs(delta) > 1) {
        container.scrollBy({ top: delta, behavior: immediate ? "auto" : "smooth" })
      }
      lastKnownScrollTop = container.scrollTop
    })
  }

  function handleScroll() {
    const container = scrollContainer()
    if (!container) return
    if (pendingScrollFrame !== null) {
      cancelAnimationFrame(pendingScrollFrame)
    }
    const isUserScroll = hasUserScrollIntent()
    pendingScrollFrame = requestAnimationFrame(() => {
      pendingScrollFrame = null
      const atBottom = bottomSentinelVisible()
      if (isUserScroll) {
        if (atBottom) {
          if (!autoScroll()) setAutoScroll(true)
        } else if (autoScroll()) {
          setAutoScroll(false)
        }
      }
    })
  }

  const handleScrollEvent = (event: Event & { currentTarget: HTMLDivElement }) => {
    handleScroll()
    persistScrollSnapshot(event.currentTarget)
  }

  const scrollHelpers: ToolScrollHelpers = {
    registerContainer: (element, options) => {
      if (options?.disableTracking) return
      initializeScrollContainer(element)
    },
    handleScroll: handleScrollEvent,
    renderSentinel: (options) => {
      if (options?.disableTracking) return null
      return <div ref={setBottomSentinel} aria-hidden="true" class="tool-call-scroll-sentinel" style={{ height: "1px" }} />
    },
  }

  createEffect(() => {

    const container = scrollContainer()
    if (!container) return

    attachScrollIntentListeners(container)
    onCleanup(() => {
      if (detachScrollIntentListeners) {
        detachScrollIntentListeners()
        detachScrollIntentListeners = undefined
      }
    })
  })

  createEffect(() => {
    const container = scrollContainer()
    const sentinel = bottomSentinel()
    if (!container || !sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.target === sentinel) {
            setBottomSentinelVisible(entry.isIntersecting)
          }
        })
      },
      { root: container, threshold: 0, rootMargin: `0px 0px ${TOOL_SCROLL_SENTINEL_MARGIN_PX}px 0px` },
    )
    observer.observe(sentinel)
    onCleanup(() => observer.disconnect())
  })

  createEffect(() => {
    if (!expanded()) {
      setScrollContainer(undefined)
      scrollContainerRef = undefined
      setBottomSentinel(null)
      setAutoScroll(true)
    }
  })

  createEffect(() => {
    const permission = permissionDetails()
    if (!permission) {
      setPermissionSubmitting(false)
      setPermissionError(null)
    } else {
      setPermissionError(null)
    }
  })

  createEffect(() => {
    const activeKey = activePermissionKey() || activeQuestionKey()
    if (!activeKey) return
    requestAnimationFrame(() => {
      toolCallRootRef?.scrollIntoView({ block: "center", behavior: "smooth" })
    })
  })

  createEffect(() => {
    const activeKey = activePermissionKey()
    if (!activeKey) return
    const handler = (event: KeyboardEvent) => {
      const permission = permissionDetails()
      if (!permission || !isPermissionActive()) return
      if (event.key === "Enter") {
        event.preventDefault()
        void handlePermissionResponse(permission, "once")
      } else if (event.key === "a" || event.key === "A") {
        event.preventDefault()
        void handlePermissionResponse(permission, "always")
      } else if (event.key === "d" || event.key === "D") {
        event.preventDefault()
        void handlePermissionResponse(permission, "reject")
      }
    }
    document.addEventListener("keydown", handler)
    onCleanup(() => document.removeEventListener("keydown", handler))
  })

  const [questionSubmitting, setQuestionSubmitting] = createSignal(false)
  const [questionError, setQuestionError] = createSignal<string | null>(null)

  const [questionDraftAnswers, setQuestionDraftAnswers] = createSignal<Record<string, string[][]>>({})

  function isTextInputFocused() {
    const active = document.activeElement
    return (
      active?.tagName === "TEXTAREA" ||
      active?.tagName === "INPUT" ||
      (active?.hasAttribute("contenteditable") ?? false)
    )
  }

  async function handleQuestionSubmit() {
    const request = questionDetails()
    if (!request || !isQuestionActive()) {
      return
    }
    const answers = (questionDraftAnswers()[request.id] ?? []).map((x) => (Array.isArray(x) ? x : []))
    const normalized = request.questions.map((_, index) => {
      const row = answers[index] ?? []
      return row.map((value) => value.trim()).filter((value) => value.length > 0)
    })
    if (normalized.some((item) => (item?.length ?? 0) === 0)) {
      setQuestionError("Please answer all questions before submitting.")
      return
    }

    setQuestionSubmitting(true)
    setQuestionError(null)
    try {
      const sessionId = (request as any).sessionID ?? (request as any).sessionId ?? props.sessionId
      await sendQuestionReply(props.instanceId, sessionId, request.id, normalized)
    } catch (error) {
      log.error("Failed to send question reply", error)
      setQuestionError(error instanceof Error ? error.message : "Unable to reply")
    } finally {
      setQuestionSubmitting(false)
    }
  }

  async function handleQuestionDismiss() {
    const request = questionDetails()
    if (!request || !isQuestionActive()) {
      return
    }
    setQuestionSubmitting(true)
    setQuestionError(null)
    try {
      const sessionId = (request as any).sessionID ?? (request as any).sessionId ?? props.sessionId
      await sendQuestionReject(props.instanceId, sessionId, request.id)
    } catch (error) {
      log.error("Failed to reject question", error)
      setQuestionError(error instanceof Error ? error.message : "Unable to dismiss")
    } finally {
      setQuestionSubmitting(false)
    }
  }

  createEffect(() => {
    const activeKey = activeQuestionKey()
    if (!activeKey) return
    const handler = (event: KeyboardEvent) => {
      if (isTextInputFocused()) return
      if (event.key === "Enter") {
        event.preventDefault()
        void handleQuestionSubmit()
      } else if (event.key === "Escape") {
        event.preventDefault()
        void handleQuestionDismiss()
      }
    }
    document.addEventListener("keydown", handler)
    onCleanup(() => document.removeEventListener("keydown", handler))
  })


  const statusIcon = () => {
    const status = toolState()?.status || ""
    switch (status) {
      case "pending":
        return "⏸"
      case "running":
        return "⏳"
      case "completed":
        return "✓"
      case "error":
        return "✗"
      default:
        return ""
    }
  }

  const statusClass = () => {
    const status = toolState()?.status || "pending"
    return `tool-call-status-${status}`
  }

  const combinedStatusClass = () => {
    const base = statusClass()
    return pendingPermission() || pendingQuestion() ? `${base} tool-call-awaiting-permission` : base
  }

  function toggle() {
    const permission = pendingPermission()
    if (permission?.active) {
      return
    }
    setUserExpanded((prev) => {
      const current = prev === null ? defaultExpandedForTool() : prev
      return !current
    })
  }

  const renderer = createMemo(() => resolveToolRenderer(toolName()))

  const { renderAnsiContent } = createAnsiContentRenderer({
    ansiRunningCache,
    ansiFinalCache,
    scrollHelpers,
    partVersion: partVersionAccessor,
  })

  const { renderDiffContent } = createDiffContentRenderer({
    preferences,
    setDiffViewMode,
    isDark,
    diffCache,
    permissionDiffCache,
    scrollHelpers,
    handleScrollRendered,
    onContentRendered: props.onContentRendered,
  })

  const { renderMarkdownContent } = createMarkdownContentRenderer({
    toolState,
    partId: toolCallIdentifier,
    partVersion: partVersionAccessor,
    instanceId: props.instanceId,
    sessionId: props.sessionId,
    isDark,
    scrollHelpers,
    handleScrollRendered,
    onContentRendered: props.onContentRendered,
  })

  const rendererContext: ToolRendererContext = {
    toolCall: toolCallMemo,
    toolState,
    toolName,
    messageVersion: messageVersionAccessor,
    partVersion: partVersionAccessor,
    renderMarkdown: renderMarkdownContent,
    renderAnsi: renderAnsiContent,
    renderDiff: renderDiffContent,
    scrollHelpers,
  }

  let previousPartVersion: number | undefined
  createEffect(() => {
    const version = partVersionAccessor()
    if (!expanded()) {
      return
    }
    if (version === undefined) {
      return
    }
    if (previousPartVersion !== undefined && version === previousPartVersion) {
      return
    }
    previousPartVersion = version
    scheduleAnchorScroll()
  })

  createEffect(() => {
    if (expanded() && autoScroll()) {
      scheduleAnchorScroll(true)
    }
  })

  const getRendererAction = () => renderer().getAction?.(rendererContext) ?? getDefaultToolAction(toolName())


  const renderToolTitle = () => {
    const state = toolState()
    const currentTool = toolName()

    if (currentTool !== "task") {
      return resolveTitleForTool({ toolName: currentTool, state })
    }

    if (!state) return getRendererAction()
    if (state.status === "pending") return getRendererAction()

    const customTitle = renderer().getTitle?.(rendererContext)
    if (customTitle) return customTitle

    if (isToolStateRunning(state) && state.title) {
      return state.title
    }

    if (isToolStateCompleted(state) && state.title) {
      return state.title
    }

    return getToolName(currentTool)
  }

  const renderToolBody = () => {
    return renderer().renderBody(rendererContext)
  }

  async function handlePermissionResponse(permission: PermissionRequestLike, response: "once" | "always" | "reject") {
    if (!permission) return
    setPermissionSubmitting(true)
    setPermissionError(null)
    try {
      const sessionId = getPermissionSessionId(permission) || props.sessionId
      await sendPermissionResponse(props.instanceId, sessionId, permission.id, response)
    } catch (error) {
      log.error("Failed to send permission response", error)
      setPermissionError(error instanceof Error ? error.message : "Unable to update permission")
    } finally {
      setPermissionSubmitting(false)
    }
  }


  const renderError = () => {
    const state = toolState() || {}
    if (state.status === "error" && state.error) {
      return (
        <div class="tool-call-error-content">
          <strong>Error:</strong> {state.error}
        </div>
      )
    }
    return null
  }


  const renderPermissionBlock = () => (
    <PermissionToolBlock
      permission={permissionDetails}
      active={isPermissionActive}
      submitting={permissionSubmitting}
      error={permissionError}
      renderDiff={renderDiffContent}
      fallbackSessionId={() => props.sessionId}
      onRespond={(permission, sessionId, response) => void handlePermissionResponse(permission, response)}
    />
  )

  const renderQuestionBlock = () => (
    <QuestionToolBlock
      toolName={toolName}
      toolState={toolState}
      toolCallId={toolCallIdentifier}
      request={questionDetails}
      active={isQuestionActive}
      submitting={questionSubmitting}
      error={questionError}
      draftAnswers={questionDraftAnswers}
      setDraftAnswers={setQuestionDraftAnswers}
      onSubmit={() => void handleQuestionSubmit()}
      onDismiss={() => void handleQuestionDismiss()}
    />
  )

  createEffect(() => {
    const request = questionDetails()
    if (!request) {
      setQuestionSubmitting(false)
      setQuestionError(null)
      return
    }
    setQuestionError(null)
    const requestId = request.id
    setQuestionDraftAnswers((prev) => {
      if (prev[requestId]) return prev
      const initial = request.questions.map(() => [])
      return { ...prev, [requestId]: initial }
    })

  })

  const status = () => toolState()?.status || ""

  onCleanup(() => {
    if (pendingScrollFrame !== null) {
      cancelAnimationFrame(pendingScrollFrame)
      pendingScrollFrame = null
    }
    if (pendingAnchorScroll !== null) {
      cancelAnimationFrame(pendingAnchorScroll)
      pendingAnchorScroll = null
    }
    if (detachScrollIntentListeners) {
      detachScrollIntentListeners()
      detachScrollIntentListeners = undefined
    }
  })

  return (
    <div

      ref={(element) => {
        toolCallRootRef = element || undefined
      }}
      class={`tool-call ${combinedStatusClass()}`}
    >
      <button
        class="tool-call-header"
        onClick={toggle}
        aria-expanded={expanded()}
        data-status-icon={statusIcon()}
      >
        <span class="tool-call-summary" data-tool-icon={getToolIcon(toolName())}>
          {renderToolTitle()}
        </span>
      </button>

      {expanded() && (
        <div class="tool-call-details">
          {renderToolBody()}
 
          {renderError()}
 
          {renderPermissionBlock()}
          {renderQuestionBlock()}
 
          <Show when={status() === "pending" && !pendingPermission()}>
            <div class="tool-call-pending-message">
              <span class="spinner-small"></span>
              <span>Waiting to run...</span>
            </div>
          </Show>
        </div>
      )}
 
      <Show when={diagnosticsEntries().length}>

        {renderDiagnosticsSection(
          diagnosticsEntries(),
          diagnosticsExpanded(),
          () => setDiagnosticsOverride((prev) => {
            const current = prev === undefined ? diagnosticsDefaultExpanded() : prev
            return !current
          }),
          diagnosticFileName(diagnosticsEntries()),
        )}
      </Show>
    </div>
  )
}
