import { Component, For, Show } from "solid-js"
import type { Session } from "../types/session"
import { Bot, GitFork, MessageSquare } from "lucide-solid"
import { getSessionStatus } from "../stores/session-status"

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
    if (session.pendingPermission) return "subagent-tab-permission"
    const computed = getSessionStatus(props.instanceId, session.id)
    if (computed === "working") return "subagent-tab-working"
    if (computed === "compacting") return "subagent-tab-compacting"
    return ""
  }

  // Get status indicator
  const getStatusIndicator = (session: Session) => {
    if (session.pendingPermission) return "🛡️"
    const computed = getSessionStatus(props.instanceId, session.id)
    if (computed === "working") return "●"
    if (computed === "compacting") return "◐"
    return null
  }

  return (
    <div class="subagent-bar">
      {/* Parent session link */}
      <button
        class={`subagent-parent-button ${props.activeSessionId === props.parentSession.id ? 'subagent-tab-active' : ''}`}
        onClick={props.onSelectParent}
        title={`Return to ${getShortTitle(props.parentSession.title)}`}
      >
        <MessageSquare class="w-3.5 h-3.5 opacity-70" />
        <span class="subagent-parent-label">{getShortTitle(props.parentSession.title)}</span>
      </button>

      <span class="subagent-separator">›</span>

      {/* Child sessions */}
      <div class="subagent-list">
        <For each={props.childSessions}>
          {(child) => {
            const isActive = () => props.activeSessionId === child.id
            return (
              <button
                class={`subagent-tab ${isActive() ? 'subagent-tab-active' : ''} ${getStatusClass(child)}`}
                onClick={() => props.onSelectChild(child.id)}
                title={child.title || "Sub-agent"}
              >
                {getSessionIcon(child)}
                <span class="subagent-tab-label">{getShortTitle(child.title) || "Sub-agent"}</span>
                <Show when={getStatusIndicator(child)}>
                  <span class="subagent-tab-indicator">{getStatusIndicator(child)}</span>
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
