import { isRenderableDiffText } from "../../lib/diff-utils"
import { getLanguageFromPath } from "../../lib/text-render-utils"
import type { ToolState } from "@opencode-ai/sdk/v2"
import type { DiffPayload } from "./types"
import { getLogger } from "../../lib/logger"
import { tGlobal } from "../../lib/i18n"
const log = getLogger("session")


export type ToolStateRunning = import("@opencode-ai/sdk/v2").ToolStateRunning
export type ToolStateCompleted = import("@opencode-ai/sdk/v2").ToolStateCompleted
export type ToolStateError = import("@opencode-ai/sdk/v2").ToolStateError

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
    case "todoread":
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
    case "todoread":
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

  if (options.title.trim()) {
    sections.push(options.title.trim())
  }

  const { input, output } = readToolStatePayload(options.state)
  const formattedInput = formatUnknown(input)
  const formattedOutput = formatUnknown(output)

  if (formattedInput?.text?.trim()) {
    sections.push(`${options.t("toolCall.io.input")}:\n${formattedInput.text.trim()}`)
  }

  if (formattedOutput?.text?.trim()) {
    sections.push(`${options.t("toolCall.io.output")}:\n${formattedOutput.text.trim()}`)
  }

  if (options.state?.status === "error" && options.state.error?.trim()) {
    sections.push(`${options.t("toolCall.error.label")} ${options.state.error.trim()}`)
  }

  if (sections.length === 1 && options.state?.status === "pending") {
    sections.push(options.t("toolCall.pending.waitingToRun"))
  }

  return sections.join("\n\n").trim()
}
