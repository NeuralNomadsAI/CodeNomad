import { createSignal, Show, For, createEffect, createMemo, onCleanup } from "solid-js"
import { isToolCallExpanded, toggleToolCallExpanded, setToolCallExpanded } from "../stores/tool-call-state"
import { Markdown } from "./markdown"
import { ToolCallDiffViewer } from "./diff-viewer"
import { useTheme } from "../lib/theme"
import { getLanguageFromPath } from "../lib/markdown"
import { isRenderableDiffText } from "../lib/diff-utils"
import { getToolRenderCache, setToolRenderCache } from "../lib/tool-render-cache"
import { useConfig } from "../stores/preferences"
import type { DiffViewMode } from "../stores/preferences"
import { sendPermissionResponse } from "../stores/instances"
import type { TextPart, SDKPart, ClientPart } from "../types/message"

type ToolCallPart = Extract<ClientPart, { type: "tool" }>

// Import ToolState types from SDK
type ToolState = import("@opencode-ai/sdk").ToolState
type ToolStateRunning = import("@opencode-ai/sdk").ToolStateRunning  
type ToolStateCompleted = import("@opencode-ai/sdk").ToolStateCompleted
type ToolStateError = import("@opencode-ai/sdk").ToolStateError

// Type guards
function isToolStateRunning(state: ToolState): state is ToolStateRunning {
  return state.status === "running"
}

function isToolStateCompleted(state: ToolState): state is ToolStateCompleted {
  return state.status === "completed"
}

function isToolStateError(state: ToolState): state is ToolStateError {
  return state.status === "error"
}


const toolScrollState = new Map<string, { scrollTop: number; atBottom: boolean }>()

function makeRenderCacheKey(
  toolCallId?: string | null,
  messageId?: string,
  messageVersion?: number,
  partVersion?: number,
) {
  const suffix = `${messageVersion ?? 0}:${partVersion ?? 0}`
  const keyBase = `${messageId}:${toolCallId}`
  return `${keyBase}::${suffix}`
}

function updateScrollState(id: string, element: HTMLElement) {
  if (!id) return
  const distanceFromBottom = element.scrollHeight - (element.scrollTop + element.clientHeight)
  const atBottom = distanceFromBottom <= 2
  toolScrollState.set(id, { scrollTop: element.scrollTop, atBottom })
}

function restoreScrollState(id: string, element: HTMLElement) {
  if (!id) return
  const state = toolScrollState.get(id)
  if (!state) {
    requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight
      updateScrollState(id, element)
    })
    return
  }

  requestAnimationFrame(() => {
    if (state.atBottom) {
      element.scrollTop = element.scrollHeight
    } else {
      const maxScrollTop = Math.max(element.scrollHeight - element.clientHeight, 0)
      element.scrollTop = Math.min(state.scrollTop, maxScrollTop)
    }
    updateScrollState(id, element)
  })
}


interface ToolCallProps {
  toolCall: Extract<ClientPart, { type: "tool" }>
  toolCallId?: string
  messageId?: string
  messageVersion?: number
  partVersion?: number
  instanceId: string
  sessionId: string
}

function getToolIcon(tool: string): string {
  switch (tool) {
    case "bash":
      return "⚡"
    case "edit":
      return "✏️"
    case "read":
      return "📖"
    case "write":
      return "📝"
    case "glob":
      return "🔍"
    case "grep":
      return "🔎"
    case "webfetch":
      return "🌐"
    case "task":
      return "🎯"
    case "todowrite":
    case "todoread":
      return "📋"
    case "list":
      return "📁"
    case "patch":
      return "🔧"
    default:
      return "🔧"
  }
}

function getToolName(tool: string): string {
  switch (tool) {
    case "bash":
      return "Shell"
    case "webfetch":
      return "Fetch"
    case "invalid":
      return "Invalid"
    case "todowrite":
    case "todoread":
      return "Plan"
    default:
      const normalized = tool.replace(/^opencode_/, "")
      return normalized.charAt(0).toUpperCase() + normalized.slice(1)
  }
}

