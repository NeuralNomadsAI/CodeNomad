import { isRenderableDiffText } from "../../lib/diff-utils"
import { getLanguageFromPath } from "../../lib/text-render-utils"
import type { ToolState, ToolStateCompleted, ToolStateError, ToolStateRunning } from "../../types/tool-state"
import type { DiffPayload } from "./types"
import { getLogger } from "../../lib/logger"
import { tGlobal } from "../../lib/i18n"
import { exceedsRetainedByteLimit } from "../../lib/retained-size"
const log = getLogger("session")


export type { ToolStateCompleted, ToolStateError, ToolStateRunning }

export const diffCapableTools = new Set(["edit", "patch"])
export const TOOL_OUTPUT_RENDER_CHARACTER_LIMIT = 10_000
export const TOOL_TITLE_RENDER_CHARACTER_LIMIT = 384
export const MESSAGE_PART_RENDER_LIMIT = 200

export function getItemsForRender<T>(items: readonly T[], limit: number) {
  return { parts: items.slice(0, limit), truncated: items.length > limit }
}

export function limitToolOutputForRender(text: string): string {
  if (text.length <= TOOL_OUTPUT_RENDER_CHARACTER_LIMIT) return text
  const suffix = `\n\n${tGlobal("toolCall.output.truncated")}`
  return `${text.slice(0, Math.max(0, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT - suffix.length))}${suffix}`
}

export function shouldRenderDiffAsPlainText(text: string): boolean {
  return text.length > TOOL_OUTPUT_RENDER_CHARACTER_LIMIT
}

export function shouldRenderDiffPayloadAsPlainText(payload: DiffPayload): boolean {
  return shouldRenderDiffAsPlainText(payload.diffText)
    || (payload.copyText?.length ?? 0) > TOOL_OUTPUT_RENDER_CHARACTER_LIMIT
}

export function limitToolTitleForRender(text: string): string {
  if (text.length <= TOOL_TITLE_RENDER_CHARACTER_LIMIT) return text
  return `${text.slice(0, TOOL_TITLE_RENDER_CHARACTER_LIMIT - 3)}...`
}

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
      return "📋"
    case "question":
      return "❓"
    case "list":
      return "📁"
    case "patch":
      return "🔧"
    case "apply_patch":
      return "🔧"
    default:
      return "🔧"
  }
}

export function getToolName(tool: string): string {
  switch (tool) {
    case "bash":
      return tGlobal("toolCall.renderer.toolName.shell")
    case "webfetch":
      return tGlobal("toolCall.renderer.toolName.fetch")
    case "invalid":
      return tGlobal("toolCall.renderer.toolName.invalid")
    case "todowrite":
      return tGlobal("toolCall.renderer.toolName.plan")
    case "apply_patch":
      return tGlobal("toolCall.renderer.toolName.applyPatch")
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

export function formatUnknownForRender(value: unknown): { text: string; language?: string } | null {
  if (typeof value !== "string" && exceedsRetainedByteLimit(value, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)) {
    return { text: tGlobal("toolCall.output.tooLarge") }
  }
  const result = formatUnknown(value)
  return result ? { ...result, text: limitToolOutputForRender(result.text) } : null
}

export function formatToolInputForCopy(input: unknown): { text: string; language?: string } | null {
  try {
    const text = JSON.stringify(input, null, 2)
    return typeof text === "string" ? { text, language: "json" } : null
  } catch (error) {
    log.error("Failed to stringify tool call input", error)
    return null
  }
}

export function formatToolInputForRender(input: unknown): { text: string; language?: string } | null {
  if (typeof input !== "string" && exceedsRetainedByteLimit(input, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)) {
    return { text: JSON.stringify(tGlobal("toolCall.output.tooLarge")), language: "json" }
  }
  const formatted = formatToolInputForCopy(input)
  return formatted ? { ...formatted, text: limitToolOutputForRender(formatted.text) } : null
}

export function formatUnknownForCopy(value: unknown): { text: string; language?: string } | null {
  try {
    return formatUnknown(value)
  } catch (error) {
    log.error("Failed to format tool call output for copy", error)
    return { text: tGlobal("toolCall.output.tooLarge") }
  }
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
    if (typeof candidate !== "string") continue
    const renderable = candidate.length > TOOL_OUTPUT_RENDER_CHARACTER_LIMIT
      ? /(^|\n)@@/.test(candidate.slice(0, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT))
      : isRenderableDiffText(candidate)
    if (renderable) {
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
      return tGlobal("toolCall.task.action.delegating")
    case "bash":
      return tGlobal("toolCall.renderer.action.writingCommand")
    case "edit":
      return tGlobal("toolCall.renderer.action.preparingEdit")
    case "webfetch":
      return tGlobal("toolCall.renderer.action.fetchingFromWeb")
    case "glob":
      return tGlobal("toolCall.renderer.action.findingFiles")
    case "grep":
      return tGlobal("toolCall.renderer.action.searchingContent")
    case "list":
      return tGlobal("toolCall.renderer.action.listingDirectory")
    case "read":
      return tGlobal("toolCall.renderer.action.readingFile")
    case "write":
      return tGlobal("toolCall.renderer.action.preparingWrite")
    case "todowrite":
      return tGlobal("toolCall.renderer.action.planning")
    case "patch":
      return tGlobal("toolCall.renderer.action.preparingPatch")
    case "apply_patch":
      return tGlobal("toolCall.applyPatch.action.preparing")
    default:
      return tGlobal("toolCall.renderer.action.working")
  }
}

export function buildToolSpeechText(options: {
  title: string
  state?: ToolState
  t: (key: string, params?: Record<string, unknown>) => string
}): string {
  const sections: string[] = []

  const title = limitToolOutputForRender(options.title).trim()
  if (title) {
    sections.push(title)
  }

  const { input, output } = readToolStatePayload(options.state)
  const formattedInput = formatUnknownForRender(input)
  const formattedOutput = formatUnknownForRender(output)

  if (formattedInput?.text?.trim()) {
    sections.push(`${options.t("toolCall.io.input")}:\n${formattedInput.text.trim()}`)
  }

  if (formattedOutput?.text?.trim()) {
    sections.push(`${options.t("toolCall.io.output")}:\n${formattedOutput.text.trim()}`)
  }

  const error = options.state?.status === "error" ? limitToolOutputForRender(options.state.error ?? "").trim() : ""
  if (error) {
    sections.push(`${options.t("toolCall.error.label")} ${error}`)
  }

  if (sections.length === 1 && options.state?.status === "pending") {
    sections.push(options.t("toolCall.pending.waitingToRun"))
  }

  return limitToolOutputForRender(sections.join("\n\n").trim())
}
