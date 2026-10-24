import { isRenderableDiffText } from "../../lib/diff-utils"
import { getLanguageFromPath } from "../../lib/text-render-utils"
import type { ToolState, ToolStateCompleted, ToolStateError, ToolStateRunning } from "../../types/tool-state"
import type { DiffPayload } from "./types"
import { getLogger } from "../../lib/logger"
import { tGlobal } from "../../lib/i18n"
import { exceedsRetainedByteLimit } from "../../lib/retained-size"
import { TOOL_OUTPUT_RENDER_CHARACTER_LIMIT } from "../../lib/render-text-window"
import { getCanonicalToolName } from "./tool-presentation"
const log = getLogger("session")


export type { ToolStateCompleted, ToolStateError, ToolStateRunning }
export { TOOL_OUTPUT_RENDER_CHARACTER_LIMIT }

export const diffCapableTools = new Set(["edit", "patch"])
export const TOOL_TITLE_RENDER_CHARACTER_LIMIT = 384
/** Speech reads at most this much of a tool call; rendering bounds are separate (see render-text-window). */
export const TOOL_SPEECH_CHARACTER_LIMIT = 10_000

export function hasVisibleText(value: string | null | undefined): value is string {
  return typeof value === "string" && /\S/.test(value)
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
  const parts = path.split(/[\\/]/)
  return parts.slice(-1)[0] || path
}

// Strips the tool label prefix from a renderer title so the header can show the
// raw tool name once. Both the raw name ("subagent") and its registry tool
// ("task") are accepted as prefixes because renderers are shared across aliases.
export function getToolTitleDetail(rawTitle: string, toolName: string): string {
  const title = rawTitle.trim()
  if (!title) return ""
  const canonical = getCanonicalToolName(toolName)
  const labels = [toolName.trim(), getToolName(toolName).trim(), canonical, getToolName(canonical).trim()].filter(Boolean)
  for (const label of new Set(labels)) {
    if (title === label) return ""
    if (title.startsWith(`${label} `)) return title.slice(label.length).trimStart()
    if (title.startsWith(`${label}[`)) return title.slice(label.length).trimStart()
    if (title.startsWith(`${label} · `)) return title.slice(label.length + 3).trimStart()
  }
  return title
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

/** Text to render for a tool value; rendering bounds it. Oversized structured values are not serialized. */
export function formatUnknownForRender(value: unknown): { text: string; language?: string } | null {
  if (typeof value !== "string" && exceedsRetainedByteLimit(value, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)) {
    return { text: tGlobal("toolCall.output.tooLarge") }
  }
  return formatUnknown(value)
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
  return formatToolInputForCopy(input)
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
  const fileDiff = readSingleFileDiff(metadata)
  const candidates = [metadata.diff, fileDiff?.patch, output, metadata.output]
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
    (typeof input.path === "string" ? input.path : undefined) ||
    fileDiff?.file

  return { diffText, filePath }
}

// OpenCode 2.x edit/patch tool metadata: `metadata.files` is a list of FileDiff
// entries `{ file, patch, additions, deletions, status }` rather than a
// `metadata.diff` string. The single-file diff viewer can only present one
// entry, so a multi-file patch is left to the renderer's own fallback instead
// of being cut down to its first file.
export function readSingleFileDiff(metadata: Record<string, any>): { file?: string; patch?: string } | null {
  const files = metadata.files
  if (!Array.isArray(files) || files.length !== 1) return null
  const only = files[0]
  if (!only || typeof only !== "object") return null
  return {
    file: typeof only.file === "string" ? only.file : undefined,
    patch: typeof only.patch === "string" ? only.patch : undefined,
  }
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
  // Computed for every mounted tool call: bound each section by the remaining budget
  // before joining, so a large output is never copied whole and the result (a fresh
  // join) never retains a large parent string.
  const sections: string[] = []
  let remaining = TOOL_SPEECH_CHARACTER_LIMIT
  const add = (label: string, text: string | undefined) => {
    if (!text || remaining <= label.length) return
    const body = text.trimStart().slice(0, remaining - label.length).trimEnd()
    if (!body) return
    sections.push(label + body)
    remaining -= label.length + body.length + 2
  }

  add("", options.title)
  const { input, output } = readToolStatePayload(options.state)
  add(`${options.t("toolCall.io.input")}:\n`, formatUnknownForRender(input)?.text)
  add(`${options.t("toolCall.io.output")}:\n`, formatUnknownForRender(output)?.text)
  if (options.state?.status === "error") add(`${options.t("toolCall.error.label")} `, options.state.error)

  if (sections.length === 1 && options.state?.status === "pending") {
    sections.push(options.t("toolCall.pending.waitingToRun"))
  }

  return sections.join("\n\n")
}
