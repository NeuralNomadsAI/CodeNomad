import { Show, createEffect, createMemo, createSignal, onCleanup, on, type Component, type Accessor } from "solid-js"
import { Virtualizer } from "virtua/solid"
import MessagePreview from "./message-preview"
import { messageStoreBus } from "@/stores/message-v2/bus"
import type { TimelineSegment } from "./timeline/timeline-builder"
import { TimelineSegmentItem } from "./timeline/timeline-segment-item"
import { TimelineXRayOverlay } from "./timeline/timeline-xray-overlay"
import { useTimelineTokens } from "./timeline/use-timeline-tokens"
import { useI18n } from "@/lib/i18n"
import type { DeleteHoverState } from "@/types/delete-hover"

export type { TimelineSegment, TimelineSegmentType } from "./timeline/timeline-builder"
export { buildTimelineSegments } from "./timeline/timeline-builder"

interface MessageTimelineProps {
  segments: TimelineSegment[]
  onSegmentClick?: (segment: TimelineSegment) => void
  onToggleSelection?: (id: string) => void
  onLongPressSelection?: (segment: TimelineSegment) => void
  onSelectRange?: (id: string) => void
  onClearSelection?: () => void
  selectedIds?: Accessor<Set<string>>
  expandedMessageIds?: Accessor<Set<string>>
  deletableMessageIds?: Accessor<Set<string>>
  activeSegmentId?: string | null
  instanceId: string
  sessionId: string
  showToolSegments?: boolean
  deleteHover?: () => DeleteHoverState
  onDeleteHoverChange?: (state: DeleteHoverState) => void
  onDeleteMessagesUpTo?: (messageId: string) => void | Promise<void>
  selectedMessageIds?: () => Set<string>
  onToggleSelectedMessage?: (messageId: string, selected: boolean) => void
}

