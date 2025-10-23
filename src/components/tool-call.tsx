import { createSignal, Show, For, createEffect } from "solid-js"
import { isToolCallExpanded, toggleToolCallExpanded } from "../stores/tool-call-state"
import { CodeBlockInline } from "./code-block-inline"
import { Markdown } from "./markdown"
import { useTheme } from "../lib/theme"

interface ToolCallProps {
  toolCall: any
  toolCallId?: string
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

function getLanguageFromPath(path: string): string | undefined {
  if (!path) return undefined
  const ext = path.split(".").pop()?.toLowerCase()
  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    sh: "bash",
    bash: "bash",
    json: "json",
    html: "html",
    css: "css",
    md: "markdown",
    yaml: "yaml",
    yml: "yaml",
    sql: "sql",
    rs: "rust",
    go: "go",
    cpp: "cpp",
    cc: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    h: "cpp",
    c: "c",
    java: "java",
    cs: "csharp",
    php: "php",
    rb: "ruby",
    swift: "swift",
    kt: "kotlin",
  }
  return ext ? langMap[ext] : undefined
}

function hasMarkdownCodeBlocks(text: string): boolean {
  return /```[\s\S]*?```/.test(text)
}

export default function ToolCall(props: ToolCallProps) {
  const { isDark } = useTheme()
  const toolCallId = () => props.toolCallId || props.toolCall?.id || ""
  const expanded = () => isToolCallExpanded(toolCallId())

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
    const state = props.toolCall?.state || {}
    const input = state.input || {}

    if (state.status === "pending") {
      return renderToolAction()
    }

    if (state.title) {
      return state.title
    }

    const name = getToolName(toolName)

    switch (toolName) {
      case "read":
        if (input.filePath) {
          return `${name} ${getRelativePath(input.filePath)}`
        }
        return name

      case "edit":
      case "write":
        if (input.filePath) {
          return `${name} ${getRelativePath(input.filePath)}`
        }
        return name

      case "bash":
        if (input.description) {
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
        if (input.tool) {
          return getToolName(input.tool)
        }
        return name

      default:
        return name
    }
  }

  const hasResult = () => {
    const status = props.toolCall?.state?.status || ""
    return status === "completed" || status === "error"
  }

  const renderToolBody = () => {
    const toolName = props.toolCall?.tool || ""
    const state = props.toolCall?.state || {}
    const input = state.input || {}
    const metadata = state.metadata || {}

    if (toolName === "todoread") {
      return null
    }

    if (state.status === "pending") {
      return null
    }

    switch (toolName) {
      case "read":
        return renderReadTool()

      case "edit":
        return renderEditTool()

      case "write":
        return renderWriteTool()

      case "bash":
        return renderBashTool()

      case "webfetch":
        return renderWebfetchTool()

      case "todowrite":
        return renderTodowriteTool()

      case "task":
        return renderTaskTool()

      default:
        return renderDefaultTool()
    }
  }

  const renderReadTool = () => {
    const state = props.toolCall?.state || {}
    const metadata = state.metadata || {}
    const input = state.input || {}
    const preview = metadata.preview

    if (preview && input.filePath) {
      const lines = preview.split("\n")
      const truncated = lines.slice(0, 6).join("\n")
      const language = getLanguageFromPath(input.filePath)
      return <CodeBlockInline code={truncated} language={language} />
    }

    return null
  }

  const renderEditTool = () => {
    const state = props.toolCall?.state || {}
    const metadata = state.metadata || {}
    const diff = metadata.diff

    if (diff) {
      return (
        <div class="tool-call-diff">
          <CodeBlockInline code={diff} language="diff" />
        </div>
      )
    }

    return null
  }

  const renderWriteTool = () => {
    const state = props.toolCall?.state || {}
    const input = state.input || {}

    if (input.content && input.filePath) {
      const lines = input.content.split("\n")
      const truncated = lines.slice(0, 10).join("\n")
      const language = getLanguageFromPath(input.filePath)
      return <CodeBlockInline code={truncated} language={language} />
    }

    return null
  }

  const renderBashTool = () => {
    const state = props.toolCall?.state || {}
    const input = state.input || {}
    const metadata = state.metadata || {}
    const output = metadata.output

    if (input.command) {
      const fullOutput = `$ ${input.command}${output ? "\n" + output : ""}`

      if (output && hasMarkdownCodeBlocks(output)) {
        return (
          <div class="tool-call-bash">
            <div class="message-text">
              <Markdown content={fullOutput} isDark={isDark()} />
            </div>
          </div>
        )
      }

      return (
        <div class="tool-call-bash">
          <CodeBlockInline code={fullOutput} language="bash" />
        </div>
      )
    }

    return null
  }

  const renderWebfetchTool = () => {
    const state = props.toolCall?.state || {}
    const output = state.output

    if (output) {
      const lines = output.split("\n")
      const truncated = lines.slice(0, 10).join("\n")

      if (hasMarkdownCodeBlocks(truncated)) {
        return (
          <div class="message-text">
            <Markdown content={truncated} isDark={isDark()} />
          </div>
        )
      }

      return <CodeBlockInline code={truncated} language="markdown" />
    }

    return null
  }

  const renderTodowriteTool = () => {
    const state = props.toolCall?.state || {}
    const metadata = state.metadata || {}
    const todos = metadata.todos || []

    if (!Array.isArray(todos) || todos.length === 0) {
      return null
    }

    return (
      <div class="tool-call-todos">
        <For each={todos}>
          {(todo) => {
            const content = todo.content
            if (!content) return null

            return (
              <div class="tool-call-todo-item">
                {todo.status === "completed" && "- [x] "}
                {todo.status !== "completed" && "- [ ] "}
                {todo.status === "cancelled" && <s>{content}</s>}
                {todo.status === "in_progress" && <code>{content}</code>}
                {todo.status !== "cancelled" && todo.status !== "in_progress" && content}
              </div>
            )
          }}
        </For>
      </div>
    )
  }

  const renderTaskTool = () => {
    const state = props.toolCall?.state || {}
    const metadata = state.metadata || {}
    const summary = metadata.summary || []

    if (!Array.isArray(summary) || summary.length === 0) {
      return null
    }

    return (
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
    )
  }

  const renderDefaultTool = () => {
    const state = props.toolCall?.state || {}
    const output = state.output

    if (output) {
      const lines = output.split("\n")
      const truncated = lines.slice(0, 10).join("\n")

      if (hasMarkdownCodeBlocks(truncated)) {
        return (
          <div class="message-text">
            <Markdown content={truncated} isDark={isDark()} />
          </div>
        )
      }

      return <CodeBlockInline code={truncated} />
    }

    return null
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
