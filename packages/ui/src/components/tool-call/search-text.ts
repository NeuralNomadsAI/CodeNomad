import type { ToolSearchTextContext } from "./types"
import {
  formatUnknown,
  isToolStateCompleted,
  isToolStateError,
  isToolStateRunning,
  readToolStatePayload,
} from "./utils"
import { exceedsRetainedByteLimit } from "../../lib/retained-size"
import { getApplyPatchCopyText } from "./renderers/apply-patch-data"

type QuestionOption = { label?: unknown; description?: unknown }
type QuestionPrompt = { header?: unknown; question?: unknown; options?: unknown; multiple?: unknown; answer?: unknown }
const SEARCH_FORMAT_BYTE_LIMIT = 2_000_000

function appendString(values: string[], value: unknown) {
  if (typeof value === "string" && value.trim().length > 0) values.push(value)
}

function appendFormatted(values: string[], value: unknown) {
  if (typeof value !== "string" && exceedsRetainedByteLimit(value, SEARCH_FORMAT_BYTE_LIMIT)) return
  const result = formatUnknown(value)
  if (result?.text.trim()) values.push(result.text)
}

function appendBaseToolText(values: string[], context: ToolSearchTextContext) {
  const { metadata } = readToolStatePayload(context.toolState)
  appendString(values, context.toolName)
  appendString(values, metadata.title)
  appendString(values, metadata.description)
  appendString(values, context.toolState && "title" in context.toolState ? (context.toolState as any).title : undefined)
}

function appendToolErrorText(values: string[], context: ToolSearchTextContext) {
  appendString(values, context.toolState && "message" in context.toolState ? (context.toolState as any).message : undefined)
  appendString(values, context.toolState && "error" in context.toolState ? (context.toolState as any).error : undefined)
}

export function getDefaultToolSearchText(context: ToolSearchTextContext): string[] {
  const values: string[] = []
  const state = context.toolState
  const { input, metadata, output } = readToolStatePayload(state)
  appendBaseToolText(values, context)

  const primaryOutput = state && isToolStateCompleted(state)
    ? output
    : state && (isToolStateRunning(state) || isToolStateError(state)) && metadata.output
      ? metadata.output
      : metadata.diff ?? metadata.preview ?? input.content

  appendString(values, typeof input.command === "string" ? `$ ${input.command}` : undefined)
  appendString(values, input.filePath)
  appendString(values, input.path)
  appendFormatted(values, primaryOutput)
  appendToolErrorText(values, context)
  return values
}

export function getBashToolSearchText(context: ToolSearchTextContext): string[] {
  const values: string[] = []
  const state = context.toolState
  const { input, metadata, output } = readToolStatePayload(state)
  appendBaseToolText(values, context)
  appendString(values, typeof input.command === "string" && input.command.length > 0 ? `$ ${input.command}` : undefined)
  appendFormatted(
    values,
    state && isToolStateCompleted(state)
      ? output
      : state && (isToolStateRunning(state) || isToolStateError(state))
        ? metadata.output
        : undefined,
  )
  appendToolErrorText(values, context)
  return values
}

export function getReadToolSearchText(context: ToolSearchTextContext): string[] {
  const values: string[] = []
  const { input, metadata } = readToolStatePayload(context.toolState)
  appendBaseToolText(values, context)
  appendString(values, input.filePath)
  appendString(values, input.path)
  appendString(values, input.name)
  appendString(values, metadata.preview)
  appendToolErrorText(values, context)
  return values
}

export function getWriteToolSearchText(context: ToolSearchTextContext): string[] {
  const values: string[] = []
  const { input, metadata } = readToolStatePayload(context.toolState)
  appendBaseToolText(values, context)
  appendString(values, input.filePath)
  appendString(values, typeof input.content === "string" ? input.content : metadata.content)
  appendToolErrorText(values, context)
  return values
}

