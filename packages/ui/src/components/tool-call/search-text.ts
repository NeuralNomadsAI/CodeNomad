import type { ToolSearchTextContext } from "./types"
import {
  isToolStateCompleted,
  isToolStateError,
  isToolStateRunning,
  readToolStatePayload,
} from "./utils"
import { exceedsRetainedByteLimit } from "../../lib/session-memory-budget"
import { tGlobal } from "../../lib/i18n"

type QuestionOption = { label?: unknown; description?: unknown }
type QuestionPrompt = { header?: unknown; question?: unknown; options?: unknown; answer?: unknown }

function* strings(...values: unknown[]): Generator<string> {
  for (const value of values) if (typeof value === "string" && value.length > 0) yield value
}

function* objectSearchValues(record: Record<string, unknown>): Generator<unknown> {
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue
    yield key
    try {
      yield record[key]
    } catch {
      // Ignore hostile getters while retaining the rest of the payload.
    }
  }
}

async function* formatted(value: unknown, context: ToolSearchTextContext): AsyncGenerator<string> {
  let canRenderJson = false
  try {
    canRenderJson = value !== null && typeof value === "object" && !exceedsRetainedByteLimit(value, 10_000)
  } catch {
    // Fall through to guarded traversal.
  }
  if (canRenderJson) {
    try {
      const rendered = JSON.stringify(value, null, 2)
      if (rendered) {
        yield rendered
        return
      }
    } catch {
      // Cyclic values use guarded traversal.
    }
  }

  type Pending = { value: unknown } | { iterator: Iterator<unknown> }
  const pending: Pending[] = [{ value }]
  const seen = new WeakSet<object>()
  let units = 0
  while (pending.length > 0) {
    const item = pending.pop()!
    if ("iterator" in item) {
      let next: IteratorResult<unknown>
      try {
        next = item.iterator.next()
      } catch {
        continue
      }
      if (!next.done) pending.push(item, { value: next.value })
      continue
    }
    const current = item.value
    if (current === null) yield "null"
    else if (typeof current === "string") yield current
    else if (typeof current === "number" || typeof current === "boolean" || typeof current === "bigint") yield String(current)
    else if (current && typeof current === "object" && !seen.has(current)) {
      seen.add(current)
      pending.push({ iterator: Array.isArray(current) ? current.values() : objectSearchValues(current as Record<string, unknown>) })
    }
    units += 1
    if (units % 64 === 0) await context.checkpoint?.()
  }
}

function* base(context: ToolSearchTextContext): Generator<string> {
  const { metadata } = readToolStatePayload(context.toolState)
  yield* strings(
    context.toolName,
    metadata.title,
    metadata.description,
    context.toolState && "title" in context.toolState ? (context.toolState as any).title : undefined,
  )
}

function* errors(context: ToolSearchTextContext): Generator<string> {
  yield* strings(
    context.toolState && "message" in context.toolState ? (context.toolState as any).message : undefined,
    context.toolState && "error" in context.toolState ? (context.toolState as any).error : undefined,
  )
}

export async function* getDefaultToolSearchText(context: ToolSearchTextContext): AsyncGenerator<string> {
  const state = context.toolState
  const { input, metadata, output } = readToolStatePayload(state)
  yield* base(context)
  yield* strings(
    typeof input.command === "string" ? `$ ${input.command}` : undefined,
    input.description,
    input.pattern,
    input.filePath,
    input.path,
  )
  yield* formatted(
    state && isToolStateCompleted(state)
      ? output
      : state && (isToolStateRunning(state) || isToolStateError(state))
        ? metadata.output || (metadata.diff ?? metadata.preview ?? input.content)
        : metadata.diff ?? metadata.preview ?? input.content,
    context,
  )
  yield* errors(context)
}

export async function* getBashToolSearchText(context: ToolSearchTextContext): AsyncGenerator<string> {
  const state = context.toolState
  const { input, metadata, output } = readToolStatePayload(state)
  yield* base(context)
  yield* strings(
    typeof input.command === "string" && input.command.length > 0 ? `$ ${input.command}` : undefined,
    input.description,
    typeof input.timeout === "number" ? String(input.timeout) : undefined,
  )
  yield* formatted(
    state && isToolStateCompleted(state)
      ? output
      : state && (isToolStateRunning(state) || isToolStateError(state)) ? metadata.output : undefined,
    context,
  )
  yield* errors(context)
}

