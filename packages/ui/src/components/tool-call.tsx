import { createSignal, Show, For, createEffect, createMemo, onCleanup } from "solid-js"
import { messageStoreBus } from "../stores/message-v2/bus"
import { Markdown } from "./markdown"
import { ToolCallDiffViewer } from "./diff-viewer"
import { useTheme } from "../lib/theme"
import { useGlobalCache } from "../lib/hooks/use-global-cache"
import { useConfig } from "../stores/preferences"
import type { DiffViewMode } from "../stores/preferences"
import { activeInterruption, sendPermissionResponse, sendQuestionReject, sendQuestionReply } from "../stores/instances"
import { getPermissionDisplayTitle, getPermissionKind, getPermissionSessionId } from "../types/permission"
import type { QuestionRequest } from "@opencode-ai/sdk/v2"
import type { TextPart, RenderCache } from "../types/message"
import { resolveToolRenderer } from "./tool-call/renderers"
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
import { ansiToHtml, createAnsiStreamRenderer, hasAnsi } from "../lib/ansi"
import { escapeHtml } from "../lib/markdown"

const log = getLogger("session")

type ToolState = import("@opencode-ai/sdk").ToolState

type AnsiRenderCache = RenderCache & { hasAnsi: boolean }

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



interface LspRangePosition {
  line?: number
  character?: number
}

interface LspRange {
  start?: LspRangePosition
}

interface LspDiagnostic {
  message?: string
  severity?: number
  range?: LspRange
}

interface DiagnosticEntry {
  id: string
  severity: number
  tone: "error" | "warning" | "info"
  label: string
  icon: string
  message: string
  filePath: string
  displayPath: string
  line: number
  column: number
}


function normalizeDiagnosticPath(path: string) {
  return path.replace(/\\/g, "/")
}

function determineSeverityTone(severity?: number): DiagnosticEntry["tone"] {
  if (severity === 1) return "error"
  if (severity === 2) return "warning"
  return "info"
}

function getSeverityMeta(tone: DiagnosticEntry["tone"]) {
  if (tone === "error") return { label: "ERR", icon: "!", rank: 0 }
  if (tone === "warning") return { label: "WARN", icon: "!", rank: 1 }
  return { label: "INFO", icon: "i", rank: 2 }
}

function extractDiagnostics(state: ToolState | undefined): DiagnosticEntry[] {
  if (!state) return []
  const supportsMetadata = isToolStateRunning(state) || isToolStateCompleted(state) || isToolStateError(state)
  if (!supportsMetadata) return []

  const metadata = (state.metadata || {}) as Record<string, unknown>
  const input = (state.input || {}) as Record<string, unknown>
  const diagnosticsMap = metadata?.diagnostics as Record<string, LspDiagnostic[] | undefined> | undefined
  if (!diagnosticsMap) return []

  const preferredPath = [
    input.filePath,
    metadata.filePath,
    metadata.filepath,
    input.path,
  ].find((value) => typeof value === "string" && value.length > 0) as string | undefined

  const normalizedPreferred = preferredPath ? normalizeDiagnosticPath(preferredPath) : undefined
  if (!normalizedPreferred) return []
  const candidateEntries = Object.entries(diagnosticsMap).filter(([, items]) => Array.isArray(items) && items.length > 0)
  if (candidateEntries.length === 0) return []

  const prioritizedEntries = candidateEntries.filter(([path]) => {
    const normalized = normalizeDiagnosticPath(path)
    return normalized === normalizedPreferred
  })

  if (prioritizedEntries.length === 0) return []

  const entries: DiagnosticEntry[] = []
  for (const [pathKey, list] of prioritizedEntries) {
    if (!Array.isArray(list)) continue
    const normalizedPath = normalizeDiagnosticPath(pathKey)
    for (let index = 0; index < list.length; index++) {
      const diagnostic = list[index]
      if (!diagnostic || typeof diagnostic.message !== "string") continue
      const tone = determineSeverityTone(typeof diagnostic.severity === "number" ? diagnostic.severity : undefined)
      const severityMeta = getSeverityMeta(tone)
      const line = typeof diagnostic.range?.start?.line === "number" ? diagnostic.range.start.line + 1 : 0
      const column = typeof diagnostic.range?.start?.character === "number" ? diagnostic.range.start.character + 1 : 0
      entries.push({
        id: `${normalizedPath}-${index}-${diagnostic.message}`,
        severity: severityMeta.rank,
        tone,
        label: severityMeta.label,
        icon: severityMeta.icon,
        message: diagnostic.message,
        filePath: normalizedPath,
        displayPath: getRelativePath(normalizedPath),
        line,
        column,
      })
    }
  }

  return entries.sort((a, b) => a.severity - b.severity)
}

