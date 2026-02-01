import { Component, For, Show, createSignal, onMount, onCleanup, createMemo } from "solid-js"
import type { Session, SessionStatus } from "../types/session"
import { getSessionStatus } from "../stores/session-status"
import { getChildSessions, hasUnreadCompletion } from "../stores/session-state"
import { MessageSquare, Plus, X, ChevronLeft, ChevronRight, ChevronDown, Bot, GitFork, Loader2, CheckCircle2, AlertTriangle, PanelLeftOpen, PanelLeftClose, PanelRightOpen, PanelRightClose } from "lucide-solid"
import { cn } from "../lib/cn"
import { getSidebarControls } from "../stores/sidebar-controls"

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

  // Get status animation class
  const getStatusClass = (sessionId: string): string => {
    const status = getSessionStatus(props.instanceId, sessionId)
    if (status === "working") return "animate-[session-pulse_1.5s_ease-in-out_infinite]"
    if (status === "compacting") return "opacity-70"
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

  const controls = () => getSidebarControls()

  return (
    <div class="flex items-center h-9 px-2 bg-background relative z-10" style={{ "box-shadow": "var(--chrome-shadow)" }}>
      {/* Left sidebar toggle */}
      <Show when={controls()}>
        {(ctrl) => (
          <button
            class={cn(
              "inline-flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors flex-shrink-0 mr-1",
              ctrl().leftDisabled && "opacity-30 pointer-events-none"
            )}
            onClick={() => ctrl().onLeftToggle()}
            aria-label={ctrl().leftLabel}
            disabled={ctrl().leftDisabled}
          >
            {ctrl().leftIcon === "open" ? <PanelLeftOpen class="w-4 h-4" /> : <PanelLeftClose class="w-4 h-4" />}
          </button>
        )}
      </Show>

      {/* Left scroll arrow */}
      <Show when={showLeftArrow()}>
        <button
          class="flex items-center justify-center w-5 h-5 rounded transition-colors flex-shrink-0 mr-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={scrollLeft}
          aria-label="Scroll sessions left"
        >
          <ChevronLeft class="w-4 h-4" />
        </button>
      </Show>

      {/* Scrollable tab container */}
      <div
        ref={scrollContainerRef}
        class="flex-1 overflow-x-auto scrollbar-none"
        onScroll={checkScrollArrows}
        role="tablist"
      >
        <div class="flex items-center gap-1 h-full">
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
                  case "permission": return "\u{1F6E1}\u{FE0F}"
                  case "working": return "\u25CF"
                  case "compacting": return "\u25D0"
                  case "completed": return "\u25CF"
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
                if (child.pendingPermission) return "bg-warning/20"
                const computed = getSessionStatus(props.instanceId, child.id)
                if (computed === "working") return ""
                if (computed === "compacting") return ""
                return ""
              }

              // Dynamic icon based on thread status
              const getTabIcon = () => {
                const status = getThreadPriorityStatus(id)
                switch (status) {
                  case "working":
                  case "compacting":
                    return <Loader2 class={cn("w-3.5 h-3.5 flex-shrink-0 animate-spin", isActive() ? "text-white" : "text-info")} />
                  case "completed":
                    return <CheckCircle2 class={cn("w-3.5 h-3.5 flex-shrink-0", isActive() ? "text-white" : "text-success animate-[icon-attention-pulse_2s_ease-in-out_infinite]")} />
                  case "permission":
                    return <AlertTriangle class={cn("w-3.5 h-3.5 flex-shrink-0", isActive() ? "text-white" : "text-destructive animate-[icon-attention-pulse_1.5s_ease-in-out_infinite]")} />
                  default:
                    return <MessageSquare class="w-3.5 h-3.5 flex-shrink-0 opacity-70" />
                }
              }

              // Tab background class based on status (only for inactive tabs)
              const getTabStatusBgClass = () => {
                if (isActive()) return ""
                const status = getThreadPriorityStatus(id)
                if (status === "completed") return "bg-success/10 hover:bg-success/[0.18]"
                if (status === "permission") return "bg-destructive/10 hover:bg-destructive/[0.18]"
                return ""
              }

              return (
                <div class="relative">
                  <button
                    class={cn(
                      "inline-flex items-center gap-1.5 px-2.5 h-7 rounded text-xs font-medium transition-colors cursor-pointer max-w-[220px] outline-none group",
                      "focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-info focus-visible:ring-offset-background",
                      isActive()
                        ? "bg-info text-white shadow-[0_0_0_1px_rgba(0,128,255,0.3)] border-b-2 border-white/40"
                        : cn("bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground", getTabStatusBgClass()),
                      statusClass()
                    )}
                    onClick={() => props.onSelect(id)}
                    title={session.title || id}
                    role="tab"
                    aria-selected={isActive()}
                  >
                    {getTabIcon()}
                    <span class="truncate">{getShortTitle(session.title)}</span>

                    {/* Badge for sessions with children - toggles subagent bar */}
                    <Show when={badge()}>
                      {(badgeInfo) => (
                        <button
                          type="button"
                          class={cn(
                            "inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] cursor-pointer transition-all ml-1 border border-transparent",
                            isActive()
                              ? cn(
                                  "bg-white/20 text-inherit",
                                  "hover:bg-white/30",
                                  badgeInfo().status === "permission" && "bg-warning/20 text-warning"
                                )
                              : cn(
                                  "bg-secondary text-muted-foreground",
                                  "hover:bg-accent hover:border-border hover:scale-105",
                                  badgeInfo().status === "permission" && "bg-warning/20 text-warning"
                                ),
                            isExpanded() && "bg-info text-primary-foreground hover:bg-info/90"
                          )}
                          onClick={(e) => toggleSubagents(id, e)}
                          onMouseDown={(e) => e.stopPropagation()}
                          title={`${badgeInfo().count} child session${badgeInfo().count > 1 ? 's' : ''} - click to ${isExpanded() ? 'hide' : 'show'}`}
                        >
                          <span class={cn(
                            "flex-shrink-0",
                            badgeInfo().status === "working" && !isActive() && "text-info animate-[badge-pulse_1.5s_ease-in-out_infinite]"
                          )}>{getStatusIndicator(badgeInfo().status)}</span>
                          <span class="font-medium">{badgeInfo().count}</span>
                          <ChevronDown class={cn("w-3 h-3 transition-transform", isExpanded() && "rotate-180")} />
                        </button>
                      )}
                    </Show>

                    <span
                      class={cn(
                        "opacity-40 hover:opacity-100 rounded p-0.5 transition-all cursor-pointer",
                        "focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-info",
                        "group-hover:opacity-70",
                        isActive()
                          ? "opacity-60 hover:bg-white/30"
                          : "hover:bg-destructive hover:text-destructive-foreground"
                      )}
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
            class="inline-flex items-center gap-1 px-2 h-7 rounded text-xs transition-colors flex-shrink-0 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-info focus-visible:ring-offset-background"
            onClick={props.onNew}
            title="New session (Cmd+Shift+N)"
            aria-label="New session"
          >
            <Plus class="w-4 h-4" />
            <span class="hidden sm:inline">New</span>
          </button>
        </div>
      </div>

      {/* Right scroll arrow */}
      <Show when={showRightArrow()}>
        <button
          class="flex items-center justify-center w-5 h-5 rounded transition-colors flex-shrink-0 ml-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={scrollRight}
          aria-label="Scroll sessions right"
        >
          <ChevronRight class="w-4 h-4" />
        </button>
      </Show>

      {/* Right sidebar toggle */}
      <Show when={controls()}>
        {(ctrl) => (
          <button
            class={cn(
              "inline-flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors flex-shrink-0 ml-1",
              ctrl().rightDisabled && "opacity-30 pointer-events-none"
            )}
            onClick={() => ctrl().onRightToggle()}
            aria-label={ctrl().rightLabel}
            disabled={ctrl().rightDisabled}
          >
            {ctrl().rightIcon === "open" ? <PanelRightOpen class="w-4 h-4" /> : <PanelRightClose class="w-4 h-4" />}
          </button>
        )}
      </Show>
    </div>
  )
}

export default SessionTabs
