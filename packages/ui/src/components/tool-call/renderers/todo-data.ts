import type { ToolState } from "../../../types/tool-state"
import { readToolStatePayload, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT } from "../utils"

export type TodoViewStatus = "pending" | "in_progress" | "completed" | "cancelled"

export interface TodoViewItem {
  id: string
  content: string
  status: TodoViewStatus
}

type TodoViewItems = TodoViewItem[] & { partial?: boolean }
export const TODO_ITEM_RENDER_LIMIT = 200

function normalizeTodoStatus(rawStatus: unknown): TodoViewStatus {
  if (rawStatus === "completed" || rawStatus === "in_progress" || rawStatus === "cancelled") return rawStatus
  return "pending"
}

export function extractTodosFromState(state?: ToolState): TodoViewItems {
  if (!state) return []
  const { metadata } = readToolStatePayload(state)
  const todos: any[] = Array.isArray((metadata as any).todos) ? (metadata as any).todos : []
  const normalized: TodoViewItems = []
  let characters = 0
  let scannedCharacters = 0
  let index = 0
  for (; index < todos.length && index < 10_000 && normalized.length < TODO_ITEM_RENDER_LIMIT && scannedCharacters < TOOL_OUTPUT_RENDER_CHARACTER_LIMIT; index += 1) {
    const todo = todos[index]
    const rawContent = typeof todo?.content === "string" ? todo.content : ""
    const contentPrefix = rawContent.slice(0, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT - scannedCharacters)
    scannedCharacters += contentPrefix.length
    const contentStart = contentPrefix.search(/\S/)
    if (contentStart < 0) {
      if (contentPrefix.length < rawContent.length) break
      continue
    }
    const remaining = TOOL_OUTPUT_RENDER_CHARACTER_LIMIT - characters
    const contentSlice = contentPrefix.slice(contentStart, contentStart + remaining)
    const content = contentSlice.trimEnd()
    if (!content) continue
    const status = normalizeTodoStatus(todo.status)
    const id = typeof todo?.id === "string" && todo.id.length > 0 ? todo.id : String(index)
    normalized.push({ id, content, status })
    characters += content.length
    if (contentStart + contentSlice.length < rawContent.length) break
  }
  if (index < todos.length) normalized.partial = true
  return normalized
}

export function getRenderedTodos(todos: TodoViewItem[]) {
  const items: TodoViewItem[] = []
  let characters = 0
  for (let index = 0; index < todos.length && index < TODO_ITEM_RENDER_LIMIT; index += 1) {
    if (characters >= TOOL_OUTPUT_RENDER_CHARACTER_LIMIT) break
    const todo = todos[index]
    const content = todo.content.slice(0, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT - characters)
    items.push({ ...todo, content })
    characters += content.length
  }
  return { items, truncated: Boolean((todos as TodoViewItems).partial) || items.length < todos.length }
}

export function hasTodoCopyText(state?: ToolState): boolean {
  if (!state) return false
  const { metadata } = readToolStatePayload(state)
  return Array.isArray((metadata as any).todos) && (metadata as any).todos.length > 0
}

export function getTodoCopyText(state?: ToolState): string {
  if (!state) return "[]"
  const { metadata } = readToolStatePayload(state)
  return JSON.stringify(Array.isArray((metadata as any).todos) ? (metadata as any).todos : [], null, 2)
}

export function getTodoTitleKind(state?: ToolState): "plan" | "creating" | "completing" | "updating" {
  if (state?.status !== "completed") return "plan"
  const { metadata } = readToolStatePayload(state)
  const todos: any[] = Array.isArray((metadata as any).todos) ? (metadata as any).todos : []
  if (todos.length === 0) return "plan"
  let allPending = true
  let allCompleted = true
  for (let index = 0; index < todos.length && index < 10_000; index += 1) {
    const status = normalizeTodoStatus(todos[index]?.status)
    allPending = allPending && status === "pending"
    allCompleted = allCompleted && status === "completed"
    if (!allPending && !allCompleted) return "updating"
  }
  if (todos.length > 10_000) return "updating"
  if (allPending) return "creating"
  if (allCompleted) return "completing"
  return "updating"
}
