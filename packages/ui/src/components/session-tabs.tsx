import { Component, For, Show, createSignal, onMount, onCleanup, createMemo } from "solid-js"
import type { Session, SessionStatus } from "../types/session"
import { getSessionStatus } from "../stores/session-status"
import { getChildSessions, hasUnreadCompletion } from "../stores/session-state"
import { MessageSquare, Plus, X, ChevronLeft, ChevronRight, ChevronDown, Bot, GitFork, Loader2, CheckCircle2, AlertTriangle } from "lucide-solid"

interface SessionTabsProps {
  instanceId: string
  sessions: Map<string, Session>
  activeSessionId: string | null
  activeParentSessionId?: string | null  // The parent session ID (for breadcrumb context)
  expandedSubagents?: string | null  // Which session has its subagents expanded inline
  onSelect: (sessionId: string) => void
  onSelectChild?: (parentId: string, childId: string) => void  // Select a child session
  onToggleSubagents?: (sessionId: string) => void  // Toggle subagent bar visibility
  onClose: (sessionId: string) => void
  onNew: () => void
}

const SessionTabs: Component<SessionTabsProps> = (props) => {
  let scrollContainerRef: HTMLDivElement | undefined
  const [showLeftArrow, setShowLeftArrow] = createSignal(false)
  const [showRightArrow, setShowRightArrow] = createSignal(false)

  const checkScrollArrows = () => {
    if (!scrollContainerRef) return
    const { scrollLeft, scrollWidth, clientWidth } = scrollContainerRef
    setShowLeftArrow(scrollLeft > 0)
    setShowRightArrow(scrollLeft + clientWidth < scrollWidth - 1)
  }

  const scrollLeft = () => {
    if (!scrollContainerRef) return
    scrollContainerRef.scrollBy({ left: -200, behavior: "smooth" })
  }

  const scrollRight = () => {
    if (!scrollContainerRef) return
    scrollContainerRef.scrollBy({ left: 200, behavior: "smooth" })
  }

  onMount(() => {
    checkScrollArrows()
    const resizeObserver = new ResizeObserver(checkScrollArrows)
    if (scrollContainerRef) {
      resizeObserver.observe(scrollContainerRef)
    }
    onCleanup(() => {
      resizeObserver.disconnect()
    })
  })

  // Filter to only show parent sessions (user-created sessions, not agent sub-sessions)
  const parentSessions = createMemo(() => {
    const result: Array<[string, Session]> = []
    for (const [id, session] of props.sessions.entries()) {
      if (session.parentId === null) {
        result.push([id, session])
      }
    }
    // Sort by creation time (oldest first, so new tabs appear on the right like a browser)
    result.sort((a, b) => (a[1].time.created ?? 0) - (b[1].time.created ?? 0))
    return result
  })

  // Generate a short title (max 4 words) from session title
  const getShortTitle = (title: string | undefined): string => {
    if (!title || !title.trim()) return "Untitled"
    const words = title.trim().split(/\s+/)
    if (words.length <= 4) return title.trim()
    return words.slice(0, 4).join(" ") + "..."
  }

  // Get status indicator class
  const getStatusClass = (sessionId: string): string => {
    const status = getSessionStatus(props.instanceId, sessionId)
    if (status === "working") return "session-tab-working"
    if (status === "compacting") return "session-tab-compacting"
    return ""
  }

  // Get children for a session
  const getChildren = (sessionId: string): Session[] => {
    return getChildSessions(props.instanceId, sessionId)
  }

  // Get the highest priority status across a session and its children
  const getThreadPriorityStatus = (sessionId: string): SessionStatus | "permission" | "completed" => {
    const children = getChildren(sessionId)
    const allSessions = [props.sessions.get(sessionId), ...children].filter(Boolean) as Session[]

    // Check for permission first (highest priority)
    if (allSessions.some(s => s.pendingPermission)) return "permission"

    let hasCompacting = false
    let hasWorking = false
    for (const s of allSessions) {
      const computed = getSessionStatus(props.instanceId, s.id)
      if (computed === "compacting") hasCompacting = true
      if (computed === "working") hasWorking = true
    }

    if (hasCompacting) return "compacting"
    if (hasWorking) return "working"
    if (hasUnreadCompletion(props.instanceId, sessionId)) return "completed"
    return "idle"
  }

  // Get badge display info for a session with children
  const getBadgeInfo = (sessionId: string): { count: number; status: SessionStatus | "permission" } | null => {
    const children = getChildren(sessionId)
    if (children.length === 0) return null

    const status = getThreadPriorityStatus(sessionId)
    const statusCount = children.filter(c => {
      if (status === "permission") return c.pendingPermission
      const computed = getSessionStatus(props.instanceId, c.id)
      return computed === status
    }).length

    return { count: statusCount > 0 ? statusCount : children.length, status }
  }

  // Toggle subagent bar visibility for a session
  const toggleSubagents = (sessionId: string, e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
    if (props.onToggleSubagents) {
      props.onToggleSubagents(sessionId)
    }
  }

  // Check if subagents are expanded for a session
  const isSubagentsExpanded = (sessionId: string) => props.expandedSubagents === sessionId

  return (
    <div class="session-tab-bar">
      {/* Left scroll arrow */}
      <Show when={showLeftArrow()}>
        <button
          class="session-tab-scroll-arrow session-tab-scroll-left"
          onClick={scrollLeft}
          aria-label="Scroll sessions left"
        >
          <ChevronLeft class="w-4 h-4" />
        </button>
      </Show>

      {/* Scrollable tab container */}
      <div
        ref={scrollContainerRef}
        class="session-tab-scroll-container"
        onScroll={checkScrollArrows}
        role="tablist"
      >
        <div class="session-tab-list">
          <For each={parentSessions()}>
            {([id, session]) => {
              const isActive = () => props.activeSessionId === id
              const statusClass = () => getStatusClass(id)
              const badge = () => getBadgeInfo(id)
              const children = () => getChildren(id)
              const isExpanded = () => isSubagentsExpanded(id)

              // Get status indicator for badge
              const getStatusIndicator = (status: SessionStatus | "permission" | "completed") => {
                switch (status) {
                  case "permission": return "🛡️"
                  case "working": return "●"
                  case "compacting": return "◐"
                  case "completed": return "●"
                  default: return ""
                }
              }

              // Get icon for child session type
              const getChildIcon = (child: Session) => {
                if (child.title?.includes("subagent)")) {
                  return <Bot class="w-3 h-3 flex-shrink-0" />
                }
                return <GitFork class="w-3 h-3 flex-shrink-0" />
              }

              // Get status class for child row
              const getChildStatusClass = (child: Session) => {
                if (child.pendingPermission) return "session-dropdown-item-permission"
                const computed = getSessionStatus(props.instanceId, child.id)
                if (computed === "working") return "session-dropdown-item-working"
                if (computed === "compacting") return "session-dropdown-item-compacting"
                return ""
              }

              // Dynamic icon based on thread status
              const getTabIcon = () => {
                const status = getThreadPriorityStatus(id)
                switch (status) {
                  case "working":
                  case "compacting":
                    return <Loader2 class="w-3.5 h-3.5 flex-shrink-0 animate-spin session-tab-icon-working" />
                  case "completed":
                    return <CheckCircle2 class="w-3.5 h-3.5 flex-shrink-0 session-tab-icon-completed" />
                  case "permission":
                    return <AlertTriangle class="w-3.5 h-3.5 flex-shrink-0 session-tab-icon-permission" />
                  default:
                    return <MessageSquare class="w-3.5 h-3.5 flex-shrink-0 opacity-70" />
                }
              }

              // Tab background class based on status
              const getTabStatusBgClass = () => {
                const status = getThreadPriorityStatus(id)
                if (status === "completed") return "session-tab-bg-completed"
                if (status === "permission") return "session-tab-bg-permission"
                return ""
              }

              return (
                <div class="session-tab-dropdown-container relative">
                  <button
                    class={`session-tab ${isActive() ? "session-tab-active" : "session-tab-inactive"} ${statusClass()} ${getTabStatusBgClass()} group`}
                    onClick={() => props.onSelect(id)}
                    title={session.title || id}
                    role="tab"
                    aria-selected={isActive()}
                  >
                    {getTabIcon()}
                    <span class="session-tab-label">{getShortTitle(session.title)}</span>

                    {/* Badge for sessions with children - toggles subagent bar */}
                    <Show when={badge()}>
                      {(badgeInfo) => (
                        <button
                          type="button"
                          class={`session-tab-badge session-tab-badge-${badgeInfo().status} ${isExpanded() ? 'session-tab-badge-expanded' : ''}`}
                          onClick={(e) => toggleSubagents(id, e)}
                          onMouseDown={(e) => e.stopPropagation()}
                          title={`${badgeInfo().count} child session${badgeInfo().count > 1 ? 's' : ''} - click to ${isExpanded() ? 'hide' : 'show'}`}
                        >
                          <span class="session-tab-badge-indicator">{getStatusIndicator(badgeInfo().status)}</span>
                          <span class="session-tab-badge-count">{badgeInfo().count}</span>
                          <ChevronDown class={`w-3 h-3 transition-transform ${isExpanded() ? 'rotate-180' : ''}`} />
                        </button>
                      )}
                    </Show>

                    <span
                      class="session-tab-close"
                      onClick={(e) => {
                        e.stopPropagation()
                        props.onClose(id)
                      }}
                      role="button"
                      tabIndex={0}
                      aria-label={`Close ${getShortTitle(session.title)}`}
                    >
                      <X class="w-3 h-3" />
                    </span>
                  </button>

                  {/* Subagent bar is shown outside SessionTabs when expanded */}
                </div>
              )
            }}
          </For>

          {/* New session button */}
          <button
            class="session-tab-new"
            onClick={props.onNew}
            title="New session (Cmd+Shift+N)"
            aria-label="New session"
          >
            <Plus class="w-4 h-4" />
            <span class="session-tab-new-label">New</span>
          </button>
        </div>
      </div>

      {/* Right scroll arrow */}
      <Show when={showRightArrow()}>
        <button
          class="session-tab-scroll-arrow session-tab-scroll-right"
          onClick={scrollRight}
          aria-label="Scroll sessions right"
        >
          <ChevronRight class="w-4 h-4" />
        </button>
      </Show>
    </div>
  )
}

export default SessionTabs