const MessageTimeline: Component<MessageTimelineProps> = (props) => {
  const { t } = useI18n()
  const buttonRefs = new Map<string, HTMLButtonElement>()
  const store = () => messageStoreBus.getOrCreate(props.instanceId)
  
  const [hoveredSegment, setHoveredSegment] = createSignal<TimelineSegment | null>(null)
  const [tooltipCoords, setTooltipCoords] = createSignal({ top: 0, left: 0 })
  const [hoverAnchorRect, setHoverAnchorRect] = createSignal<{ top: number; left: number; width: number; height: number } | null>(null)
  const [tooltipSize, setTooltipSize] = createSignal({ width: 360, height: 420 })
  const [tooltipElement, setTooltipElement] = createSignal<HTMLDivElement | null>(null)
  
  let hoverTimer: number | null = null
  let closeTimer: number | null = null
  let scrollContainerRef: HTMLDivElement | undefined

  const showTools = () => props.showToolSegments ?? true
  const deleteHover = () => props.deleteHover?.() ?? { kind: "none" as const }
  const isSelectionActive = createMemo(() => (props.selectedIds?.().size ?? 0) > 0)

  // Use the extracted tokens hook for XRay data
  const tokensInfo = useTimelineTokens(
    () => props.segments,
    isSelectionActive,
    store,
    props.expandedMessageIds,
    props.deletableMessageIds
  )

  const clearHoverTimer = () => {
    if (hoverTimer !== null && typeof window !== "undefined") {
      window.clearTimeout(hoverTimer)
      hoverTimer = null
    }
  }

  const clearCloseTimer = () => {
    if (closeTimer !== null && typeof window !== "undefined") {
      window.clearTimeout(closeTimer)
      closeTimer = null
    }
  }

  const scheduleClose = () => {
    if (typeof window === "undefined") return
    clearHoverTimer()
    clearCloseTimer()
    closeTimer = window.setTimeout(() => {
      closeTimer = null
      setHoveredSegment(null)
      setHoverAnchorRect(null)
    }, 160)
  }

  const handleMouseEnter = (segment: TimelineSegment, event: MouseEvent) => {
    if (typeof window === "undefined") return
    clearHoverTimer()
    clearCloseTimer()
    const target = event.currentTarget as HTMLButtonElement
    hoverTimer = window.setTimeout(() => {
      const rect = target.getBoundingClientRect()
      setHoverAnchorRect({ top: rect.top, left: rect.left, width: rect.width, height: rect.height })
      setHoveredSegment(segment)
    }, 200)
  }

  const handleMouseLeave = () => scheduleClose()

  createEffect(() => {
    if (typeof window === "undefined") return
    const anchor = hoverAnchorRect()
    const segment = hoveredSegment()
    if (!anchor || !segment) return
    const { width, height } = tooltipSize()
    const verticalGap = 16
    const horizontalGap = 16
    const preferredTop = anchor.top + anchor.height / 2 - height / 2
    const maxTop = window.innerHeight - height - verticalGap
    const clampedTop = Math.min(maxTop, Math.max(verticalGap, preferredTop))
    const preferredLeft = anchor.left - width - horizontalGap
    const clampedLeft = Math.max(horizontalGap, preferredLeft)
    setTooltipCoords({ top: clampedTop, left: clampedLeft })
  })

  onCleanup(() => {
    clearHoverTimer()
    clearCloseTimer()
  })

  createEffect(() => {
    props.expandedMessageIds?.()
  })

  createEffect(on(() => props.activeSegmentId, (activeId) => {
    if (!activeId) return
    const element = buttonRefs.get(activeId)
    if (!element) return
    const timer = typeof window !== "undefined" ? window.setTimeout(() => {
      element.scrollIntoView({ block: "nearest", behavior: "smooth" })
    }, 120) : null
    onCleanup(() => {
      if (timer !== null && typeof window !== "undefined") {
        window.clearTimeout(timer)
      }
    })
  }))

  createEffect(() => {
    const element = tooltipElement()
    if (!element || typeof window === "undefined") return
    const updateSize = () => {
      const rect = element.getBoundingClientRect()
      setTooltipSize({ width: rect.width, height: rect.height })
    }
    updateSize()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => updateSize())
    observer.observe(element)
    onCleanup(() => observer.disconnect())
  })

  const previewData = createMemo(() => {
    const segment = hoveredSegment()
    return segment && store().getMessage(segment.messageId) ? { messageId: segment.messageId } : null
  })

  const messagesWithTools = createMemo(() => {
    return props.segments.reduce((acc, s) => {
      if (s.type === "tool") acc.add(s.messageId)
      return acc
    }, new Set<string>())
  })

  const messageIdToSessionIndex = createMemo(() => {
    const ids = store().getSessionMessageIds(props.sessionId)
    return ids.reduce((map, id, index) => {
      map.set(id, index)
      return map
    }, new Map<string, number>())
  })
  
  const handleContextMenu = (e: MouseEvent) => {
     // handled in child internally, parent fallback
  }

  const viewStates = createMemo(() => {
    const hover = deleteHover()
    const selectionActive = isSelectionActive()
    const indexMap = messageIdToSessionIndex()
    const activeSegmentId = props.activeSegmentId
    const selectedIds = props.selectedIds?.() ?? new Set()
    const expandedIds = props.expandedMessageIds?.() ?? new Set()
    const deleteSelectedIds = props.selectedMessageIds?.() ?? new Set()
    const resolvedStore = store()
    const toolsEnabled = showTools()
    const toolsSet = messagesWithTools()

    return props.segments.reduce((acc, segment, idx) => {
      const isActive = activeSegmentId === segment.id
      const isSelected = selectedIds.has(segment.id)
      const isDeleteSelected = deleteSelectedIds.has(segment.messageId)
      
      const isDeleteHovered = hover.kind === "message" 
        ? hover.messageId === segment.messageId
        : hover.kind === "deleteUpTo" 
          ? (indexMap.get(segment.messageId) ?? -1) >= (indexMap.get(hover.messageId) ?? Infinity)
          : false

      const hasActivePermission = segment.type === "tool" && Boolean(segment.toolPartIds?.some(partId => 
        resolvedStore.getPermissionState(segment.messageId, partId)?.active
      ))

      const isExpanded = expandedIds.has(segment.messageId)
      const isHidden = segment.type === "tool" && !(toolsEnabled || isExpanded || selectionActive || isActive || hasActivePermission || isDeleteHovered || isDeleteSelected)

      const groupRole = segment.type === "tool" ? "child" 
        : (segment.type === "assistant" && toolsSet.has(segment.messageId) ? "parent" : "none")

      const prev = idx > 0 ? props.segments[idx - 1] : null
      const isGroupStart = segment.type === "tool" && (!prev || prev.type !== "tool" || prev.messageId !== segment.messageId)

      acc.set(segment.id, {
        isActive,
        isSelected,
        isDeleteHovered,
        isDeleteSelected,
        hasActivePermission,
        isExpanded,
        isHidden,
        groupRole,
        isGroupStart,
      })
      return acc
    }, new Map<string, any>())
  })

  return (
    <div class="message-timeline-container">
      <div
        ref={scrollContainerRef}
        class={`message-timeline${isSelectionActive() ? " message-timeline--selection-active" : ""}`}
        role="navigation"
        aria-label={t("messageTimeline.ariaLabel")}
      >
        <Virtualizer data={props.segments}>
          {(segment) => {
            onCleanup(() => buttonRefs.delete(segment.id))
            const state = () => viewStates().get(segment.id)

            return (
              <TimelineSegmentItem
                segment={segment}
                isFirstInGroup={state()?.isGroupStart ?? false}
                groupRole={state()?.groupRole ?? "none"}
                isActive={state()?.isActive ?? false}
                isSelected={state()?.isSelected ?? false}
                isMultiSelectActive={isSelectionActive()}
                isExpanded={state()?.isExpanded ?? false}
                isHidden={state()?.isHidden ?? false}
                hasActivePermission={state()?.hasActivePermission ?? false}
                isDeleteHovered={state()?.isDeleteHovered ?? false}
                isDeleteSelected={state()?.isDeleteSelected ?? false}
                scrollContainerRef={scrollContainerRef}
                registerRef={(id, el) => {
                  if (el) {
                    buttonRefs.set(id, el)
                  } else {
                    buttonRefs.delete(id)
                  }
                }}
                onSegmentClick={(s) => props.onSegmentClick?.(s)}
                onSelectRange={(id) => props.onSelectRange?.(id)}
                onToggleSelection={(id) => props.onToggleSelection?.(id)}
                onLongPressSelection={props.onLongPressSelection}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                onContextMenu={handleContextMenu}
              />
            )
          }}
        </Virtualizer>
        
        <Show when={previewData()}>
          {(data) => {
            onCleanup(() => setTooltipElement(null))
            return (
              <div
                ref={setTooltipElement}
                class="message-timeline-tooltip"
                style={{ top: `${tooltipCoords().top}px`, left: `${tooltipCoords().left}px` }}
                onMouseEnter={clearCloseTimer}
                onMouseLeave={scheduleClose}
              >
                <MessagePreview
                  messageId={data().messageId}
                  instanceId={props.instanceId}
                  sessionId={props.sessionId}
                  store={store}
                  deleteHover={props.deleteHover}
                  onDeleteHoverChange={props.onDeleteHoverChange}
                  onDeleteMessagesUpTo={props.onDeleteMessagesUpTo}
                  selectedMessageIds={props.selectedMessageIds}
                />
              </div>
            )
          }}
        </Show>
      </div>

      <TimelineXRayOverlay
        isSelectionActive={isSelectionActive()}
        xraySegments={tokensInfo.xraySegments()}
        getSegmentTokens={tokensInfo.getSegmentTokens}
        getMessageAggregateTokens={tokensInfo.getMessageAggregateTokens}
        maxTokens={tokensInfo.maxTokens()}
        formatTokenLabel={tokensInfo.formatTokenLabel}
        scrollContainerRef={scrollContainerRef}
      />
    </div>
  )
}

export default MessageTimeline