export function getDiffToolSearchText(context: ToolSearchTextContext): string[] {
  const values: string[] = []
  const { input, metadata, output } = readToolStatePayload(context.toolState)
  appendBaseToolText(values, context)
  appendString(values, input.filePath)
  appendString(values, input.path)
  appendString(values, metadata.diff)
  appendFormatted(values, output)
  appendFormatted(values, metadata.output)
  appendToolErrorText(values, context)
  return values
}

export function getApplyPatchToolSearchText(context: ToolSearchTextContext): string[] {
  const values = getDiffToolSearchText(context)
  const { metadata, output } = readToolStatePayload(context.toolState)
  const files = Array.isArray((metadata as any).files) ? ((metadata as any).files as any[]).slice(0, 10_000) : []

  for (const file of files.slice(0, 200)) {
    appendString(values, file?.filePath)
    appendString(values, file?.relativePath)
  }
  appendString(values, getApplyPatchCopyText(files, SEARCH_FORMAT_BYTE_LIMIT))

  appendFormatted(values, (metadata as any).diagnostics)
  appendFormatted(values, output)
  return values
}

export function getWebfetchToolSearchText(context: ToolSearchTextContext): string[] {
  const values: string[] = []
  const state = context.toolState
  const { input, metadata, output } = readToolStatePayload(state)
  appendBaseToolText(values, context)
  appendString(values, input.url)
  appendFormatted(values, state && isToolStateCompleted(state) ? output : metadata.output)
  appendToolErrorText(values, context)
  return values
}

export function getTaskToolSearchText(context: ToolSearchTextContext): string[] {
  const values: string[] = []
  const { input, metadata, output } = readToolStatePayload(context.toolState)
  appendBaseToolText(values, context)
  appendString(values, input.prompt)
  appendString(values, input.subagent_type)
  appendFormatted(values, output)
  appendFormatted(values, metadata.summary)
  appendToolErrorText(values, context)
  return values
}

export function getTodoToolSearchText(context: ToolSearchTextContext): string[] {
  const values: string[] = []
  const { metadata } = readToolStatePayload(context.toolState)
  const todos = Array.isArray((metadata as any).todos) ? ((metadata as any).todos as any[]).slice(0, 10_000) : []
  appendBaseToolText(values, context)

  for (const todo of todos) {
    appendString(values, todo?.content)
    appendString(values, todo?.status)
  }

  appendToolErrorText(values, context)
  return values
}

export function getQuestionToolSearchText(context: ToolSearchTextContext): string[] {
  const values: string[] = []
  const { input, metadata } = readToolStatePayload(context.toolState)
  const questions = Array.isArray(input.questions) ? (input.questions as QuestionPrompt[]).slice(0, 10_000) : []
  const answers = Array.isArray((metadata as any).answers) ? ((metadata as any).answers as unknown[]).slice(0, 10_000) : []
  appendBaseToolText(values, context)

  for (const question of questions) {
    appendString(values, question.header)
    appendString(values, question.question)
    const options = Array.isArray(question.options) ? (question.options as QuestionOption[]).slice(0, 10_000) : []
    for (const option of options) {
      appendString(values, option.label)
      appendString(values, option.description)
    }
    appendFormatted(values, question.answer)
  }

  appendFormatted(values, answers)
  appendToolErrorText(values, context)
  return values
}

export function getToolSearchText(context: ToolSearchTextContext): string[] {
  switch (context.toolName) {
    case "bash": return getBashToolSearchText(context)
    case "read": return getReadToolSearchText(context)
    case "write": return getWriteToolSearchText(context)
    case "edit":
    case "patch": return getDiffToolSearchText(context)
    case "apply_patch": return getApplyPatchToolSearchText(context)
    case "webfetch": return getWebfetchToolSearchText(context)
    case "task": return getTaskToolSearchText(context)
    case "todowrite": return getTodoToolSearchText(context)
    case "question": return getQuestionToolSearchText(context)
    default: return getDefaultToolSearchText(context)
  }
}
