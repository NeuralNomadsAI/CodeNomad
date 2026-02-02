import { Component, For, Show, createMemo, createSignal } from "solid-js"
import { Plus, Trash2 } from "lucide-solid"
import type { Session } from "../../types/session"
import { getSessionStatus } from "../../stores/session-status"
import { setActiveMobileTab } from "../../stores/mobile-nav"
import { cn } from "../../lib/cn"

interface MobileSessionListProps {
  instanceId: string
  sessions: Map<string, Session>
  activeSessionId: string | null
  onSelect: (sessionId: string) => void
  onNew: () => void
  onClose?: (sessionId: string) => void
}

type TimeGroup = { label: string; sessions: Session[] }

function getTimeGroupLabel(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const day = 1000 * 60 * 60 * 24

  if (diff < day) return "Today"
  if (diff < day * 2) return "Yesterday"
  if (diff < day * 7) return "This Week"
  return "Older"
}

function groupByTime(sessions: Session[]): TimeGroup[] {
  const groups = new Map<string, Session[]>()
  const order = ["Today", "Yesterday", "This Week", "Older"]

  for (const session of sessions) {
    const ts = session.time?.updated ?? session.time?.created ?? 0
    const label = getTimeGroupLabel(ts)
    const group = groups.get(label) ?? []
    group.push(session)
    groups.set(label, group)
  }

  return order
    .filter((label) => groups.has(label))
    .map((label) => ({
      label,
      sessions: groups.get(label)!.sort((a, b) => {
        const ta = a.time?.updated ?? a.time?.created ?? 0
        const tb = b.time?.updated ?? b.time?.created ?? 0
        return tb - ta
      }),
    }))
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

const StatusIndicator: Component<{ instanceId: string; sessionId: string; session: Session }> = (props) => {
  const status = () => getSessionStatus(props.instanceId, props.sessionId)

  const dotClass = () => {
    const s = status()
    if (s === "working") return "bg-info animate-activity-dot-pulse"
    if (s === "compacting") return "bg-violet-500 animate-activity-dot-pulse"
    if (props.session.pendingPermission) return "bg-warning"
    return "bg-muted-foreground/70"
  }

  return <span class={cn("w-2 h-2 rounded-full shrink-0", dotClass())} />
}

const statusLabel = (instanceId: string, sessionId: string, session: Session): string => {
  const s = getSessionStatus(instanceId, sessionId)
  if (s === "working") return "Working..."
  if (s === "compacting") return "Compacting..."
  if (session.pendingPermission) return "Permission needed"
  return "Idle"
}

const DELETE_REVEAL_WIDTH = 80
const SWIPE_THRESHOLD = 50
const ANGLE_THRESHOLD_DEG = 30

/** Swipeable session row with delete reveal */
const SwipeableSessionRow: Component<{
  session: Session
  instanceId: string
  isActive: boolean
  onSelect: () => void
  onClose?: () => void
}> = (props) => {
  const [offsetX, setOffsetX] = createSignal(0)
  const [revealed, setRevealed] = createSignal(false)
  const [isSwiping, setIsSwiping] = createSignal(false)

  let startX = 0
  let startY = 0
  let tracking = false
  let directionLocked: "horizontal" | "vertical" | null = null
  let rowRef: HTMLDivElement | undefined

  function handleTouchStart(e: TouchEvent) {
    const touch = e.touches[0]
    if (!touch) return
    startX = touch.clientX
    startY = touch.clientY
    tracking = true
    directionLocked = null
    setIsSwiping(true)
  }

  function handleTouchMove(e: TouchEvent) {
    if (!tracking) return
    const touch = e.touches[0]
    if (!touch) return

    const deltaX = touch.clientX - startX
    const deltaY = touch.clientY - startY

    if (!directionLocked) {
      const absDx = Math.abs(deltaX)
      const absDy = Math.abs(deltaY)
      if (absDx < 5 && absDy < 5) return
      const angleDeg = Math.atan2(absDy, absDx) * (180 / Math.PI)
      if (angleDeg > ANGLE_THRESHOLD_DEG) {
        directionLocked = "vertical"
        tracking = false
        setIsSwiping(false)
        return
      }
      directionLocked = "horizontal"
    }

    if (directionLocked === "horizontal") {
      e.preventDefault()
      // Only allow swiping left (negative deltaX), clamp to delete button width
      const clamped = Math.max(Math.min(deltaX + (revealed() ? -DELETE_REVEAL_WIDTH : 0), 0), -DELETE_REVEAL_WIDTH)
      setOffsetX(clamped)
    }
  }

  function handleTouchEnd() {
    setIsSwiping(false)

    if (!tracking || directionLocked !== "horizontal") {
      tracking = false
      directionLocked = null
      return
    }

    const current = offsetX()
    if (Math.abs(current) > SWIPE_THRESHOLD) {
      setOffsetX(-DELETE_REVEAL_WIDTH)
      setRevealed(true)
    } else {
      setOffsetX(0)
      setRevealed(false)
    }

    tracking = false
    directionLocked = null
  }

  function handleDelete() {
    setOffsetX(0)
    setRevealed(false)
    props.onClose?.()
  }

  function handleClick() {
    if (revealed()) {
      setOffsetX(0)
      setRevealed(false)
      return
    }
    props.onSelect()
  }

  const ts = props.session.time?.updated ?? props.session.time?.created ?? 0

  return (
    <div class="relative overflow-hidden border-b border-border/50" ref={rowRef}>
      {/* Delete button behind the row */}
      <Show when={props.onClose}>
        <div
          class="absolute inset-y-0 right-0 flex items-center justify-center bg-destructive text-destructive-foreground"
          style={{ width: `${DELETE_REVEAL_WIDTH}px` }}
        >
          <button
            type="button"
            class="flex flex-col items-center gap-1 w-full h-full justify-center"
            onClick={handleDelete}
            aria-label="Delete session"
          >
            <Trash2 class="w-5 h-5" />
            <span class="text-xs font-medium">Delete</span>
          </button>
        </div>
      </Show>

      {/* Sliding row content */}
      <div
        class="relative bg-background transition-transform"
        style={{
          transform: `translateX(${offsetX()}px)`,
          "transition-duration": isSwiping() ? "0ms" : "200ms",
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <button
          type="button"
          class={cn(
            "w-full flex items-start gap-3 px-4 py-3 text-left transition-colors",
            props.isActive ? "bg-accent/50" : "hover:bg-accent/30 active:bg-accent/40"
          )}
          onClick={handleClick}
        >
          <div class="pt-1.5">
            <StatusIndicator instanceId={props.instanceId} sessionId={props.session.id} session={props.session} />
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-foreground truncate">
              {props.session.title || "Untitled Session"}
            </div>
            <div class="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
              <span>{props.session.model?.modelId ?? "unknown"}</span>
              <span class="text-border">&middot;</span>
              <span>{formatTimeAgo(ts)}</span>
            </div>
            <div class="text-xs text-muted-foreground mt-0.5">
              {statusLabel(props.instanceId, props.session.id, props.session)}
            </div>
          </div>
        </button>
      </div>
    </div>
  )
}

const MobileSessionList: Component<MobileSessionListProps> = (props) => {
  const parentSessions = createMemo(() => {
    const list: Session[] = []
    for (const session of props.sessions.values()) {
      if (session.parentId === null) {
        list.push(session)
      }
    }
    return list
  })

  const timeGroups = createMemo(() => groupByTime(parentSessions()))

  const handleSelect = (sessionId: string) => {
    props.onSelect(sessionId)
    setActiveMobileTab("chat")
  }

  return (
    <div class="flex flex-col h-full" data-testid="mobile-session-list">
      {/* Header */}
      <div class="flex items-center justify-between px-4 py-3 border-b border-border">
        <h2 class="text-lg font-semibold text-foreground">Sessions</h2>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 px-4 min-h-[44px] rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80 transition-colors"
          onClick={() => {
            props.onNew()
            setActiveMobileTab("chat")
          }}
        >
          <Plus class="w-4 h-4" />
          New
        </button>
      </div>

      {/* Session list */}
      <div class="flex-1 overflow-y-auto">
        <Show
          when={parentSessions().length > 0}
          fallback={
            <div class="flex items-center justify-center h-32 text-muted-foreground text-sm">
              No sessions yet
            </div>
          }
        >
          <For each={timeGroups()}>
            {(group) => (
              <div>
                <div class="px-4 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider bg-secondary/50">
                  {group.label}
                </div>
                <For each={group.sessions}>
                  {(session) => (
                    <SwipeableSessionRow
                      session={session}
                      instanceId={props.instanceId}
                      isActive={props.activeSessionId === session.id}
                      onSelect={() => handleSelect(session.id)}
                      onClose={props.onClose ? () => props.onClose!(session.id) : undefined}
                    />
                  )}
                </For>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}

export default MobileSessionList
