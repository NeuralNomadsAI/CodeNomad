import { Component, Show } from "solid-js"
import type { LinearIssue } from "../stores/linear-tasks"
import { getPriorityColor, getStatusDotColor } from "../stores/linear-tasks"
import { cn } from "../lib/cn"

interface LinearTaskCardProps {
  issue: LinearIssue
  compact?: boolean
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

const LinearTaskCard: Component<LinearTaskCardProps> = (props) => {
  const handleClick = () => {
    if (props.issue.url) {
      window.open(props.issue.url, "_blank", "noopener,noreferrer")
    }
  }

  return (
    <button
      type="button"
      class={cn(
        "w-full text-left px-3 py-2 transition-colors hover:bg-accent/50 cursor-pointer border-none bg-transparent",
        props.compact && "py-1.5"
      )}
      onClick={handleClick}
      title={`${props.issue.identifier}: ${props.issue.title}`}
    >
      <div class="flex items-start gap-2">
        <span class={cn("w-2 h-2 rounded-full shrink-0 mt-1.5", getStatusDotColor(props.issue.status))} />
        <div class="flex-1 min-w-0">
          <div class={cn("flex items-center gap-1.5", props.compact ? "flex-nowrap" : "flex-wrap")}>
            <span class="text-xs font-mono text-muted-foreground shrink-0">{props.issue.identifier}</span>
            <span class={cn(
              "text-sm text-foreground truncate",
              props.compact ? "flex-1" : "w-full"
            )}>
              {props.issue.title}
            </span>
          </div>
          <Show when={!props.compact}>
            <div class="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
              <span class={cn("font-medium", getPriorityColor(props.issue.priority))}>
                {props.issue.priorityLabel}
              </span>
              <Show when={props.issue.labels.length > 0}>
                <span class="text-border">&middot;</span>
                <span class="truncate">{props.issue.labels.join(", ")}</span>
              </Show>
              <Show when={props.issue.assignee}>
                <span class="text-border">&middot;</span>
                <span>{props.issue.assignee}</span>
              </Show>
              <span class="ml-auto shrink-0">{formatTimeAgo(props.issue.updatedAt)}</span>
            </div>
          </Show>
        </div>
      </div>
    </button>
  )
}

export default LinearTaskCard
