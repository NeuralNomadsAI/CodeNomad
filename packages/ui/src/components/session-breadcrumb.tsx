import { Component, Show, For } from "solid-js"
import type { Session } from "../types/session"
import { ChevronRight, ArrowLeft, MessageSquare, Bot, GitFork } from "lucide-solid"
import { getSessionStatus } from "../stores/session-status"
import { getChildSessions } from "../stores/session-state"

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
    if (props.currentSession.pendingPermission) return { text: "Permission", class: "text-warning" }
    const computed = getSessionStatus(props.instanceId, props.currentSession.id)
    if (computed === "working") return { text: "Working", class: "text-accent animate-pulse" }
    if (computed === "compacting") return { text: "Compacting", class: "text-muted" }
    return { text: "Idle", class: "text-muted" }
  }

  return (
    <div class="session-breadcrumb">
      {/* Return to parent button */}
      <button
        class="session-breadcrumb-parent"
        onClick={props.onReturnToParent}
        title={`Return to ${getShortTitle(props.parentSession.title)}`}
      >
        <ArrowLeft class="w-3.5 h-3.5" />
        <MessageSquare class="w-3.5 h-3.5 opacity-70" />
        <span class="session-breadcrumb-parent-label">{getShortTitle(props.parentSession.title)}</span>
      </button>

      <ChevronRight class="w-4 h-4 text-muted flex-shrink-0" />

      {/* Current session and sibling tabs */}
      <div class="session-breadcrumb-siblings">
        <For each={props.siblingsSessions}>
          {(sibling) => {
            const isActive = () => sibling.id === props.currentSession.id
            const statusClass = () => {
              if (sibling.pendingPermission) return "session-sibling-tab-permission"
              const computed = getSessionStatus(props.instanceId, sibling.id)
              if (computed === "working") return "session-sibling-tab-working"
              return ""
            }

            return (
              <button
                class={`session-sibling-tab ${isActive() ? "session-sibling-tab-active" : ""} ${statusClass()}`}
                onClick={() => props.onSelectSibling(sibling.id)}
                title={sibling.title || "Sub-agent"}
              >
                {getSessionIcon(sibling)}
                <span class="session-sibling-tab-label">{getShortTitle(sibling.title) || "Sub-agent"}</span>
                <Show when={sibling.pendingPermission || getSessionStatus(props.instanceId, sibling.id) === "working"}>
                  <span class="session-sibling-tab-indicator">
                    {sibling.pendingPermission ? "🛡️" : "●"}
                  </span>
                </Show>
              </button>
            )
          }}
        </For>
      </div>

      {/* Status indicator */}
      <div class="session-breadcrumb-status">
        <span class={`session-breadcrumb-status-text ${getStatusDisplay().class}`}>
          {getStatusDisplay().text}
        </span>
      </div>
    </div>
  )
}

export default SessionBreadcrumb
