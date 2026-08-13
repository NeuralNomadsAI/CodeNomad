import { For, Show } from "solid-js"
import type { ToolState } from "../../../types/tool-state"
import { CheckCircle, CircleEllipsis, Copy, MinusCircle, PauseCircle } from "lucide-solid"
import type { ToolRenderer } from "../types"
import { useI18n, tGlobal } from "../../../lib/i18n"
import { getTodoToolSearchText } from "../search-text"
import { extractTodosFromState, getRenderedTodos, getTodoCopyText, getTodoTitleKind, hasTodoCopyText, type TodoViewItem, type TodoViewStatus } from "./todo-data"
import { copyToClipboard } from "../../../lib/clipboard"

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
  const allTodos = extractTodosFromState(props.state)
  const todos = getRenderedTodos(allTodos)
  const counts = summarizeTodos(allTodos)

  if (counts.total === 0 && !todos.truncated) {
    return <div class="tool-call-todo-empty">{props.emptyLabel ?? t("toolCall.renderer.todo.empty")}</div>
  }

  return (
    <div class="tool-call-todo-region">
      <div class="tool-call-todos" role="list">
        <For each={todos.items}>
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
      <Show when={todos.truncated}>
        <div class="tool-call-diagnostic-message">
          <span role="status">{t("toolCall.output.truncated")}</span>
          <button type="button" class="tool-call-header-icon-button tool-call-header-copy" onClick={() => void copyToClipboard(getTodoCopyText(props.state))} aria-label={t("toolCall.io.copyOutputAriaLabel")} title={t("toolCall.io.copyOutputTitle")}>
            <Copy class="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      </Show>
    </div>
  )
}

export function getTodoTitle(state?: ToolState): string {
  return tGlobal(`toolCall.renderer.todo.title.${getTodoTitleKind(state)}`)
}

export const todoRenderer: ToolRenderer = {
  tools: ["todowrite"],
  getSearchText: getTodoToolSearchText,
  getAction: () => tGlobal("toolCall.renderer.action.planning"),
  getTitle({ toolState }) {
    return getTodoTitle(toolState())
  },
  getOutputChrome({ toolState }) {
    const state = toolState()
    return hasTodoCopyText(state) ? { getCopyText: () => getTodoCopyText(state), hasCopyText: true } : undefined
  },
  renderBody({ toolState }) {
    const state = toolState()
    if (!state) return null

    return <TodoListView state={state} />
  },
}
