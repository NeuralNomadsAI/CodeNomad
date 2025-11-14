import { createSignal, Show, For, createEffect, onCleanup } from "solid-js"
import { isToolCallExpanded, toggleToolCallExpanded, setToolCallExpanded } from "../stores/tool-call-state"
import { Markdown } from "./markdown"
import { ToolCallDiffViewer } from "./diff-viewer"
import { useTheme } from "../lib/theme"
import { getLanguageFromPath } from "../lib/markdown"
import { isRenderableDiffText } from "../lib/diff-utils"
import { getToolRenderCache, setToolRenderCache } from "../lib/tool-render-cache"
import { useConfig } from "../stores/preferences"
import type { DiffViewMode } from "../stores/preferences"
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

export default function ToolCall(props: ToolCallProps) {
  const { preferences, setDiffViewMode } = useConfig()
  const { isDark } = useTheme()
  const toolCallId = () => props.toolCallId || props.toolCall?.id || ""
  const expanded = () => isToolCallExpanded(toolCallId())
  const [initializedId, setInitializedId] = createSignal<string | null>(null)


  let scrollContainerRef: HTMLDivElement | undefined

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
    if (!id || initializedId() === id) return

    const tool = props.toolCall?.tool || ""
    const shouldExpand = tool !== "read"

    setToolCallExpanded(id, shouldExpand)
    setInitializedId(id)
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

  const getTodoTitle = () => {
    const state = props.toolCall?.state || {}
    if (state.status !== "completed") return "Plan"

    const metadata = state.metadata || {}
    const todos = metadata.todos || []

    if (!Array.isArray(todos) || todos.length === 0) return "Plan"

    const counts = { pending: 0, completed: 0 }
    for (const todo of todos) {
      const status = todo.status || "pending"
      if (status in counts) counts[status as keyof typeof counts]++
    }

    const total = todos.length
    if (counts.pending === total) return "Creating plan"
    if (counts.completed === total) return "Completing plan"
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
        return "Plan"

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

    if (toolName === "todoread") {
      return null
    }

    if (state.status === "pending") {
      return null
    }

    if (toolName === "todowrite") {
      return renderTodowriteTool()
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

  function renderDiffTool(payload: DiffPayload) {
    const relativePath = payload.filePath ? getRelativePath(payload.filePath) : ""
    const toolbarLabel = relativePath ? `Diff · ${relativePath}` : "Diff"
    const cacheKey = makeRenderCacheKey(toolCallId(), props.messageId, props.messageVersion, props.partVersion)
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
      handleScrollRendered()
    }

    return (
      <div
        class="message-text tool-call-markdown tool-call-markdown-large tool-call-diff-shell"
        ref={(element) => initializeScrollContainer(element)}
        onScroll={(event) => updateScrollState(toolCallId(), event.currentTarget)}
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

  const renderTodowriteTool = () => {
    const state = props.toolCall?.state
    if (!state) return null
    
    const metadata = (isToolStateRunning(state) || isToolStateCompleted(state) || isToolStateError(state))
      ? state.metadata || {}
      : {}
    const todos = metadata.todos || []

    if (!Array.isArray(todos) || todos.length === 0) {
      return null
    }

    const getStatusLabel = (status: string): string => {
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

    const shouldShowTag = (status: string) => status === "cancelled"

    return (
      <div class="tool-call-todos" role="list">
        <For each={todos}>
          {(todo) => {
            const content = typeof todo.content === "string" ? todo.content.trim() : ""
            if (!content) return null

            const status = typeof todo.status === "string" ? todo.status : "pending"
            const label = getStatusLabel(status)

            return (
              <div
                class="tool-call-todo-item"
                classList={{
                  "tool-call-todo-item-completed": status === "completed",
                  "tool-call-todo-item-cancelled": status === "cancelled",
                  "tool-call-todo-item-active": status === "in_progress",
                }}
                role="listitem"
              >
                <span class="tool-call-todo-checkbox" data-status={status} aria-label={label}></span>
                <div class="tool-call-todo-body">
                  <span class="tool-call-todo-text">{content}</span>
                  <Show when={shouldShowTag(status)}>
                    <span class="tool-call-todo-tag">{label}</span>
                  </Show>
                </div>
              </div>
            )
          }}
        </For>
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

  const toolName = () => props.toolCall?.tool || ""
  const status = () => props.toolCall?.state?.status || ""

  return (
    <div class={`tool-call ${statusClass()}`}>
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

          <Show when={status() === "pending"}>
            <div class="tool-call-pending-message">
              <span class="spinner-small"></span>
              <span>Waiting for permission...</span>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}
