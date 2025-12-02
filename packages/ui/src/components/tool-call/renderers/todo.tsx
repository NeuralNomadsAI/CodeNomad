import { For } from "solid-js"
import type { ToolState } from "@opencode-ai/sdk"
import type { ToolRenderer } from "../types"
import { readToolStatePayload } from "../utils"

export type TodoViewStatus = "pending" | "in_progress" | "completed" | "cancelled"

interface TodoViewItem {
  id: string
  content: string
  status: TodoViewStatus
}

function normalizeTodoStatus(rawStatus: unknown): TodoViewStatus {
  if (rawStatus === "completed" || rawStatus === "in_progress" || rawStatus === "cancelled") return rawStatus
  return "pending"
}

function extractTodosFromState(state?: ToolState): TodoViewItem[] {
  if (!state) return []
  const { metadata } = readToolStatePayload(state)
  const todos = Array.isArray((metadata as any).todos) ? (metadata as any).todos : []
  const items: TodoViewItem[] = []

  for (let index = 0; index < todos.length; index++) {
    const todo = todos[index]
    const content = typeof todo?.content === "string" ? todo.content.trim() : ""
    if (!content) continue
    const status = normalizeTodoStatus((todo as any).status)
    const id = typeof todo?.id === "string" && todo.id.length > 0 ? todo.id : `${index}-${content}`
    items.push({ id, content, status })
  }

  return items
}

function summarizeTodos(todos: TodoViewItem[]) {
  return todos.reduce(
    (acc, todo) => {
      acc.total += 1
      acc[todo.status] = (acc[todo.status] || 0) + 1
      return acc
    },
    { total: 0, pending: 0, in_progress: 0, completed: 0, cancelled: 0 } as Record<TodoViewStatus | "total", number>,
  )
}

function getTodoStatusLabel(status: TodoViewStatus): string {
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

function getTodoTitle(state?: ToolState): string {
  if (!state) return "Plan"

  const todos = extractTodosFromState(state)
  if (state.status !== "completed" || todos.length === 0) return "Plan"

  const counts = summarizeTodos(todos)
  if (counts.pending === counts.total) return "Creating plan"
  if (counts.completed === counts.total) return "Completing plan"
  return "Updating plan"
}

export const todoRenderer: ToolRenderer = {
  tools: ["todowrite", "todoread"],
  getAction: () => "Planning...",
  getTitle({ toolState }) {
    return getTodoTitle(toolState())
  },
  renderBody({ toolState }) {
    const state = toolState()
    if (!state) return null

    const todos = extractTodosFromState(state)
    const counts = summarizeTodos(todos)

    if (counts.total === 0) {
      return <div class="tool-call-todo-empty">No plan items yet.</div>
    }

    return (
      <div class="tool-call-todo-region">
        <div class="tool-call-todos" role="list">
          <For each={todos}>
            {(todo) => {
              const label = getTodoStatusLabel(todo.status)
              return (
                <div
                  class="tool-call-todo-item"
                  classList={{
                    "tool-call-todo-item-completed": todo.status === "completed",
                    "tool-call-todo-item-cancelled": todo.status === "cancelled",
                    "tool-call-todo-item-active": todo.status === "in_progress",
                  }}
                  role="listitem"
                >
                  <span class="tool-call-todo-checkbox" data-status={todo.status} aria-label={label}></span>
                  <div class="tool-call-todo-body">
                    <div class="tool-call-todo-heading">
                      <span class="tool-call-todo-text">{todo.content}</span>
                      <span class={`tool-call-todo-status tool-call-todo-status-${todo.status}`}>{label}</span>
                    </div>
                  </div>
                </div>
              )
            }}
          </For>
        </div>
      </div>
    )
  },
}
