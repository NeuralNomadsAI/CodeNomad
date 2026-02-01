import { createSignal, Show, For, createEffect, createMemo, onCleanup } from "solid-js"
import { messageStoreBus } from "../stores/message-v2/bus"
import { Markdown } from "./markdown"
import { ToolCallDiffViewer } from "./diff-viewer"
import { useTheme } from "../lib/theme"
import { useGlobalCache } from "../lib/hooks/use-global-cache"
import { useConfig } from "../stores/preferences"
import type { DiffViewMode } from "../stores/preferences"
import { sendPermissionResponse } from "../stores/instances"
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
import { getQuestionRequests } from "../stores/question-store"
import { replyToQuestion, rejectQuestion } from "../stores/session-actions"
import { ansiToHtml, createAnsiStreamRenderer, hasAnsi } from "../lib/ansi"
import { escapeHtml } from "../lib/markdown"
import { cn } from "../lib/cn"

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
    <div class="mt-4 border-t border-border bg-background">
      <button
        type="button"
        class="flex items-center gap-2 p-2 w-full border-none cursor-pointer text-left font-mono text-[13px] text-muted-foreground bg-muted hover:bg-accent/10"
        aria-expanded={expanded}
        onClick={toggle}
      >
        <span class="text-base" aria-hidden="true">
          {expanded ? "\u25BC" : "\u25B6"}
        </span>
        <span class="text-base mr-1" aria-hidden="true">{"\uD83D\uDEE0"}</span>
        <span class="flex-1 text-left inline-flex items-center gap-2">Diagnostics</span>
        <span class="inline-flex items-center flex-1 text-xs text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap justify-end" title={fileLabel}>{fileLabel}</span>
      </button>
      <Show when={expanded}>
        <div class="flex flex-col gap-1 px-3 py-2 bg-background" role="region" aria-label="Diagnostics">
          <div class="flex flex-col gap-1 max-h-[calc(4*1.4em)] overflow-y-scroll scrollbar-thin" role="list">
            <For each={entries}>
              {(entry) => (
                <div class="flex flex-wrap items-baseline gap-2 text-xs text-foreground" role="listitem">
                  <span class={cn(
                    "inline-flex items-center gap-1 px-2 min-h-[20px] rounded-full text-xs font-medium tracking-[0.02em]",
                    entry.tone === "error" && "bg-destructive/10 text-destructive",
                    entry.tone === "warning" && "bg-warning/10 text-warning",
                    entry.tone === "info" && "bg-muted text-muted-foreground",
                  )}>
                    <span>{entry.icon}</span>
                    <span>{entry.label}</span>
                  </span>
                  <span class="font-mono text-muted-foreground inline-flex items-baseline gap-0.5" title={entry.filePath}>
                    {entry.displayPath}
                    <span class="text-muted-foreground">
                      :L{entry.line || "-"}:C{entry.column || "-"}
                    </span>
                  </span>
                  <span class="flex-1 min-w-[200px] text-foreground">{entry.message}</span>
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
  const toolCallIdentifier = createMemo(() => toolCallMemo()?.callID || props.toolCallId || toolCallMemo()?.id || "")
  const toolState = createMemo(() => toolCallMemo()?.state)

  const cacheContext = createMemo(() => ({
    toolCallId: toolCallIdentifier(),
    messageId: props.messageId,
    partId: toolCallMemo()?.id ?? null,
  }))

  const store = createMemo(() => messageStoreBus.getOrCreate(props.instanceId))

  const createVariantCache = (variant: string | (() => string)) =>
    useGlobalCache({
      instanceId: () => props.instanceId,
      sessionId: () => props.sessionId,
      scope: TOOL_CALL_CACHE_SCOPE,
      key: () => {
        const context = cacheContext()
        const resolvedVariant = typeof variant === "function" ? variant() : variant
        return makeRenderCacheKey(context.toolCallId || undefined, context.messageId, context.partId, resolvedVariant)
      },
    })

  const diffCache = createVariantCache("diff")
  const permissionDiffCache = createVariantCache("permission-diff")
  const markdownCache = createVariantCache("markdown")
  const ansiRunningCache = createVariantCache(() => {
    const versionKey = typeof props.partVersion === "number" ? String(props.partVersion) : "noversion"
    return `ansi-running:${versionKey}`
  })
  const ansiFinalCache = createVariantCache(() => {
    const versionKey = typeof props.partVersion === "number" ? String(props.partVersion) : "noversion"
    return `ansi-final:${versionKey}`
  })
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

  const expanded = () => {
    const permission = pendingPermission()
    if (permission?.active) return true
    if (pendingQuestion()) return true
    const override = userExpanded()
    if (override !== null) return override
    return defaultExpandedForTool()
  }

  const permissionDetails = createMemo(() => pendingPermission()?.permission)
  const isPermissionActive = createMemo(() => pendingPermission()?.active === true)
  const activePermissionKey = createMemo(() => {
    const permission = permissionDetails()
    return permission && isPermissionActive() ? permission.id : ""
  })
  const [permissionSubmitting, setPermissionSubmitting] = createSignal(false)
  const [permissionError, setPermissionError] = createSignal<string | null>(null)
  const [diagnosticsOverride, setDiagnosticsOverride] = createSignal<boolean | undefined>(undefined)

  // Question tool: match pending question to this tool call via callID
  const pendingQuestion = createMemo(() => {
    const callId = toolCallIdentifier()
    if (!callId) return null
    const requests = getQuestionRequests(props.instanceId, props.sessionId)
    return requests.find(r => r.tool?.callID === callId) ?? null
  })

  const [questionAnswers, setQuestionAnswers] = createSignal<Map<number, Set<string>>>(new Map())
  const [questionCustomText, setQuestionCustomText] = createSignal<Map<number, string>>(new Map())
  const [questionSubmitting, setQuestionSubmitting] = createSignal(false)
  const [questionError, setQuestionError] = createSignal<string | null>(null)

  const diagnosticsExpanded = () => {
    const permission = pendingPermission()
    if (permission?.active) return true
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
      return <div ref={setBottomSentinel} aria-hidden="true" style={{ height: "1px" }} />
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
    const activeKey = activePermissionKey()
    if (!activeKey) return
    requestAnimationFrame(() => {
      toolCallRootRef?.scrollIntoView({ block: "center", behavior: "smooth" })
    })
  })

  // Scroll into view when a question arrives for this tool call
  createEffect(() => {
    const question = pendingQuestion()
    if (!question) return
    requestAnimationFrame(() => {
      toolCallRootRef?.scrollIntoView({ block: "center", behavior: "smooth" })
    })
  })

  // Clear question UI state when the question is resolved
  createEffect(() => {
    if (!pendingQuestion()) {
      setQuestionSubmitting(false)
      setQuestionError(null)
    }
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


  const statusIcon = () => {
    const status = toolState()?.status || ""
    switch (status) {
      case "pending":
        return "\u23F8"
      case "running":
        return "\u23F3"
      case "completed":
        return "\u2713"
      case "error":
        return "\u2717"
      default:
        return ""
    }
  }

  const statusBorderClass = () => {
    const status = toolState()?.status || "pending"
    switch (status) {
      case "success":
      case "completed":
        return "border-l-success"
      case "error":
        return "border-l-destructive"
      case "running":
        return "border-l-warning"
      case "pending":
        return "border-l-info"
      default:
        return "border-l-border"
    }
  }

  const isRunning = () => toolState()?.status === "running"

  function toggle() {
    const permission = pendingPermission()
    if (permission?.active) {
      return
    }
    if (pendingQuestion()) return
    setUserExpanded((prev) => {
      const current = prev === null ? defaultExpandedForTool() : prev
      return !current
    })
  }

  const renderer = createMemo(() => resolveToolRenderer(toolName()))

  function renderDiffContent(payload: DiffPayload, options?: DiffRenderOptions) {
    const relativePath = payload.filePath ? getRelativePath(payload.filePath) : ""
    const toolbarLabel = options?.label || (relativePath ? `Diff \u00B7 ${relativePath}` : "Diff")
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
        class="message-text bg-muted text-foreground text-xs leading-tight max-h-[calc(30*1.4em)] overflow-y-scroll scrollbar-thin relative p-0"
        ref={(element) => scrollHelpers.registerContainer(element, { disableTracking: options?.disableScrollTracking })}
        onScroll={options?.disableScrollTracking ? undefined : scrollHelpers.handleScroll}
      >
        <div class="flex items-center justify-between gap-3 px-3 py-2 bg-secondary border-b border-border" role="group" aria-label="Diff view mode">
          <span class="text-xs text-muted-foreground uppercase tracking-[0.08em]">{toolbarLabel}</span>
          <div class="inline-flex items-center gap-1">
            <button
              type="button"
              class={cn(
                "border text-xs font-semibold px-3 py-1 rounded transition-all duration-150 border-border bg-transparent text-muted-foreground hover:bg-accent/10 hover:text-foreground",
                diffMode() === "split" && "bg-info border-info text-info-foreground",
              )}
              aria-pressed={diffMode() === "split"}
              onClick={() => handleModeChange("split")}
            >
              Split
            </button>
            <button
              type="button"
              class={cn(
                "border text-xs font-semibold px-3 py-1 rounded transition-all duration-150 border-border bg-transparent text-muted-foreground hover:bg-accent/10 hover:text-foreground",
                diffMode() === "unified" && "bg-info border-info text-info-foreground",
              )}
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
    const messageClass = cn(
      "message-text bg-muted text-foreground text-xs leading-tight overflow-y-scroll scrollbar-thin relative",
      size === "large" ? "max-h-[calc(30*1.4em)]" : "max-h-[calc(15*1.4em)]",
    )
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
        <pre class="bg-secondary border border-border p-2 px-3 font-mono text-xs leading-tight overflow-x-auto text-foreground" innerHTML={nextCache.html} />
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
    const messageClass = cn(
      "message-text bg-muted text-foreground text-xs leading-tight overflow-y-scroll scrollbar-thin relative",
      size === "large" ? "max-h-[calc(30*1.4em)]" : "max-h-[calc(15*1.4em)]",
    )

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

    const markdownPart: TextPart = { type: "text", text: options.content, version: props.partVersion }
    const cached = markdownCache.get<RenderCache>()
    if (cached) {
      markdownPart.renderCache = cached
    }

    const handleMarkdownRendered = () => {
      markdownCache.set(markdownPart.renderCache)
      handleScrollRendered()
      props.onContentRendered?.()
    }

    return (
      <div class={messageClass} ref={(element) => scrollHelpers.registerContainer(element)} onScroll={scrollHelpers.handleScroll}>
        <Markdown
          part={markdownPart}
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
      const sessionId = permission.sessionID || props.sessionId
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
        <div class="bg-destructive/10 border-l-[3px] border-destructive p-3 my-2 rounded text-destructive text-xs">
          <strong class="font-semibold">Error:</strong> {state.error}
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
      <div class={cn(
        "flex flex-col gap-3 border-2 border-warning m-0 px-5 py-4 bg-card",
        active ? "" : "opacity-80",
      )}>
        <div class="flex items-center justify-between gap-3">
          <span class="font-semibold text-sm text-foreground">{active ? "Permission Required" : "Permission Queued"}</span>
          <span class="font-mono text-xs px-1.5 py-0.5 rounded-md border border-border bg-muted">{permission.type}</span>
        </div>
        <div>
          <div>
            <code class="block text-[13px] text-foreground bg-muted border border-border rounded-lg px-3 py-2 break-words">{permission.title}</code>
          </div>
          <Show when={diffPayload}>
            {(payload) => (
              <div class="mt-4 mb-2">
                {renderDiffContent(payload(), {
                  variant: "permission-diff",
                  disableScrollTracking: true,
                  label: payload().filePath ? `Requested diff \u00B7 ${getRelativePath(payload().filePath || "")}` : "Requested diff",
                })}
              </div>
            )}
          </Show>
          <Show
            when={active}
            fallback={<p class="text-sm text-muted-foreground">Waiting for earlier permission responses.</p>}
          >
            <div class="flex items-center justify-between gap-3 flex-wrap mt-3">
              <div class="flex flex-wrap gap-2">
                <button
                  type="button"
                  class="bg-background border border-warning text-muted-foreground px-4 py-1.5 rounded-lg text-sm font-medium leading-tight transition-all duration-150 inline-flex items-center justify-center min-h-[1.75rem] hover:bg-accent/10 hover:text-warning active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={permissionSubmitting()}
                  onClick={() => handlePermissionResponse("once")}
                >
                  Allow Once
                </button>
                <button
                  type="button"
                  class="bg-background border border-warning text-muted-foreground px-4 py-1.5 rounded-lg text-sm font-medium leading-tight transition-all duration-150 inline-flex items-center justify-center min-h-[1.75rem] hover:bg-accent/10 hover:text-warning active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={permissionSubmitting()}
                  onClick={() => handlePermissionResponse("always")}
                >
                  Always Allow
                </button>
                <button
                  type="button"
                  class="bg-background border border-warning text-muted-foreground px-4 py-1.5 rounded-lg text-sm font-medium leading-tight transition-all duration-150 inline-flex items-center justify-center min-h-[1.75rem] hover:bg-accent/10 hover:text-warning active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={permissionSubmitting()}
                  onClick={() => handlePermissionResponse("reject")}
                >
                  Deny
                </button>
              </div>
              <div class="flex items-center gap-2 text-xs text-muted-foreground">
                <kbd class="kbd">Enter</kbd>
                <span>Allow once</span>
                <kbd class="kbd">A</kbd>
                <span>Always allow</span>
                <kbd class="kbd">D</kbd>
                <span>Deny</span>
              </div>
            </div>
            <Show when={permissionError()}>
              <div class="text-sm text-destructive mt-2">{permissionError()}</div>
            </Show>
          </Show>
        </div>
      </div>
    )
  }

  function toggleQuestionOption(questionIndex: number, label: string, isMultiple: boolean) {
    setQuestionAnswers(prev => {
      const next = new Map(prev)
      const current = new Set(next.get(questionIndex) ?? [])
      if (isMultiple) {
        if (current.has(label)) {
          current.delete(label)
        } else {
          current.add(label)
        }
      } else {
        if (current.has(label)) {
          current.clear()
        } else {
          current.clear()
          current.add(label)
        }
      }
      next.set(questionIndex, current)
      return next
    })
  }

  function setCustomText(questionIndex: number, text: string) {
    setQuestionCustomText(prev => {
      const next = new Map(prev)
      next.set(questionIndex, text)
      return next
    })
  }

  async function handleQuestionSubmit() {
    const question = pendingQuestion()
    if (!question) return

    setQuestionSubmitting(true)
    setQuestionError(null)

    try {
      const answers: string[][] = question.questions.map((_q, i) => {
        const selected = [...(questionAnswers().get(i) ?? [])]
        const custom = questionCustomText().get(i)?.trim()
        if (custom) {
          selected.push(custom)
        }
        return selected
      })

      await replyToQuestion(props.instanceId, question.id, answers)
      setQuestionAnswers(new Map())
      setQuestionCustomText(new Map())
    } catch (error) {
      log.error("Failed to reply to question", error)
      setQuestionError(error instanceof Error ? error.message : "Failed to send answer")
    } finally {
      setQuestionSubmitting(false)
    }
  }

  async function handleQuestionDismiss() {
    const question = pendingQuestion()
    if (!question) return

    setQuestionSubmitting(true)
    setQuestionError(null)

    try {
      await rejectQuestion(props.instanceId, question.id)
      setQuestionAnswers(new Map())
      setQuestionCustomText(new Map())
    } catch (error) {
      log.error("Failed to reject question", error)
      setQuestionError(error instanceof Error ? error.message : "Failed to dismiss question")
    } finally {
      setQuestionSubmitting(false)
    }
  }

  const renderQuestionBlock = () => {
    const question = pendingQuestion()
    if (!question) return null

    return (
      <div class="flex flex-col gap-3 border-2 border-info m-0 px-5 py-4 bg-card">
        <div class="flex items-center justify-between gap-3">
          <span class="font-semibold text-sm text-foreground">Question from Agent</span>
        </div>
        <div class="flex flex-col gap-3">
          <For each={question.questions}>
            {(q, qIndex) => (
              <div class="flex flex-col gap-2 [&+&]:mt-2 [&+&]:pt-3 [&+&]:border-t [&+&]:border-border">
                <Show when={q.header}>
                  <div class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold tracking-[0.04em] uppercase bg-info text-info-foreground w-fit">{q.header}</div>
                </Show>
                <div class="text-sm text-foreground leading-[1.4]">{q.question}</div>
                <Show when={q.options?.length > 0}>
                  <div class="flex flex-col gap-1.5">
                    <For each={q.options}>
                      {(opt) => {
                        const isSelected = () => questionAnswers().get(qIndex())?.has(opt.label) ?? false
                        return (
                          <button
                            type="button"
                            class={cn(
                              "flex flex-col gap-0.5 px-3 py-2 border border-border rounded-lg bg-background cursor-pointer transition-all duration-150 text-left hover:bg-accent/10 hover:border-info disabled:opacity-50 disabled:cursor-not-allowed",
                              isSelected() && "bg-info/10 border-info",
                            )}
                            disabled={questionSubmitting()}
                            onClick={() => toggleQuestionOption(qIndex(), opt.label, q.multiple ?? false)}
                          >
                            <span class="text-sm font-medium text-foreground">{opt.label}</span>
                            <Show when={opt.description}>
                              <span class="text-xs text-muted-foreground leading-[1.3]">{opt.description}</span>
                            </Show>
                          </button>
                        )
                      }}
                    </For>
                  </div>
                </Show>
                <Show when={q.custom !== false}>
                  <input
                    type="text"
                    class="w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground text-sm font-sans outline-none transition-colors duration-150 focus:border-info placeholder:text-muted-foreground disabled:opacity-50 disabled:cursor-not-allowed"
                    placeholder="Other (type your answer)..."
                    value={questionCustomText().get(qIndex()) ?? ""}
                    onInput={(e) => setCustomText(qIndex(), e.currentTarget.value)}
                    disabled={questionSubmitting()}
                  />
                </Show>
              </div>
            )}
          </For>
          <div class="flex items-center justify-start gap-3 flex-wrap mt-2">
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="bg-info border border-info text-info-foreground px-4 py-1.5 rounded-lg text-sm font-medium leading-tight transition-all duration-150 inline-flex items-center justify-center min-h-[1.75rem] cursor-pointer hover:opacity-85 active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={questionSubmitting()}
                onClick={handleQuestionSubmit}
              >
                Submit Answer
              </button>
              <button
                type="button"
                class="bg-background border border-border text-muted-foreground px-4 py-1.5 rounded-lg text-sm font-medium leading-tight transition-all duration-150 inline-flex items-center justify-center min-h-[1.75rem] cursor-pointer hover:bg-accent/10 hover:border-info hover:text-info active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={questionSubmitting()}
                onClick={handleQuestionDismiss}
              >
                Dismiss
              </button>
            </div>
          </div>
          <Show when={questionError()}>
            <div class="text-sm text-destructive mt-1">{questionError()}</div>
          </Show>
        </div>
      </div>
    )
  }

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
      class={cn(
        "border overflow-hidden border-border border-l-[3px]",
        statusBorderClass(),
        pendingQuestion() && "border-l-info",
        pendingPermission() && "border-l-warning",
        isRunning() && "[&_.tool-call-status]:animate-pulse",
      )}
    >
      <button
        class={cn(
          "flex items-center gap-2 p-2 w-full bg-transparent border-none cursor-pointer text-left font-mono text-[13px] hover:bg-accent/10",
          "before:content-['\u25B6'] before:text-xs before:mr-1 before:text-muted-foreground",
          expanded() && "before:content-['\u25BC']",
        )}
        onClick={toggle}
        aria-expanded={expanded()}
        data-status-icon={statusIcon()}
      >
        <span class="flex-1 text-left inline-flex items-center gap-2" data-tool-icon={getToolIcon(toolName())}>
          {renderToolTitle()}
        </span>
        <span class="text-[0.95rem] ml-2">{statusIcon()}</span>
      </button>

      {expanded() && (
        <div class="flex flex-col bg-muted text-xs text-foreground">
          {renderToolBody()}

          {renderError()}

          {renderPermissionBlock()}

          {renderQuestionBlock()}

          <Show when={status() === "pending" && !pendingPermission()}>
            <div class="flex items-center gap-2 p-3 text-xs italic text-muted-foreground">
              <span class="w-4 h-4 border-2 border-border border-t-primary rounded-full animate-spin"></span>
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
