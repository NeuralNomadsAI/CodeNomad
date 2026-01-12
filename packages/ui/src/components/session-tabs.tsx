import { Component, For, Show, createSignal, onMount, onCleanup, createMemo } from "solid-js"
import type { Session, SessionStatus } from "../types/session"
import { getSessionStatus } from "../stores/session-status"
import { getChildSessions } from "../stores/session-state"
import { MessageSquare, Plus, X, ChevronLeft, ChevronRight, ChevronDown, Bot, GitFork } from "lucide-solid"

interface SessionTabsProps {
  instanceId: string
  sessions: Map<string, Session>
  activeSessionId: string | null
  activeParentSessionId?: string | null  // The parent session ID (for breadcrumb context)
  onSelect: (sessionId: string) => void
  onSelectChild?: (parentId: string, childId: string) => void  // Select a child session
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

  // Close dropdown when clicking outside
  const handleClickOutside = (e: MouseEvent) => {
    if (openDropdown() && !(e.target as HTMLElement).closest('.session-tab-dropdown-container')) {
      setOpenDropdown(null)
    }
  }

  onMount(() => {
    checkScrollArrows()
    const resizeObserver = new ResizeObserver(checkScrollArrows)
    if (scrollContainerRef) {
      resizeObserver.observe(scrollContainerRef)
    }
    document.addEventListener('click', handleClickOutside)
    onCleanup(() => {
      resizeObserver.disconnect()
      document.removeEventListener('click', handleClickOutside)
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
  const getThreadPriorityStatus = (sessionId: string): SessionStatus | "permission" => {
    const children = getChildren(sessionId)
    const allSessions = [props.sessions.get(sessionId), ...children].filter(Boolean) as Session[]

    // Check for permission first (highest priority)
    if (allSessions.some(s => s.pendingPermission)) return "permission"
    // Then compacting
    if (allSessions.some(s => s.status === "compacting")) return "compacting"
    // Then working
    if (allSessions.some(s => s.status === "working")) return "working"
    return "idle"
  }

  // Get badge display info for a session with children
  const getBadgeInfo = (sessionId: string): { count: number; status: SessionStatus | "permission" } | null => {
    const children = getChildren(sessionId)
    if (children.length === 0) return null

    const status = getThreadPriorityStatus(sessionId)
    const statusCount = children.filter(c => {
      if (status === "permission") return c.pendingPermission
      return c.status === status
    }).length

    return { count: statusCount > 0 ? statusCount : children.length, status }
  }

  // Track which dropdown is open
  const [openDropdown, setOpenDropdown] = createSignal<string | null>(null)

  const toggleDropdown = (sessionId: string, e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
    console.log('[SessionTabs] toggleDropdown called for:', sessionId, 'current:', openDropdown())
    setOpenDropdown(prev => {
      const next = prev === sessionId ? null : sessionId
      console.log('[SessionTabs] openDropdown changing from', prev, 'to', next)
      return next
    })
  }

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
              const isDropdownOpen = () => openDropdown() === id

              // Get status indicator for badge
              const getStatusIndicator = (status: SessionStatus | "permission") => {
                switch (status) {
                  case "permission": return "🛡️"
                  case "working": return "●"
                  case "compacting": return "◐"
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
                if (child.status === "working") return "session-dropdown-item-working"
                if (child.status === "compacting") return "session-dropdown-item-compacting"
                return ""
              }

              // Get status dot class for the session
              const getStatusDotClass = () => {
                const status = getThreadPriorityStatus(id)
                if (status === "permission") return "session-status-dot session-status-dot-error"
                if (status === "working" || status === "compacting") return "session-status-dot session-status-dot-working"
                return "session-status-dot session-status-dot-idle"
              }

              return (
                <div class="session-tab-dropdown-container relative">
                  <button
                    class={`session-tab ${isActive() ? "session-tab-active" : "session-tab-inactive"} ${statusClass()} group`}
                    onClick={() => props.onSelect(id)}
                    title={session.title || id}
                    role="tab"
                    aria-selected={isActive()}
                  >
                    <span class="session-tab-icon-wrapper">
                      <MessageSquare class="w-3.5 h-3.5 flex-shrink-0 opacity-70" />
                      <span class={getStatusDotClass()} />
                    </span>
                    <span class="session-tab-label">{getShortTitle(session.title)}</span>

                    {/* Badge for sessions with children - use native button for reliable click handling */}
                    <Show when={badge()}>
                      {(badgeInfo) => (
                        <button
                          type="button"
                          class={`session-tab-badge session-tab-badge-${badgeInfo().status}`}
                          onClick={(e) => toggleDropdown(id, e)}
                          onMouseDown={(e) => e.stopPropagation()}
                          title={`${badgeInfo().count} child session${badgeInfo().count > 1 ? 's' : ''}`}
                        >
                          <span class="session-tab-badge-indicator">{getStatusIndicator(badgeInfo().status)}</span>
                          <span class="session-tab-badge-count">{badgeInfo().count}</span>
                          <ChevronDown class={`w-3 h-3 transition-transform ${isDropdownOpen() ? 'rotate-180' : ''}`} />
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

                  {/* Dropdown for child sessions */}
                  <Show when={isDropdownOpen() && children().length > 0}>
                    <div class="session-tab-dropdown">
                      <div class="session-dropdown-header">
                        <span class="session-dropdown-title">{getShortTitle(session.title)}</span>
                      </div>
                      <div class="session-dropdown-divider" />
                      <div class="session-dropdown-list">
                        <For each={children()}>
                          {(child) => (
                            <button
                              class={`session-dropdown-item ${getChildStatusClass(child)}`}
                              onClick={() => {
                                setOpenDropdown(null)
                                // Use onSelectChild if available, otherwise fall back to onSelect
                                if (props.onSelectChild) {
                                  props.onSelectChild(id, child.id)
                                } else {
                                  props.onSelect(child.id)
                                }
                              }}
                            >
                              <span class="session-dropdown-item-status">
                                {child.pendingPermission ? "🛡️" : child.status === "working" ? "●" : child.status === "compacting" ? "◐" : "○"}
                              </span>
                              {getChildIcon(child)}
                              <span class="session-dropdown-item-label">{getShortTitle(child.title) || "Sub-agent"}</span>
                              <span class="session-dropdown-item-state">
                                {child.pendingPermission ? "Permission" : child.status === "working" ? "Working" : child.status === "compacting" ? "Compacting" : "Idle"}
                              </span>
                            </button>
                          )}
                        </For>
                      </div>
                      <div class="session-dropdown-divider" />
                      <button
                        class="session-dropdown-item session-dropdown-item-parent"
                        onClick={() => {
                          setOpenDropdown(null)
                          props.onSelect(id)
                        }}
                      >
                        <span class="session-dropdown-item-status">
                          {isActive() ? "✓" : "○"}
                        </span>
                        <MessageSquare class="w-3 h-3 flex-shrink-0" />
                        <span class="session-dropdown-item-label">Main conversation</span>
                        <span class="session-dropdown-item-state">
                          {isActive() ? "Viewing" : ""}
                        </span>
                      </button>
                    </div>
                  </Show>
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