export async function* getReadToolSearchText(context: ToolSearchTextContext): AsyncGenerator<string> {
  const { input, metadata } = readToolStatePayload(context.toolState)
  yield* base(context)
  yield* strings(input.filePath, input.path, input.name, metadata.preview)
  if (typeof input.offset === "number") yield tGlobal("toolCall.renderer.read.detail.offset", { offset: input.offset })
  if (typeof input.limit === "number") yield tGlobal("toolCall.renderer.read.detail.limit", { limit: input.limit })
  yield* errors(context)
}

export async function* getWriteToolSearchText(context: ToolSearchTextContext): AsyncGenerator<string> {
  const { input, metadata } = readToolStatePayload(context.toolState)
  yield* base(context)
  yield* strings(input.filePath, typeof input.content === "string" ? input.content : metadata.content)
  yield* errors(context)
}

export async function* getDiffToolSearchText(context: ToolSearchTextContext): AsyncGenerator<string> {
  const { input, metadata, output } = readToolStatePayload(context.toolState)
  yield* base(context)
  yield* strings(input.filePath, input.path, metadata.diff)
  yield* formatted(output, context)
  yield* formatted(metadata.output, context)
  yield* errors(context)
}

export async function* getApplyPatchToolSearchText(context: ToolSearchTextContext): AsyncGenerator<string> {
  yield* getDiffToolSearchText(context)
  const { metadata, output } = readToolStatePayload(context.toolState)
  const files = Array.isArray((metadata as any).files) ? ((metadata as any).files as any[]) : []
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]
    yield* strings(file?.filePath, file?.relativePath, file?.diff, file?.patch)
    if (index % 64 === 63) await context.checkpoint?.()
  }
  yield* formatted((metadata as any).diagnostics, context)
  yield* formatted(output, context)
}

export async function* getWebfetchToolSearchText(context: ToolSearchTextContext): AsyncGenerator<string> {
  const state = context.toolState
  const { input, metadata, output } = readToolStatePayload(state)
  yield* base(context)
  yield* strings(input.url)
  yield* formatted(state && isToolStateCompleted(state) ? output : metadata.output, context)
  yield* errors(context)
}

export async function* getTaskToolSearchText(context: ToolSearchTextContext): AsyncGenerator<string> {
  const { input, metadata, output } = readToolStatePayload(context.toolState)
  yield* base(context)
  yield* errors(context)
  yield* formatted(output, context)
  yield* formatted(metadata.summary, context)
  yield* strings(input.description, input.subagent_type, input.prompt)
}

export async function* getTodoToolSearchText(context: ToolSearchTextContext): AsyncGenerator<string> {
  const { metadata } = readToolStatePayload(context.toolState)
  const todos = Array.isArray((metadata as any).todos) ? ((metadata as any).todos as any[]) : []
  yield* base(context)
  for (let index = 0; index < todos.length; index += 1) {
    yield* strings(todos[index]?.content, todos[index]?.status)
    if (index % 64 === 63) await context.checkpoint?.()
  }
  yield* errors(context)
}

export async function* getQuestionToolSearchText(context: ToolSearchTextContext): AsyncGenerator<string> {
  const { input, metadata } = readToolStatePayload(context.toolState)
  const questions = Array.isArray(input.questions) ? (input.questions as QuestionPrompt[]) : []
  const answers = Array.isArray((metadata as any).answers) ? ((metadata as any).answers as unknown[]) : []
  yield* base(context)
  for (const question of questions) {
    yield* strings(question.header, question.question)
    const options = Array.isArray(question.options) ? (question.options as QuestionOption[]) : []
    for (let index = 0; index < options.length; index += 1) {
      yield* strings(options[index].label, options[index].description)
      if (index % 64 === 63) await context.checkpoint?.()
    }
    yield* formatted(question.answer, context)
    await context.checkpoint?.()
  }
  yield* formatted(answers, context)
  yield* errors(context)
}
