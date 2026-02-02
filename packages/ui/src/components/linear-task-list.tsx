import { Component, For, Show, createMemo } from "solid-js"
import type { LinearIssue } from "../stores/linear-tasks"
import LinearTaskCard from "./linear-task-card"

interface LinearTaskListProps {
  issues: LinearIssue[]
  compact?: boolean
  emptyMessage?: string
}

const STATUS_ORDER = ["In Progress", "Started", "Todo", "Backlog", "Done", "Completed", "Canceled", "Cancelled"]

const LinearTaskList: Component<LinearTaskListProps> = (props) => {
  const sortedIssues = createMemo(() => {
    return [...props.issues].sort((a, b) => {
      const aIdx = STATUS_ORDER.findIndex((s) => s.toLowerCase() === a.status.toLowerCase())
      const bIdx = STATUS_ORDER.findIndex((s) => s.toLowerCase() === b.status.toLowerCase())
      const aOrder = aIdx >= 0 ? aIdx : STATUS_ORDER.length
      const bOrder = bIdx >= 0 ? bIdx : STATUS_ORDER.length
      if (aOrder !== bOrder) return aOrder - bOrder
      return a.priority - b.priority
    })
  })

  return (
    <div class="flex flex-col">
      <Show
        when={sortedIssues().length > 0}
        fallback={
          <div class="px-3 py-4 text-sm text-muted-foreground text-center">
            {props.emptyMessage ?? "No Linear tasks found"}
          </div>
        }
      >
        <For each={sortedIssues()}>
          {(issue) => (
            <LinearTaskCard issue={issue} compact={props.compact} />
          )}
        </For>
      </Show>
    </div>
  )
}

export default LinearTaskList
