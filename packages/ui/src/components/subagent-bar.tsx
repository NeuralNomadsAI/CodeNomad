import { Component, For, Show } from "solid-js"
import type { Session } from "../types/session"
import { Bot, GitFork, MessageSquare } from "lucide-solid"
import { getSessionStatus } from "../stores/session-status"
import { cn } from "../lib/cn"

interface SubagentBarProps {
  instanceId: string
  parentSession: Session
  childSessions: Session[]
  activeSessionId: string | null
  onSelectChild: (childId: string) => void
  onSelectParent: () => void
}

const SubagentBar: Component<SubagentBarProps> = (props) => {
  // Generate a short title (max 4 words) from session title
  const getShortTitle = (title: string | undefined): string => {
    if (!title || !title.trim()) return "Untitled"
    const words = title.trim().split(/\s+/)
    if (words.length <= 4) return title.trim()
    return words.slice(0, 4).join(" ") + "..."
  }

  // Get icon for session type
  const getSessionIcon = (session: Session) => {
    if (session.title?.includes("subagent)")) {
      return <Bot class="w-3.5 h-3.5 flex-shrink-0" />
    }
    return <GitFork class="w-3.5 h-3.5 flex-shrink-0" />
  }

  // Get status class for child button
  const getStatusClass = (session: Session) => {
    if (session.pendingPermission) return "bg-warning/20 text-warning"
    const computed = getSessionStatus(props.instanceId, session.id)
    if (computed === "compacting") return "opacity-80"
    return ""
  }

  // Check if child is working (for indicator animation)
  const isWorking = (session: Session) => {
    const computed = getSessionStatus(props.instanceId, session.id)
    return computed === "working"
  }

  // Get status indicator
  const getStatusIndicator = (session: Session) => {
    if (session.pendingPermission) return "\u{1F6E1}\u{FE0F}"
    const computed = getSessionStatus(props.instanceId, session.id)
    if (computed === "working") return "\u25CF"
    if (computed === "compacting") return "\u25D0"
    return null
  }

  return (
    <div class="flex items-center gap-2 h-9 px-3 bg-background border-b border-border animate-[subagent-bar-slide-in_0.15s_ease-out]">
      {/* Parent session link */}
      <button
        class={cn(
          "inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors cursor-pointer",
          props.activeSessionId === props.parentSession.id
            ? "bg-info text-primary-foreground"
            : "bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground"
        )}
        onClick={props.onSelectParent}
        title={`Return to ${getShortTitle(props.parentSession.title)}`}
      >
        <MessageSquare class="w-3.5 h-3.5 opacity-70" />
        <span class="truncate max-w-[120px]">{getShortTitle(props.parentSession.title)}</span>
      </button>

      <span class="text-lg flex-shrink-0 text-muted-foreground">{"\u203A"}</span>

      {/* Child sessions */}
      <div class="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto scrollbar-none">
        <For each={props.childSessions}>
          {(child) => {
            const isActive = () => props.activeSessionId === child.id
            return (
              <button
                class={cn(
                  "inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer flex-shrink-0",
                  isActive()
                    ? "bg-info text-primary-foreground"
                    : cn("bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground", getStatusClass(child))
                )}
                onClick={() => props.onSelectChild(child.id)}
                title={child.title || "Sub-agent"}
              >
                {getSessionIcon(child)}
                <span class="truncate max-w-[150px]">{getShortTitle(child.title) || "Sub-agent"}</span>
                <Show when={getStatusIndicator(child)}>
                  <span class={cn(
                    "flex-shrink-0 text-[10px]",
                    isWorking(child) && !isActive() && "text-info animate-[badge-pulse_1.5s_ease-in-out_infinite]"
                  )}>{getStatusIndicator(child)}</span>
                </Show>
              </button>
            )
          }}
        </For>
      </div>
    </div>
  )
}

export default SubagentBar
