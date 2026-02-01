import { For, Show } from "solid-js"
import type { ToolState } from "@opencode-ai/sdk"
import type { ToolRenderer } from "../types"
import { readToolStatePayload } from "../utils"
import { cn } from "../../../lib/cn"

export type TodoViewStatus = "pending" | "in_progress" | "completed" | "cancelled"

export interface TodoViewItem {
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

function getCheckboxClass(status: TodoViewStatus): string {
  switch (status) {
    case "completed":
      return "bg-info border-info text-info-foreground"
    case "in_progress":
      return "border-border text-info"
    case "cancelled":
      return "border-border text-destructive"
    default:
      return "border-border text-muted-foreground"
  }
}

function getCheckboxContent(status: TodoViewStatus): string {
  switch (status) {
    case "completed":
      return "\u2713"
    case "in_progress":
      return "\u2026"
    case "cancelled":
      return "\u00D7"
    default:
      return ""
  }
}

function getStatusBadgeClass(status: TodoViewStatus): string {
  switch (status) {
    case "completed":
      return "bg-success/10 text-success"
    case "in_progress":
      return "bg-muted text-foreground"
    case "cancelled":
      return "bg-destructive/10 text-destructive"
    default:
      return "bg-accent/10 text-muted-foreground"
  }
}

interface TodoListViewProps {
  state?: ToolState
  emptyLabel?: string
  showStatusLabel?: boolean
}

export function TodoListView(props: TodoListViewProps) {
  const todos = extractTodosFromState(props.state)
  const counts = summarizeTodos(todos)

  if (counts.total === 0) {
    return <div class="text-sm text-muted-foreground py-3">{props.emptyLabel ?? "No plan items yet."}</div>
  }

  return (
    <div class="flex flex-col">
      <div class="flex flex-col" role="list">
        <For each={todos}>
          {(todo) => {
            const label = getTodoStatusLabel(todo.status)
            return (
              <div
                class={cn(
                  "flex items-start gap-3 border border-border px-3 py-2.5 bg-secondary min-h-[42px]",
                  todo.status === "completed" && "bg-muted",
                  todo.status === "cancelled" && "opacity-75",
                  todo.status === "in_progress" && "border-info bg-accent/10",
                )}
                role="listitem"
              >
                <span
                  class={cn(
                    "w-[1.1rem] h-[1.1rem] rounded-full border-2 inline-flex items-center justify-center text-xs font-semibold bg-transparent",
                    getCheckboxClass(todo.status),
                  )}
                  aria-label={label}
                >
                  {getCheckboxContent(todo.status)}
                </span>
                <div class="flex-1 flex flex-col gap-1.5">
                  <div class="flex items-start gap-3 justify-between">
                    <span class={cn(
                      "text-sm leading-tight text-foreground break-words",
                      todo.status === "cancelled" && "line-through text-muted-foreground",
                    )}>{todo.content}</span>
                    <Show when={props.showStatusLabel !== false}>
                      <span class={cn(
                        "text-[10px] uppercase tracking-[0.08em] rounded-full px-2 py-0.5 whitespace-nowrap",
                        getStatusBadgeClass(todo.status),
                      )}>{label}</span>
                    </Show>
                  </div>
                </div>
              </div>
            )
          }}
        </For>
      </div>
    </div>
  )
}

export function getTodoTitle(state?: ToolState): string {
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

    return <TodoListView state={state} />
  },
}
