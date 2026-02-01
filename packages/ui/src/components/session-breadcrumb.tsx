import { Component, Show, For } from "solid-js"
import type { Session } from "../types/session"
import { ChevronRight, ArrowLeft, MessageSquare, Bot, GitFork } from "lucide-solid"
import { getSessionStatus } from "../stores/session-status"
import { getChildSessions } from "../stores/session-state"
import { cn } from "../lib/cn"

interface SessionBreadcrumbProps {
  instanceId: string
  parentSession: Session
  currentSession: Session
  siblingsSessions: Session[]
  onReturnToParent: () => void
  onSelectSibling: (sessionId: string) => void
}

const SessionBreadcrumb: Component<SessionBreadcrumbProps> = (props) => {
  // Generate a short title (max 4 words) from session title
  const getShortTitle = (title: string | undefined): string => {
    if (!title || !title.trim()) return "Untitled"
    const words = title.trim().split(/\s+/)
    if (words.length <= 4) return title.trim()
    return words.slice(0, 4).join(" ") + "..."
  }

  // Get icon for session type
  const getSessionIcon = (session: Session) => {
    if (session.parentId === null) {
      return <MessageSquare class="w-3.5 h-3.5 flex-shrink-0" />
    }
    if (session.title?.includes("subagent)")) {
      return <Bot class="w-3.5 h-3.5 flex-shrink-0" />
    }
    return <GitFork class="w-3.5 h-3.5 flex-shrink-0" />
  }

  // Check if this is a sub-agent session
  const isSubAgent = () => {
    return props.currentSession.title?.includes("subagent)")
  }

  // Get status display
  const getStatusDisplay = () => {
    if (props.currentSession.pendingPermission) return { text: "Permission", className: "text-warning" }
    const computed = getSessionStatus(props.instanceId, props.currentSession.id)
    if (computed === "working") return { text: "Working", className: "text-info animate-pulse" }
    if (computed === "compacting") return { text: "Compacting", className: "text-muted-foreground" }
    return { text: "Idle", className: "text-muted-foreground" }
  }

  return (
    <div class="flex items-center gap-2 h-9 px-3 bg-background border-b border-border md:flex-wrap md:h-auto md:py-2">
      {/* Return to parent button */}
      <button
        class="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors cursor-pointer bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={props.onReturnToParent}
        title={`Return to ${getShortTitle(props.parentSession.title)}`}
      >
        <ArrowLeft class="w-3.5 h-3.5" />
        <MessageSquare class="w-3.5 h-3.5 opacity-70" />
        <span class="truncate max-w-[120px]">{getShortTitle(props.parentSession.title)}</span>
      </button>

      <ChevronRight class="w-4 h-4 text-muted-foreground flex-shrink-0" />

      {/* Current session and sibling tabs */}
      <div class="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto scrollbar-none">
        <For each={props.siblingsSessions}>
          {(sibling) => {
            const isActive = () => sibling.id === props.currentSession.id
            const statusClass = () => {
              if (sibling.pendingPermission) return "bg-warning/20 text-warning"
              const computed = getSessionStatus(props.instanceId, sibling.id)
              if (computed === "working") return ""
              return ""
            }

            return (
              <button
                class={cn(
                  "inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors cursor-pointer flex-shrink-0",
                  isActive()
                    ? "bg-info text-white font-medium"
                    : cn("bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground", statusClass())
                )}
                onClick={() => props.onSelectSibling(sibling.id)}
                title={sibling.title || "Sub-agent"}
              >
                {getSessionIcon(sibling)}
                <span class="truncate max-w-[100px]">{getShortTitle(sibling.title) || "Sub-agent"}</span>
                <Show when={sibling.pendingPermission || getSessionStatus(props.instanceId, sibling.id) === "working"}>
                  <span class={cn(
                    "text-[10px]",
                    !sibling.pendingPermission && "text-info animate-[badge-pulse_1.5s_ease-in-out_infinite]"
                  )}>
                    {sibling.pendingPermission ? "\u{1F6E1}\u{FE0F}" : "\u25CF"}
                  </span>
                </Show>
              </button>
            )
          }}
        </For>
      </div>

      {/* Status indicator */}
      <div class="flex-shrink-0 ml-auto">
        <span class={cn("text-xs", getStatusDisplay().className)}>
          {getStatusDisplay().text}
        </span>
      </div>
    </div>
  )
}

export default SessionBreadcrumb