function getRelativePath(path: string): string {
  if (!path) return ""
  const parts = path.split("/")
  return parts.slice(-1)[0] || path
}

const diffCapableTools = new Set(["edit", "patch"])

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

interface DiffPayload {
  diffText: string
  filePath?: string
}

function extractDiffPayload(toolName: string, state: ToolState): DiffPayload | null {

  if (!diffCapableTools.has(toolName)) return null
  if (!state) return null
  
  const metadata = (isToolStateRunning(state) || isToolStateCompleted(state) || isToolStateError(state))
    ? state.metadata || {}
    : {}
  
  const output = isToolStateCompleted(state) ? state.output : undefined
  const candidates = [metadata.diff, output, metadata.output]
  let diffText: string | null = null

  for (const candidate of candidates) {
    if (typeof candidate === "string" && isRenderableDiffText(candidate)) {
      diffText = candidate
      break
    }
  }

  if (!diffText) {
    return null
  }

  const input = (isToolStateRunning(state) || isToolStateCompleted(state) || isToolStateError(state))
    ? state.input as Record<string, unknown>
    : {}
  const filePath = (typeof input.filePath === "string" ? input.filePath : undefined) || 
                   (typeof metadata.filePath === "string" ? metadata.filePath : undefined) || 
                   (typeof input.path === "string" ? input.path : undefined)

  return { diffText, filePath }
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

function extractDiagnostics(toolName: string, state: ToolState | undefined): DiagnosticEntry[] {
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
  const candidateEntries = Object.entries(diagnosticsMap).filter(([, items]) => Array.isArray(items) && items.length > 0)
  if (candidateEntries.length === 0) return []

  const prioritizedEntries = (() => {
    if (!normalizedPreferred) return candidateEntries
    const matched = candidateEntries.filter(([path]) => {
      const normalized = normalizeDiagnosticPath(path)
      if (normalized === normalizedPreferred) return true
      if (normalized.endsWith(`/${normalizedPreferred}`)) return true
      const normalizedBase = normalized.split("/").pop()
      const preferredBase = normalizedPreferred.split("/").pop()
      return normalizedBase && preferredBase ? normalizedBase === preferredBase : false
    })
    return matched.length > 0 ? matched : candidateEntries
  })()

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
  toolIcon: string,
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
  const toolCallId = () => props.toolCallId || props.toolCall?.id || ""
  const pendingPermission = createMemo(() => props.toolCall.pendingPermission)
  const expanded = () => (pendingPermission() ? true : isToolCallExpanded(toolCallId()))
  const toolOutputDefaultExpanded = createMemo(() => (preferences().toolOutputExpansion || "expanded") === "expanded")
  const diagnosticsDefaultExpanded = createMemo(() => (preferences().diagnosticsExpansion || "expanded") === "expanded")
  const [appliedPreference, setAppliedPreference] = createSignal<boolean | null>(null)
  const permissionDetails = createMemo(() => pendingPermission()?.permission)
  const isPermissionActive = createMemo(() => pendingPermission()?.active === true)
  const activePermissionKey = createMemo(() => {
    const permission = permissionDetails()
    return permission && isPermissionActive() ? permission.id : ""
  })
  const [permissionSubmitting, setPermissionSubmitting] = createSignal(false)
  const [permissionError, setPermissionError] = createSignal<string | null>(null)
  const [diagnosticsExpanded, setDiagnosticsExpanded] = createSignal(diagnosticsDefaultExpanded())
  const diagnosticsEntries = createMemo(() => {
    const tool = props.toolCall?.tool || ""
    const state = props.toolCall?.state
    if (!state) return []
    return extractDiagnostics(tool, state)
  })

  createEffect(() => {
    const preferred = diagnosticsDefaultExpanded()
    setDiagnosticsExpanded((prev) => (prev === preferred ? prev : preferred))
  })

  let scrollContainerRef: HTMLDivElement | undefined
  let toolCallRootRef: HTMLDivElement | undefined
 
  const handleScrollRendered = () => {
 
   const id = toolCallId()

    if (!id || !scrollContainerRef) return
    restoreScrollState(id, scrollContainerRef)
  }

  const initializeScrollContainer = (element: HTMLDivElement | null | undefined) => {
    const resolvedElement = element || undefined
    scrollContainerRef = resolvedElement
    const id = toolCallId()
    if (!resolvedElement || !id) return

    if (!toolScrollState.has(id)) {
      requestAnimationFrame(() => {
        if (!scrollContainerRef || toolCallId() !== id) return
        scrollContainerRef.scrollTop = scrollContainerRef.scrollHeight
        updateScrollState(id, scrollContainerRef)
      })
    } else {
      restoreScrollState(id, resolvedElement)
    }
  }

  createEffect(() => {
    const id = toolCallId()
    if (!id) return
    const toolName = props.toolCall?.tool || ""
    const desiredExpansion = toolName === "read" ? false : toolOutputDefaultExpanded()
    if (appliedPreference() === desiredExpansion) return
    setToolCallExpanded(id, desiredExpansion)
    setAppliedPreference(desiredExpansion)
  })

  createEffect(() => {
    const id = toolCallId()
    if (!id) return
    setAppliedPreference((prev) => (prev === null ? prev : null))
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

  // Cleanup cache entry when component unmounts or toolCallId changes
  createEffect(() => {
    const id = toolCallId()
    if (!id) return

    onCleanup(() => {
      toolScrollState.delete(id)
    })
  })

  createEffect(() => {
    if (props.toolCall?.tool !== "task") return
    const state = props.toolCall?.state
    const summarySignature = JSON.stringify(
      state && (isToolStateRunning(state) || isToolStateCompleted(state) || isToolStateError(state))
        ? state.metadata?.summary ?? [] 
        : []
    )
    requestAnimationFrame(() => {
      void summarySignature
      handleScrollRendered()
    })
  })

  createEffect(() => {
    const activeKey = activePermissionKey()
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


  const statusIcon = () => {
    const status = props.toolCall?.state?.status || ""
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
    const status = props.toolCall?.state?.status || "pending"
    return `tool-call-status-${status}`
  }

  const combinedStatusClass = () => {
    const base = statusClass()
    return pendingPermission() ? `${base} tool-call-awaiting-permission` : base
  }

  function toggle() {
    toggleToolCallExpanded(toolCallId())
  }

  const renderToolAction = () => {
    const toolName = props.toolCall?.tool || ""
    switch (toolName) {
      case "task":
        return "Delegating..."
      case "bash":
        return "Writing command..."
      case "edit":
        return "Preparing edit..."
      case "webfetch":
        return "Fetching from the web..."
      case "glob":
        return "Finding files..."
      case "grep":
        return "Searching content..."
      case "list":
        return "Listing directory..."
      case "read":
        return "Reading file..."
      case "write":
        return "Preparing write..."
      case "todowrite":
      case "todoread":
        return "Planning..."
      case "patch":
        return "Preparing patch..."
      default:
        return "Working..."
    }
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
      console.error("Failed to send permission response:", error)
      setPermissionError(error instanceof Error ? error.message : "Unable to update permission")
    } finally {
      setPermissionSubmitting(false)
    }
  }

  type TodoViewStatus = "pending" | "in_progress" | "completed" | "cancelled"

  interface TodoViewItem {
    id: string
    content: string
    status: TodoViewStatus
  }

  function normalizeTodoStatus(rawStatus: unknown): TodoViewStatus {
    if (rawStatus === "completed" || rawStatus === "in_progress" || rawStatus === "cancelled") return rawStatus
    return "pending"
  }

  function extractTodosFromState(state: ToolState | undefined): TodoViewItem[] {
    if (!state) return []
    const metadata = (isToolStateRunning(state) || isToolStateCompleted(state) || isToolStateError(state))
      ? state.metadata || {}
      : {}
    const todos = Array.isArray((metadata as any).todos) ? (metadata as any).todos : []
    const items: TodoViewItem[] = []

    for (let index = 0; index < todos.length; index++) {
      const todo = todos[index]
      const content = typeof todo?.content === "string" ? todo.content.trim() : ""
      if (!content) continue
      const status = normalizeTodoStatus((todo as any).status)
      const id = typeof todo?.id === "string" && todo.id.length > 0 ? todo.id : `${index}-${content}`
      items.push({ id, content, status })
    }

    return items
  }

  function summarizeTodos(todos: TodoViewItem[]) {
    return todos.reduce(
      (acc, todo) => {
        acc.total += 1
        acc[todo.status] = (acc[todo.status] || 0) + 1
        return acc
      },
      { total: 0, pending: 0, in_progress: 0, completed: 0, cancelled: 0 } as Record<TodoViewStatus | "total", number>,
    )
  }

  function getTodoStatusLabel(status: TodoViewStatus): string {
    switch (status) {
      case "completed":
        return "Completed"
      case "in_progress":
        return "In progress"
      case "cancelled":
        return "Cancelled"
      default:
        return "Pending"
    }
  }

  const getTodoTitle = () => {
    const state = props.toolCall?.state
    if (!state) return "Plan"

    const todos = extractTodosFromState(state)
    if (state.status !== "completed" || todos.length === 0) return "Plan"

    const counts = summarizeTodos(todos)
    if (counts.pending === counts.total) return "Creating plan"
    if (counts.completed === counts.total) return "Completing plan"
    return "Updating plan"
  }

  const renderToolTitle = () => {
    const toolName = props.toolCall?.tool || ""
    const state = props.toolCall?.state

    if (!state) return renderToolAction()
    if (state.status === "pending") return renderToolAction()

    const input = (isToolStateRunning(state) || isToolStateCompleted(state) || isToolStateError(state)) 
      ? (state.input as Record<string, unknown>)
      : {} as Record<string, unknown>

    if (isToolStateRunning(state) && state.title) {
      return state.title
    }
    
    if (isToolStateCompleted(state)) {
      return state.title
    }

    const name = getToolName(toolName)

    switch (toolName) {
      case "read":
        if (typeof input.filePath === "string") {
          return `${name} ${getRelativePath(input.filePath)}`
        }
        return name

      case "edit":
      case "write":
        if (typeof input.filePath === "string") {
          return `${name} ${getRelativePath(input.filePath)}`
        }
        return name

      case "bash":
        if (typeof input.description === "string") {
          return `${name} ${input.description}`
        }
        return name

      case "task":
        const description = input.description
        const subagent = input.subagent_type
        if (description && subagent) {
          return `${name}[${subagent}] ${description}`
        } else if (description) {
          return `${name} ${description}`
        }
        return name

      case "webfetch":
        if (input.url) {
          return `${name} ${input.url}`
        }
        return name

      case "todowrite":
        return getTodoTitle()

      case "todoread":
        return getTodoTitle()

      case "invalid":
        if (typeof input.tool === "string") {
          return getToolName(input.tool)
        }
        return name

      default:
        return name
    }
  }

  function renderToolBody() {
    const toolName = props.toolCall?.tool || ""
    const state = props.toolCall?.state || {}

    if (toolName === "todoread" || toolName === "todowrite") {
      return renderTodoTool()
    }

    if (state.status === "pending") {
      return null
    }

    if (toolName === "task") {
      return renderTaskTool()
    }

    const diffPayload = extractDiffPayload(toolName, state)
    if (diffPayload) {
      return renderDiffTool(diffPayload)
    }

    return renderMarkdownTool(toolName, state)
  }

  function renderDiffTool(payload: DiffPayload, options?: { cacheKeySuffix?: string; disableScrollTracking?: boolean; label?: string }) {
    const relativePath = payload.filePath ? getRelativePath(payload.filePath) : ""
    const toolbarLabel = options?.label || (relativePath ? `Diff · ${relativePath}` : "Diff")
    const cacheKeyBase = makeRenderCacheKey(toolCallId(), props.messageId, props.messageVersion, props.partVersion)
    const cacheKey = options?.cacheKeySuffix ? `${cacheKeyBase}${options.cacheKeySuffix}` : cacheKeyBase
    const diffMode = () => (preferences().diffViewMode || "split") as DiffViewMode
    const themeKey = isDark() ? "dark" : "light"

    // Check if we have valid cache
    let cachedHtml: string | undefined
    if (cacheKey) {
      const cached = getToolRenderCache(cacheKey)
      const currentMode = diffMode()
      if (cached && 
          cached.text === payload.diffText && 
          cached.theme === themeKey &&
          cached.mode === currentMode) {
        cachedHtml = cached.html
      }
    }

    const handleModeChange = (mode: DiffViewMode) => {
      setDiffViewMode(mode)
    }

    const handleDiffRendered = () => {
      if (cacheKey && !cachedHtml) {
        // Cache will be updated by the diff viewer component itself
        // We'll capture HTML from the rendered component
      }
      if (!options?.disableScrollTracking) {
        handleScrollRendered()
      }
    }

    return (
      <div
        class="message-text tool-call-markdown tool-call-markdown-large tool-call-diff-shell"
        ref={(element) => {
          if (options?.disableScrollTracking) return
          initializeScrollContainer(element)
        }}
        onScroll={options?.disableScrollTracking ? undefined : (event) => updateScrollState(toolCallId(), event.currentTarget)}
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
          cacheKey={cacheKey}
          onRendered={handleDiffRendered}
        />
      </div>
    )
  }

  function renderMarkdownTool(toolName: string, state: ToolState) {
    const content = getMarkdownContent(toolName, state)
    if (!content) {
      return null
    }

    const isLarge = toolName === "edit" || toolName === "write" || toolName === "patch"
    const messageClass = `message-text tool-call-markdown${isLarge ? " tool-call-markdown-large" : ""}`
    const disableHighlight = state?.status === "running"
    const cacheKey = makeRenderCacheKey(toolCallId(), props.messageId, props.messageVersion, props.partVersion)

    const markdownPart: TextPart = { type: "text", text: content }
    if (cacheKey) {
      const cached = getToolRenderCache(cacheKey)
      if (cached) {
        markdownPart.renderCache = cached
      }
    }

    const handleMarkdownRendered = () => {
      if (cacheKey) {
        setToolRenderCache(cacheKey, markdownPart.renderCache)
      }
      handleScrollRendered()
    }

    return (
      <div
        class={messageClass}
        ref={(element) => initializeScrollContainer(element)}
        onScroll={(event) => updateScrollState(toolCallId(), event.currentTarget)}
      >
        <Markdown
          part={markdownPart}
          isDark={isDark()}
          disableHighlight={disableHighlight}
          onRendered={handleMarkdownRendered}
        />
      </div>
    )
  }

  function getMarkdownContent(toolName: string, state: ToolState): string | null {
    if (!state) return null
    
    const input = (isToolStateRunning(state) || isToolStateCompleted(state) || isToolStateError(state))
      ? state.input as Record<string, unknown>
      : {}
    const metadata = (isToolStateRunning(state) || isToolStateCompleted(state) || isToolStateError(state))
      ? state.metadata || {}
      : {}

    switch (toolName) {
      case "read": {
        const preview = typeof metadata.preview === "string" ? metadata.preview : null
        const language = getLanguageFromPath(typeof input.filePath === "string" ? input.filePath : "")
        return ensureMarkdownContent(preview, language, true)
      }

      case "edit": {
        const diffText = typeof metadata.diff === "string" ? metadata.diff : null
        const fallback = isToolStateCompleted(state) && typeof state.output === "string" ? state.output : null
        return ensureMarkdownContent(diffText || fallback, "diff", true)
      }

      case "write": {
        const content = typeof input.content === "string" ? input.content : null
        const metadataContent = typeof metadata.content === "string" ? metadata.content : null
        const language = getLanguageFromPath(typeof input.filePath === "string" ? input.filePath : "")
        return ensureMarkdownContent(content || metadataContent, language, true)
      }

      case "patch": {
        const patchContent = typeof metadata.diff === "string" ? metadata.diff : null
        const fallback = isToolStateCompleted(state) && typeof state.output === "string" ? state.output : null
        return ensureMarkdownContent(patchContent || fallback, "diff", true)
      }

      case "bash": {
        const command = typeof input.command === "string" && input.command.length > 0 ? `$ ${input.command}` : ""
        const outputResult = formatUnknown(
          isToolStateCompleted(state) ? state.output : 
          (isToolStateRunning(state) || isToolStateError(state)) && metadata.output ? metadata.output : 
          undefined
        )
        const parts = [command, outputResult?.text].filter(Boolean)
        const combined = parts.join("\n")
        return ensureMarkdownContent(combined, "bash", true)
      }

      case "webfetch": {
        const result = formatUnknown(
          isToolStateCompleted(state) ? state.output : 
          (isToolStateRunning(state) || isToolStateError(state)) && metadata.output ? metadata.output : 
          undefined
        )
        if (!result) return null
        return ensureMarkdownContent(result.text, result.language, true)
      }

      default: {
        const result = formatUnknown(
          isToolStateCompleted(state) ? state.output : 
          (isToolStateRunning(state) || isToolStateError(state)) && metadata.output ? metadata.output : 
          metadata.diff ?? metadata.preview ?? input.content,
        )
        if (!result) return null
        return ensureMarkdownContent(result.text, result.language, true)
      }
    }
  }

  function ensureMarkdownContent(
    value: string | null,
    language?: string,
    forceFence = false,
  ): string | null {
    if (!value) {
      return null
    }

    const trimmed = value.replace(/\s+$/, "")
    if (!trimmed) {
      return null
    }

    const startsWithFence = trimmed.trimStart().startsWith("```")
    if (startsWithFence && !forceFence) {
      return trimmed
    }

    const langSuffix = language ? language : ""
    if (language || forceFence) {
      return `\u0060\u0060\u0060${langSuffix}\n${trimmed}\n\u0060\u0060\u0060`
    }

    return trimmed
  }

  function formatUnknown(value: unknown): { text: string; language?: string } | null {
    if (value === null || value === undefined) {
      return null
    }

    if (typeof value === "string") {
      return { text: value }
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return { text: String(value) }
    }

    if (Array.isArray(value)) {
      const parts = value
        .map((item) => {
          const formatted = formatUnknown(item)
          return formatted?.text ?? ""
        })
        .filter(Boolean)

      if (parts.length === 0) {
        return null
      }

      return { text: parts.join("\n") }
    }

    if (typeof value === "object") {
      try {
        return { text: JSON.stringify(value, null, 2), language: "json" }
      } catch (error) {
        console.error("Failed to stringify tool call output", error)
        return { text: String(value) }
      }
    }

    return null
  }

  const renderTodoTool = () => {
    const state = props.toolCall?.state
    if (!state) return null

    const todos = extractTodosFromState(state)
    const counts = summarizeTodos(todos)

    if (counts.total === 0) {
      return <div class="tool-call-todo-empty">No plan items yet.</div>
    }

    const completionPercent = Math.round((counts.completed / counts.total) * 100)

    return (
      <div class="tool-call-todo-region">
        <div class="tool-call-todo-summary">
          <div class="tool-call-todo-metrics">
            <span class="tool-call-todo-metric"><span class="tool-call-todo-metric-value">{counts.completed}</span> done</span>
            <span class="tool-call-todo-metric"><span class="tool-call-todo-metric-value">{counts.in_progress}</span> in progress</span>
            <span class="tool-call-todo-metric"><span class="tool-call-todo-metric-value">{counts.pending}</span> pending</span>
          </div>
          <div
            class="tool-call-todo-progress"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax={counts.total}
            aria-valuenow={counts.completed}
            aria-label="Plan progress"
          >
            <div class="tool-call-todo-progress-bar" style={{ width: `${completionPercent}%` }} />
          </div>
        </div>
        <div class="tool-call-todos" role="list">
          <For each={todos}>
            {(todo) => {
              const label = getTodoStatusLabel(todo.status)

              return (
                <div
                  class="tool-call-todo-item"
                  classList={{
                    "tool-call-todo-item-completed": todo.status === "completed",
                    "tool-call-todo-item-cancelled": todo.status === "cancelled",
                    "tool-call-todo-item-active": todo.status === "in_progress",
                  }}
                  role="listitem"
                >
                  <span class="tool-call-todo-checkbox" data-status={todo.status} aria-label={label}></span>
                  <div class="tool-call-todo-body">
                    <div class="tool-call-todo-heading">
                      <span class="tool-call-todo-text">{todo.content}</span>
                      <span class={`tool-call-todo-status tool-call-todo-status-${todo.status}`}>{label}</span>
                    </div>
                  </div>
                </div>
              )
            }}
          </For>
        </div>
      </div>
    )
  }

  const renderTaskTool = () => {
    const state = props.toolCall?.state
    if (!state) return null
    
    const metadata = (isToolStateRunning(state) || isToolStateCompleted(state) || isToolStateError(state))
      ? state.metadata || {}
      : {}
    const summary = metadata.summary || []

    if (!Array.isArray(summary) || summary.length === 0) {
      return null
    }

    return (
      <div
        class="message-text tool-call-markdown tool-call-task-container"
        ref={(element) => initializeScrollContainer(element)}
        onScroll={(event) => updateScrollState(toolCallId(), event.currentTarget)}
      >
        <div class="tool-call-task-summary">
          <For each={summary}>
            {(item) => {
              const tool = item.tool || "unknown"
              const itemInput = item.state?.input || {}
              const icon = getToolIcon(tool)

              let description = ""
              switch (tool) {
                case "bash":
                  description = itemInput.description || itemInput.command || ""
                  break
                case "edit":
                case "read":
                case "write":
                  description = `${tool} ${getRelativePath(itemInput.filePath || "")}`
                  break
                default:
                  description = tool
              }

              return (
                <div class="tool-call-task-item">
                  {icon} {description}
                </div>
              )
            }}
          </For>
        </div>
      </div>
    )
  }

  const renderError = () => {
    const state = props.toolCall?.state || {}
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
          <span class="tool-call-permission-type">{permission.type}</span>
        </div>
        <div class="tool-call-permission-body">
          <div class="tool-call-permission-title">
            <code>{permission.title}</code>
          </div>
          <Show when={diffPayload}>
            {(payload) => (
              <div class="tool-call-permission-diff">
                {renderDiffTool(payload(), {
                  cacheKeySuffix: "::permission",
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

  const toolName = () => props.toolCall?.tool || ""
  const status = () => props.toolCall?.state?.status || ""

  return (
    <div
      ref={(element) => {
        toolCallRootRef = element || undefined
      }}
      class={`tool-call ${combinedStatusClass()}`}
    >
      <button class="tool-call-header" onClick={toggle} aria-expanded={expanded()}>
        <span class="tool-call-icon">{expanded() ? "▼" : "▶"}</span>
        <span class="tool-call-emoji">{getToolIcon(toolName())}</span>
        <span class="tool-call-summary">{renderToolTitle()}</span>
        <span class="tool-call-status">{statusIcon()}</span>
      </button>

      <Show when={expanded()}>
        <div class="tool-call-details">
          {renderToolBody()}

          {renderError()}

          {renderPermissionBlock()}

          <Show when={status() === "pending" && !pendingPermission()}>
            <div class="tool-call-pending-message">
              <span class="spinner-small"></span>
              <span>Waiting for permission...</span>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={diagnosticsEntries().length}>
        {renderDiagnosticsSection(
          diagnosticsEntries(),
          diagnosticsExpanded(),
          () => setDiagnosticsExpanded((prev) => !prev),
          getToolIcon(toolName()),
          diagnosticFileName(diagnosticsEntries()),
        )}
      </Show>
    </div>
  )
}
