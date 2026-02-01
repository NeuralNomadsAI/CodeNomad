import { isRenderableDiffText } from "../../lib/diff-utils"
import { getLanguageFromPath } from "../../lib/markdown"
import type { ToolState } from "@opencode-ai/sdk"
import type { DiffPayload } from "./types"
import { getLogger } from "../../lib/logger"
const log = getLogger("session")


export type ToolStateRunning = import("@opencode-ai/sdk").ToolStateRunning
export type ToolStateCompleted = import("@opencode-ai/sdk").ToolStateCompleted
export type ToolStateError = import("@opencode-ai/sdk").ToolStateError

export const diffCapableTools = new Set(["edit", "patch"])

export function isToolStateRunning(state: ToolState): state is ToolStateRunning {
  return state.status === "running"
}

export function isToolStateCompleted(state: ToolState): state is ToolStateCompleted {
  return state.status === "completed"
}

export function isToolStateError(state: ToolState): state is ToolStateError {
  return state.status === "error"
}

export function getToolIcon(tool: string): string {
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
    case "question":
      return "❓"
    default:
      return "🔧"
  }
}

export function getToolName(tool: string): string {
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
    case "question":
      return "Question"
    default: {
      const normalized = tool.replace(/^opencode_/, "")
      return normalized.charAt(0).toUpperCase() + normalized.slice(1)
    }
  }
}

export function getRelativePath(path: string): string {
  if (!path) return ""
  const parts = path.split("/")
  return parts.slice(-1)[0] || path
}

export function ensureMarkdownContent(
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

export function formatUnknown(value: unknown): { text: string; language?: string } | null {
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
      log.error("Failed to stringify tool call output", error)
      return { text: String(value) }
    }
  }

  return null
}

export function inferLanguageFromPath(path?: string): string | undefined {
  return getLanguageFromPath(path || "")
}

export function extractDiffPayload(toolName: string, state?: ToolState): DiffPayload | null {
  if (!state) return null
  if (!diffCapableTools.has(toolName)) return null

  const { metadata, input, output } = readToolStatePayload(state)
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

  const filePath =
    (typeof input.filePath === "string" ? input.filePath : undefined) ||
    (typeof metadata.filePath === "string" ? metadata.filePath : undefined) ||
    (typeof input.path === "string" ? input.path : undefined)

  return { diffText, filePath }
}

export function readToolStatePayload(state?: ToolState): {
  input: Record<string, any>
  metadata: Record<string, any>
  output: unknown
} {
  if (!state) {
    return { input: {}, metadata: {}, output: undefined }
  }

  const supportsMetadata = isToolStateRunning(state) || isToolStateCompleted(state) || isToolStateError(state)
  return {
    input: supportsMetadata ? ((state.input || {}) as Record<string, any>) : {},
    metadata: supportsMetadata ? ((state.metadata || {}) as Record<string, any>) : {},
    output: isToolStateCompleted(state) ? state.output : undefined,
  }
}

export function getDefaultToolAction(toolName: string) {
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
    case "question":
      return "Asking..."
    default:
      return "Working..."
  }
}

/**
 * Get compact arguments string for inline tool display
 * Returns: "(src/App.tsx)" or "(npm run build)" or "(*.tsx)"
 */
export function getToolArgsSummary(toolName: string, state?: ToolState): string {
  if (!state) return ""

  const { input, metadata } = readToolStatePayload(state)

  // Extract the primary argument based on tool type
  let arg: string | undefined

  switch (toolName) {
    case "read":
    case "write":
    case "edit":
    case "patch":
      arg = input.file_path || input.filePath || metadata.filePath || input.path
      break
    case "bash":
      arg = input.command
      // Truncate long commands
      if (arg && arg.length > 50) {
        arg = arg.slice(0, 47) + "..."
      }
      break
    case "glob":
      arg = input.pattern
      break
    case "grep":
      arg = input.pattern
      break
    case "webfetch":
      arg = input.url
      // Extract domain from URL
      if (arg) {
        try {
          const url = new URL(arg)
          arg = url.hostname + (url.pathname !== "/" ? url.pathname : "")
          if (arg.length > 40) {
            arg = arg.slice(0, 37) + "..."
          }
        } catch {
          // Keep original if URL parsing fails
        }
      }
      break
    case "list":
      arg = input.path || input.directory
      break
    case "task":
      arg = input.description || metadata.description
      if (arg && arg.length > 40) {
        arg = arg.slice(0, 37) + "..."
      }
      break
    default:
      // Try common field names
      arg = input.file_path || input.filePath || input.path || input.pattern
  }

  if (!arg) return ""

  // For file paths, show just the filename
  if (arg.includes("/") && !arg.includes(" ")) {
    arg = getRelativePath(arg)
  }

  return `(${arg})`
}

