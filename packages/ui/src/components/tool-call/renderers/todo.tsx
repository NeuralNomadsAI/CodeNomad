import { For, Show } from "solid-js"
import type { ToolState } from "../../../types/tool-state"
import { CheckCircle, CircleEllipsis, MinusCircle, PauseCircle } from "lucide-solid"
import type { ToolRenderer } from "../types"
import { limitToolOutputForRender, readToolStatePayload, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT } from "../utils"
import { useI18n, tGlobal } from "../../../lib/i18n"
import { getTodoToolSearchText } from "../search-text"

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
  let characters = 0

  for (let index = 0; index < todos.length && characters < TOOL_OUTPUT_RENDER_CHARACTER_LIMIT; index++) {
    const todo = todos[index]
    const remaining = TOOL_OUTPUT_RENDER_CHARACTER_LIMIT - characters
    const content = typeof todo?.content === "string" ? todo.content.slice(0, remaining + 1).trim() : ""
    if (!content) continue
    const status = normalizeTodoStatus((todo as any).status)
    const id = typeof todo?.id === "string" && todo.id.length > 0 ? todo.id : String(index)
    const renderedContent = limitToolOutputForRender(content)
    characters += Math.min(content.length, remaining)
    items.push({ id, content: renderedContent, status })
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

function getTodoStatusLabel(t: (key: string) => string, status: TodoViewStatus): string {
  switch (status) {
    case "completed":
      return t("toolCall.renderer.todo.status.completed")
    case "in_progress":
      return t("toolCall.renderer.todo.status.inProgress")
    case "cancelled":
      return t("toolCall.renderer.todo.status.cancelled")
    default:
      return t("toolCall.renderer.todo.status.pending")
  }
}

function TodoStatusIcon(props: { status: TodoViewStatus }) {
  switch (props.status) {
    case "completed":
      return <CheckCircle class="tool-call-todo-icon" aria-hidden="true" />
    case "in_progress":
      return <CircleEllipsis class="tool-call-todo-icon" aria-hidden="true" />
    case "cancelled":
      return <MinusCircle class="tool-call-todo-icon" aria-hidden="true" />
    default:
      return <PauseCircle class="tool-call-todo-icon" aria-hidden="true" />
  }
}

interface TodoListViewProps {
  state?: ToolState
  emptyLabel?: string
  showStatusLabel?: boolean
}

export function TodoListView(props: TodoListViewProps) {
  const { t } = useI18n()
  const todos = extractTodosFromState(props.state)
  const counts = summarizeTodos(todos)

  if (counts.total === 0) {
    return <div class="tool-call-todo-empty">{props.emptyLabel ?? t("toolCall.renderer.todo.empty")}</div>
  }

  return (
    <div class="tool-call-todo-region">
      <div class="tool-call-todos" role="list">
        <For each={todos}>
          {(todo) => {
            const label = getTodoStatusLabel(t, todo.status)
            return (
              <div
                class="tool-call-todo-item"
                classList={{
                  "tool-call-todo-item-completed": todo.status === "completed",
                  "tool-call-todo-item-cancelled": todo.status === "cancelled",
                }}
                role="listitem"
              >
                <span class="tool-call-todo-checkbox" data-status={todo.status} aria-label={label}>
                  <TodoStatusIcon status={todo.status} />
                </span>
                <div class="tool-call-todo-body">
                  <div class="tool-call-todo-heading">
                    <span class="tool-call-todo-text">{todo.content}</span>
                    <Show when={props.showStatusLabel !== false}>
                      <span class={`tool-call-todo-status tool-call-todo-status-${todo.status}`}>{label}</span>
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
  if (!state) return tGlobal("toolCall.renderer.todo.title.plan")

  const todos = extractTodosFromState(state)
  if (state.status !== "completed" || todos.length === 0) return tGlobal("toolCall.renderer.todo.title.plan")

  const counts = summarizeTodos(todos)
  if (counts.pending === counts.total) return tGlobal("toolCall.renderer.todo.title.creating")
  if (counts.completed === counts.total) return tGlobal("toolCall.renderer.todo.title.completing")
  return tGlobal("toolCall.renderer.todo.title.updating")
}

export const todoRenderer: ToolRenderer = {
  tools: ["todowrite"],
  getSearchText: getTodoToolSearchText,
  getAction: () => tGlobal("toolCall.renderer.action.planning"),
  getTitle({ toolState }) {
    return getTodoTitle(toolState())
  },
  renderBody({ toolState }) {
    const state = toolState()
    if (!state) return null

    return <TodoListView state={state} />
  },
}
