import type { ToolSearchTextContext } from "./types"
import {
  formatUnknown,
  isToolStateCompleted,
  isToolStateError,
  isToolStateRunning,
  limitToolOutputForRender,
  readToolStatePayload,
} from "./utils"
import { exceedsRetainedByteLimit } from "../../lib/session-memory-budget"

type QuestionOption = { label?: unknown; description?: unknown }
type QuestionPrompt = { header?: unknown; question?: unknown; options?: unknown; multiple?: unknown; answer?: unknown }
const TOOL_SEARCH_CHARACTER_LIMIT = 10_000
const searchSizes = new WeakMap<string[], number>()

function appendString(values: string[], value: unknown) {
  if (typeof value !== "string") return
  const used = searchSizes.get(values) ?? 0
  const remaining = TOOL_SEARCH_CHARACTER_LIMIT - used
  if (remaining <= 0) return
  const text = limitToolOutputForRender(value).slice(0, remaining)
  searchSizes.set(values, used + text.length)
  if (text.trim().length === 0) return
  values.push(text)
}

function appendFormatted(values: string[], value: unknown) {
  if ((searchSizes.get(values) ?? 0) >= TOOL_SEARCH_CHARACTER_LIMIT) return
  if (typeof value === "string") {
    appendString(values, value)
    return
  }
  if (exceedsRetainedByteLimit(value, 10_000)) return
  const result = formatUnknown(value)
  if (result?.text.trim()) appendString(values, result.text)
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
  const files = Array.isArray((metadata as any).files) ? ((metadata as any).files as any[]) : []

  for (let index = 0; index < files.length && index < 1_000; index += 1) {
    if ((searchSizes.get(values) ?? 0) >= TOOL_SEARCH_CHARACTER_LIMIT) break
    const file = files[index]
    appendString(values, file?.filePath)
    appendString(values, file?.relativePath)
    appendString(values, file?.diff)
    appendString(values, file?.patch)
  }

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
  appendToolErrorText(values, context)
  appendFormatted(values, output)
  appendFormatted(values, metadata.summary)
  appendString(values, input.subagent_type)
  appendString(values, input.prompt)
  return values
}

export function getTodoToolSearchText(context: ToolSearchTextContext): string[] {
  const values: string[] = []
  const { metadata } = readToolStatePayload(context.toolState)
  const todos = Array.isArray((metadata as any).todos) ? ((metadata as any).todos as any[]) : []
  appendBaseToolText(values, context)

  for (let index = 0; index < todos.length && index < 1_000; index += 1) {
    if ((searchSizes.get(values) ?? 0) >= TOOL_SEARCH_CHARACTER_LIMIT) break
    const todo = todos[index]
    appendString(values, todo?.content)
    appendString(values, todo?.status)
  }

  appendToolErrorText(values, context)
  return values
}

export function getQuestionToolSearchText(context: ToolSearchTextContext): string[] {
  const values: string[] = []
  const { input, metadata } = readToolStatePayload(context.toolState)
  const questions = Array.isArray(input.questions) ? (input.questions as QuestionPrompt[]) : []
  const answers = Array.isArray((metadata as any).answers) ? ((metadata as any).answers as unknown[]) : []
  appendBaseToolText(values, context)

  for (let questionIndex = 0; questionIndex < questions.length && questionIndex < 100; questionIndex += 1) {
    if ((searchSizes.get(values) ?? 0) >= TOOL_SEARCH_CHARACTER_LIMIT) break
    const question = questions[questionIndex]
    appendString(values, question.header)
    appendString(values, question.question)
    const options = Array.isArray(question.options) ? (question.options as QuestionOption[]) : []
    for (let optionIndex = 0; optionIndex < options.length && optionIndex < 100; optionIndex += 1) {
      if ((searchSizes.get(values) ?? 0) >= TOOL_SEARCH_CHARACTER_LIMIT) break
      const option = options[optionIndex]
      appendString(values, option.label)
      appendString(values, option.description)
    }
    appendFormatted(values, question.answer)
  }

  appendFormatted(values, answers)
  appendToolErrorText(values, context)
  return values
}