/**
 * Calculate diff statistics from diff text
 */
export function calculateDiffStats(diffText: string): { added: number; removed: number } | null {
  if (!diffText) return null

  let added = 0
  let removed = 0

  const lines = diffText.split("\n")
  for (const line of lines) {
    // Skip diff headers
    if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff ")) {
      continue
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added++
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed++
    }
  }

  if (added === 0 && removed === 0) return null

  return { added, removed }
}

/**
 * Calculate tool execution duration from state timestamps
 */
export function calculateToolDuration(state?: ToolState): number | null {
  if (!state) return null

  const { metadata } = readToolStatePayload(state)

  // Check for explicit duration
  if (typeof metadata.duration === "number") {
    return metadata.duration
  }

  // Check for start/end timestamps
  if (metadata.startTime && metadata.endTime) {
    return metadata.endTime - metadata.startTime
  }

  // Check for time object
  if (state.time) {
    const time = state.time as { start?: number; end?: number }
    if (time.start && time.end) {
      return time.end - time.start
    }
  }

  return null
}

/**
 * Format duration in human-readable form
 */
export function formatDuration(ms: number | null): string {
  if (ms === null) return ""

  if (ms < 1000) {
    return `${ms}ms`
  }

  const seconds = ms / 1000
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`
  }

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.floor(seconds % 60)
  return `${minutes}m ${remainingSeconds}s`
}

/**
 * Get brief result summary for inline tool display
 * Returns: "+45, -12 lines" or "2.3s" or "89 lines" or "12 matches"
 */
export function getToolSummary(toolName: string, state?: ToolState): string {
  if (!state) return ""

  const status = state.status

  // Show status-based messages for non-completed states
  if (status === "running") {
    return "Running..."
  }

  if (status === "error") {
    const { metadata } = readToolStatePayload(state)
    const errorMsg = metadata.error || (state as ToolStateError).error || "Error"
    if (typeof errorMsg === "string" && errorMsg.length > 50) {
      return errorMsg.slice(0, 47) + "..."
    }
    return typeof errorMsg === "string" ? errorMsg : "Error"
  }

  if (status !== "completed") {
    return ""
  }

  const { input, metadata, output } = readToolStatePayload(state)

  switch (toolName) {
    case "edit":
    case "patch": {
      // Calculate diff stats
      const diffPayload = extractDiffPayload(toolName, state)
      if (diffPayload?.diffText) {
        const stats = calculateDiffStats(diffPayload.diffText)
        if (stats) {
          return `+${stats.added}, -${stats.removed} lines`
        }
      }
      return "Modified"
    }

    case "write": {
      // Count lines written
      const content = input.content || metadata.content || output
      if (typeof content === "string") {
        const lines = content.split("\n").length
        return `${lines} lines written`
      }
      return "Written"
    }

    case "read": {
      // Count lines read
      const preview = metadata.preview || output
      if (typeof preview === "string") {
        const lines = preview.split("\n").length
        return `${lines} lines`
      }
      return "Read"
    }

    case "bash": {
      // Show duration if available
      const duration = calculateToolDuration(state)
      if (duration !== null) {
        return formatDuration(duration)
      }
      // Check exit code
      const exitCode = metadata.exitCode
      if (typeof exitCode === "number") {
        return exitCode === 0 ? "Success" : `Exit code ${exitCode}`
      }
      return "Completed"
    }

    case "glob": {
      // Show match count
      if (Array.isArray(output)) {
        return `${output.length} files`
      }
      if (typeof output === "string") {
        const lines = output.trim().split("\n").filter(Boolean)
        return `${lines.length} files`
      }
      return "Found"
    }

    case "grep": {
      // Show match count
      if (Array.isArray(output)) {
        return `${output.length} matches`
      }
      if (typeof output === "string") {
        const lines = output.trim().split("\n").filter(Boolean)
        return `${lines.length} matches`
      }
      return "Searched"
    }

    case "webfetch": {
      return "Fetched"
    }

    case "task": {
      // Sub-agent status
      const summary = metadata.summary
      if (Array.isArray(summary)) {
        return `${summary.length} steps`
      }
      return "Delegated"
    }

    case "todowrite":
    case "todoread": {
      return "Updated"
    }

    case "list": {
      if (Array.isArray(output)) {
        return `${output.length} items`
      }
      return "Listed"
    }

    default:
      return "Completed"
  }
}