function diagnosticFileName(entries: DiagnosticEntry[]) {
  const first = entries[0]
  return first ? first.displayPath : ""
}

function renderDiagnosticsSection(
  entries: DiagnosticEntry[],
  expanded: boolean,
  toggle: () => void,
  fileLabel: string,
) {
  if (entries.length === 0) return null
  return (
    <div class="tool-call-diagnostics-wrapper">
      <button
        type="button"
        class="tool-call-diagnostics-heading"
        aria-expanded={expanded}
        onClick={toggle}
      >
        <span class="tool-call-icon" aria-hidden="true">
          {expanded ? "▼" : "▶"}
        </span>
        <span class="tool-call-emoji" aria-hidden="true">🛠</span>
        <span class="tool-call-summary">Diagnostics</span>
        <span class="tool-call-diagnostics-file" title={fileLabel}>{fileLabel}</span>
      </button>
      <Show when={expanded}>
        <div class="tool-call-diagnostics" role="region" aria-label="Diagnostics">
          <div class="tool-call-diagnostics-body" role="list">
            <For each={entries}>
              {(entry) => (
                <div class="tool-call-diagnostic-row" role="listitem">
                  <span class={`tool-call-diagnostic-chip tool-call-diagnostic-${entry.tone}`}>
                    <span class="tool-call-diagnostic-chip-icon">{entry.icon}</span>
                    <span>{entry.label}</span>
                  </span>
                  <span class="tool-call-diagnostic-path" title={entry.filePath}>
                    {entry.displayPath}
                    <span class="tool-call-diagnostic-coords">
                      :L{entry.line || "-"}:C{entry.column || "-"}
                    </span>
                  </span>
                  <span class="tool-call-diagnostic-message">{entry.message}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
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
  const runningAnsiRenderer = createAnsiStreamRenderer()
  let runningAnsiSource = ""

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
      if (event.key === "Enter") {
        event.preventDefault()
        handlePermissionResponse("once")
      } else if (event.key === "a" || event.key === "A") {
        event.preventDefault()
        handlePermissionResponse("always")
      } else if (event.key === "d" || event.key === "D") {
        event.preventDefault()
        handlePermissionResponse("reject")
      }
    }
    document.addEventListener("keydown", handler)
    onCleanup(() => document.removeEventListener("keydown", handler))
  })

  const [questionSubmitting, setQuestionSubmitting] = createSignal(false)
  const [questionError, setQuestionError] = createSignal<string | null>(null)

  const [questionDraftAnswers, setQuestionDraftAnswers] = createSignal<Record<string, string[][]>>({})
  const [questionCustomDraft, setQuestionCustomDraft] = createSignal<Record<string, string[]>>({})

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
    const normalized = request.questions.map((_, index) => answers[index] ?? [])
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

  function renderDiffContent(payload: DiffPayload, options?: DiffRenderOptions) {
    const relativePath = payload.filePath ? getRelativePath(payload.filePath) : ""
    const toolbarLabel = options?.label || (relativePath ? `Diff · ${relativePath}` : "Diff")
    const selectedVariant = options?.variant === "permission-diff" ? "permission-diff" : "diff"
    const cacheHandle = selectedVariant === "permission-diff" ? permissionDiffCache : diffCache
    const diffMode = () => (preferences().diffViewMode || "split") as DiffViewMode
    const themeKey = isDark() ? "dark" : "light"

    let cachedHtml: string | undefined
    const cached = cacheHandle.get<RenderCache>()
    const currentMode = diffMode()
    if (cached && cached.text === payload.diffText && cached.theme === themeKey && cached.mode === currentMode) {
      cachedHtml = cached.html
    }

    const handleModeChange = (mode: DiffViewMode) => {
      setDiffViewMode(mode)
    }

    const handleDiffRendered = () => {
      if (!options?.disableScrollTracking) {
        handleScrollRendered()
      }
      props.onContentRendered?.()
    }

    return (
      <div
        class="message-text tool-call-markdown tool-call-markdown-large tool-call-diff-shell"
        ref={(element) => scrollHelpers.registerContainer(element, { disableTracking: options?.disableScrollTracking })}
        onScroll={options?.disableScrollTracking ? undefined : scrollHelpers.handleScroll}
      >
        <div class="tool-call-diff-toolbar" role="group" aria-label="Diff view mode">
          <span class="tool-call-diff-toolbar-label">{toolbarLabel}</span>
          <div class="tool-call-diff-toggle">
            <button
              type="button"
              class={`tool-call-diff-mode-button${diffMode() === "split" ? " active" : ""}`}
              aria-pressed={diffMode() === "split"}
              onClick={() => handleModeChange("split")}
            >
              Split
            </button>
            <button
              type="button"
              class={`tool-call-diff-mode-button${diffMode() === "unified" ? " active" : ""}`}
              aria-pressed={diffMode() === "unified"}
              onClick={() => handleModeChange("unified")}
            >
              Unified
            </button>
          </div>
        </div>
        <ToolCallDiffViewer
          diffText={payload.diffText}
          filePath={payload.filePath}
          theme={themeKey}
          mode={diffMode()}
          cachedHtml={cachedHtml}
          cacheEntryParams={cacheHandle.params()}
          onRendered={handleDiffRendered}
        />
        {scrollHelpers.renderSentinel({ disableTracking: options?.disableScrollTracking })}
      </div>
    )
  }

  function renderAnsiContent(options: AnsiRenderOptions) {
    if (!options.content) {
      return null
    }

    const size = options.size || "default"
    const messageClass = `message-text tool-call-markdown${size === "large" ? " tool-call-markdown-large" : ""}`
    const cacheHandle = options.variant === "running" ? ansiRunningCache : ansiFinalCache
    const cached = cacheHandle.get<AnsiRenderCache>()
    const mode = typeof props.partVersion === "number" ? String(props.partVersion) : undefined
    const isRunningVariant = options.variant === "running"

    let nextCache: AnsiRenderCache

    if (isRunningVariant) {
      const content = options.content
      const resetStreaming = !cached || !cached.text || !content.startsWith(cached.text) || cached.text !== runningAnsiSource

      if (resetStreaming) {
        const detectedAnsi = hasAnsi(content)
        if (detectedAnsi) {
          runningAnsiRenderer.reset()
          const html = runningAnsiRenderer.render(content)
          nextCache = { text: content, html, mode, hasAnsi: true }
        } else {
          runningAnsiRenderer.reset()
          nextCache = { text: content, html: escapeHtml(content), mode, hasAnsi: false }
        }
      } else {
        const delta = content.slice(cached.text.length)
        if (delta.length === 0) {
          nextCache = { ...cached, mode }
        } else if (!cached.hasAnsi && hasAnsi(delta)) {
          runningAnsiRenderer.reset()
          const html = runningAnsiRenderer.render(content)
          nextCache = { text: content, html, mode, hasAnsi: true }
        } else if (cached.hasAnsi) {
          const htmlChunk = runningAnsiRenderer.render(delta)
          nextCache = { text: content, html: `${cached.html}${htmlChunk}`, mode, hasAnsi: true }
        } else {
          nextCache = { text: content, html: `${cached.html}${escapeHtml(delta)}`, mode, hasAnsi: false }
        }
      }

      runningAnsiSource = nextCache.text
      cacheHandle.set(nextCache)
    } else {
      if (cached && cached.text === options.content) {
        nextCache = { ...cached, mode }
      } else {
        const detectedAnsi = hasAnsi(options.content)
        const html = detectedAnsi ? ansiToHtml(options.content) : escapeHtml(options.content)
        nextCache = { text: options.content, html, mode, hasAnsi: detectedAnsi }
        cacheHandle.set(nextCache)
      }
    }

    if (options.requireAnsi && !nextCache.hasAnsi) {
      return null
    }

    return (
      <div class={messageClass} ref={(element) => scrollHelpers.registerContainer(element)} onScroll={scrollHelpers.handleScroll}>
        <pre class="tool-call-content tool-call-ansi" innerHTML={nextCache.html} />
        {scrollHelpers.renderSentinel()}
      </div>
    )
  }

  function renderMarkdownContent(options: MarkdownRenderOptions) {
    if (!options.content) {
      return null
    }

    const size = options.size || "default"
    const disableHighlight = options.disableHighlight || false
    const messageClass = `message-text tool-call-markdown${size === "large" ? " tool-call-markdown-large" : ""}`

    const state = toolState()
    const shouldDeferMarkdown = Boolean(state && (state.status === "running" || state.status === "pending") && disableHighlight)
    if (shouldDeferMarkdown) {
      return (
        <div class={messageClass} ref={(element) => scrollHelpers.registerContainer(element)} onScroll={scrollHelpers.handleScroll}>
          <pre class="whitespace-pre-wrap break-words text-sm font-mono">{options.content}</pre>
          {scrollHelpers.renderSentinel()}
        </div>
      )
    }

    const partId = toolCallMemo()?.id
    if (!partId) {
      throw new Error("Tool call markdown requires a part id")
    }
    const markdownPart: TextPart = { id: partId, type: "text", text: options.content, version: props.partVersion }

    const handleMarkdownRendered = () => {
      handleScrollRendered()
      props.onContentRendered?.()
    }

    return (
      <div class={messageClass} ref={(element) => scrollHelpers.registerContainer(element)} onScroll={scrollHelpers.handleScroll}>
        <Markdown
          part={markdownPart}
          instanceId={props.instanceId}
          sessionId={props.sessionId}
          isDark={isDark()}
          disableHighlight={disableHighlight}
          onRendered={handleMarkdownRendered}
        />
        {scrollHelpers.renderSentinel()}
      </div>
    )
  }


  const messageVersionAccessor = createMemo(() => props.messageVersion)
  const partVersionAccessor = createMemo(() => props.partVersion)

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

  async function handlePermissionResponse(response: "once" | "always" | "reject") {
    const permission = permissionDetails()
    if (!permission || !isPermissionActive()) {
      return
    }
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


  const renderPermissionBlock = () => {
    const permission = permissionDetails()
    if (!permission) return null
    const active = isPermissionActive()
    const metadata = (permission.metadata ?? {}) as Record<string, unknown>
    const diffValue = typeof metadata.diff === "string" ? (metadata.diff as string) : null
    const diffPathRaw = (() => {
      if (typeof metadata.filePath === "string") {
        return metadata.filePath as string
      }
      if (typeof metadata.path === "string") {
        return metadata.path as string
      }
      return undefined
    })()
    const diffPayload = diffValue && diffValue.trim().length > 0 ? { diffText: diffValue, filePath: diffPathRaw } : null

    return (
      <div class={`tool-call-permission ${active ? "tool-call-permission-active" : "tool-call-permission-queued"}`}>
        <div class="tool-call-permission-header">
          <span class="tool-call-permission-label">{active ? "Permission Required" : "Permission Queued"}</span>
          <span class="tool-call-permission-type">{getPermissionKind(permission)}</span>
        </div>
        <div class="tool-call-permission-body">
          <div class="tool-call-permission-title">
            <code>{getPermissionDisplayTitle(permission)}</code>
          </div>
          <Show when={diffPayload}>
            {(payload) => (
              <div class="tool-call-permission-diff">
                {renderDiffContent(payload(), {
                  variant: "permission-diff",
                  disableScrollTracking: true,
                  label: payload().filePath ? `Requested diff · ${getRelativePath(payload().filePath || "")}` : "Requested diff",
                })}
              </div>
            )}
          </Show>
          <Show
            when={active}
            fallback={<p class="tool-call-permission-queued-text">Waiting for earlier permission responses.</p>}
          >
            <div class="tool-call-permission-actions">
              <div class="tool-call-permission-buttons">
                <button
                  type="button"
                  class="tool-call-permission-button"
                  disabled={permissionSubmitting()}
                  onClick={() => handlePermissionResponse("once")}
                >
                  Allow Once
                </button>
                <button
                  type="button"
                  class="tool-call-permission-button"
                  disabled={permissionSubmitting()}
                  onClick={() => handlePermissionResponse("always")}
                >
                  Always Allow
                </button>
                <button
                  type="button"
                  class="tool-call-permission-button"
                  disabled={permissionSubmitting()}
                  onClick={() => handlePermissionResponse("reject")}
                >
                  Deny
                </button>
              </div>
              <div class="tool-call-permission-shortcuts">
                <kbd class="kbd">Enter</kbd>
                <span>Allow once</span>
                <kbd class="kbd">A</kbd>
                <span>Always allow</span>
                <kbd class="kbd">D</kbd>
                <span>Deny</span>
              </div>
            </div>
            <Show when={permissionError()}>
              <div class="tool-call-permission-error">{permissionError()}</div>
            </Show>
          </Show>
        </div>
      </div>
    )
  }

  const renderQuestionBlock = () => {
    const state = toolState()
    const request = questionDetails()
    const isQuestionTool = toolName() === "question"

    if (!request && !isQuestionTool) return null

    const questionsSource = request?.questions ?? ((state as any)?.input?.questions as any[] | undefined) ?? []
    const questions = Array.isArray(questionsSource) ? questionsSource : []
    if (questions.length === 0) return null

    const requestId = request?.id ?? (state as any)?.input?.requestID ?? `question-${toolCallMemo()?.id ?? "unknown"}`
    const active = () => Boolean(request && isQuestionActive())

    const completedAnswers = Array.isArray((state as any)?.metadata?.answers) ? ((state as any).metadata.answers as string[][]) : undefined
    const answers = completedAnswers ?? questionDraftAnswers()[requestId] ?? []
    const customInputs = questionCustomDraft()[requestId] ?? []

    const updateAnswer = (questionIndex: number, next: string[]) => {
      if (!active()) return
      setQuestionDraftAnswers((prev) => {
        const current = prev[requestId] ?? []
        const updated = [...current]
        updated[questionIndex] = next
        return { ...prev, [requestId]: updated }
      })
    }

    const updateCustom = (questionIndex: number, value: string) => {
      if (!active()) return
      setQuestionCustomDraft((prev) => {
        const current = prev[requestId] ?? []
        const updated = [...current]
        updated[questionIndex] = value
        return { ...prev, [requestId]: updated }
      })
    }

    const toggleOption = (questionIndex: number, label: string) => {
      const info = questions[questionIndex]
      const multi = info?.multiple === true
      const existing = answers[questionIndex] ?? []
      if (multi) {
        const next = existing.includes(label) ? existing.filter((x) => x !== label) : [...existing, label]
        updateAnswer(questionIndex, next)
        return
      }
      updateAnswer(questionIndex, [label])
    }

    const submitDisabled = () => {
      if (!active()) return true
      if (questionSubmitting()) return true
      return questions.some((_, index) => (answers[index]?.length ?? 0) === 0)
    }

    const showButtons = () => active()

    return (
      <div class={`tool-call-permission ${active() ? "tool-call-permission-active" : "tool-call-permission-queued"}`}>
        <div class="tool-call-permission-header">
          <span class="tool-call-permission-label">
            {active() ? "Question Required" : request ? "Question Queued" : "Questions"}
          </span>
          <span class="tool-call-permission-type">{questions.length === 1 ? "Question" : "Questions"}</span>
        </div>

        <div class="tool-call-permission-body">
          <div class="flex flex-col gap-4">
            <For each={questions}>
              {(q, index) => {
                const i = () => index()
                const multi = () => q?.multiple === true
                const selected = () => answers[i()] ?? []
                const customValue = () => customInputs[i()] ?? ""
                const inputType = () => (multi() ? "checkbox" : "radio")
                const groupName = () => `question-${requestId}-${i()}`

                return (
                  <div class="rounded-md border border-base/60 bg-surface/30 p-3">
                    <div class="flex items-baseline justify-between gap-2">
                      <div class="text-xs">
                        Q{i() + 1}: <span class="font-semibold">{q?.header}</span>
                      </div>
                      <Show when={multi()}>
                        <div class="text-xs text-muted">Multiple</div>
                      </Show>
                    </div>

                    <div class="mt-1 text-sm font-medium">{q?.question}</div>

                    <div class="mt-3 flex flex-col gap-1">
                      <For each={q?.options ?? []}>
                        {(opt) => {
                          const checked = () => selected().includes(opt.label)
                          return (
                            <label
                              class={`flex items-start gap-2 py-1 ${active() ? "cursor-pointer" : request ? "opacity-80" : ""}`}
                              title={opt.description}
                            >
                              <input
                                type={inputType()}
                                name={groupName()}
                                checked={checked()}
                                disabled={!active() || questionSubmitting()}
                                onChange={() => toggleOption(i(), opt.label)}
                              />
                              <div class="flex flex-col">
                                <div class="text-sm leading-tight">{opt.label}</div>
                                <div class="text-xs text-muted leading-tight">{opt.description}</div>
                              </div>
                            </label>
                          )
                        }}
                      </For>

                      <Show when={active()}>
                        <div class="mt-2 flex items-center gap-2">
                          <input
                            class="flex-1 rounded-md border border-base/50 bg-surface px-2 py-1 text-sm"
                            type="text"
                            placeholder="Type your own answer"
                            value={customValue()}
                            disabled={!active() || questionSubmitting()}
                            onInput={(e) => updateCustom(i(), e.currentTarget.value)}
                          />
                          <button
                            type="button"
                            class="tool-call-permission-button"
                            disabled={!active() || questionSubmitting() || !customValue().trim()}
                            onClick={() => {
                              const value = customValue().trim()
                              if (!value) return
                              updateCustom(i(), value)
                              toggleOption(i(), value)
                            }}
                          >
                            {multi() ? "Toggle" : "Select"}
                          </button>
                        </div>
                      </Show>
                    </div>

                  </div>
                )
              }}
            </For>

            <Show when={showButtons()}>
              <div class="tool-call-permission-actions">
                <div class="tool-call-permission-buttons">
                  <button
                    type="button"
                    class="tool-call-permission-button"
                    disabled={submitDisabled()}
                    onClick={() => handleQuestionSubmit()}
                  >
                    Submit
                  </button>
                  <button
                    type="button"
                    class="tool-call-permission-button"
                    disabled={questionSubmitting()}
                    onClick={() => handleQuestionDismiss()}
                  >
                    Dismiss
                  </button>
                </div>

                <div class="tool-call-permission-shortcuts">
                  <kbd class="kbd">Enter</kbd>
                  <span>Submit</span>
                  <kbd class="kbd">Esc</kbd>
                  <span>Dismiss</span>
                </div>

                <Show when={questionError()}>
                  <div class="tool-call-permission-error">{questionError()}</div>
                </Show>
              </div>
            </Show>

            <Show when={!active() && request}>
              <p class="tool-call-permission-queued-text">Waiting for earlier responses.</p>
            </Show>
          </div>
        </div>
      </div>
    )
  }

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
    setQuestionCustomDraft((prev) => {
      if (prev[requestId]) return prev
      const initial = request.questions.map(() => "")
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
