import { Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup, on, type Component, type Accessor } from "solid-js"
import TimelineVirtualList, { type TimelineListHandle } from "./timeline-virtual-list"
import { Dynamic, Portal } from "solid-js/web"
import { messageStoreBus } from "../stores/message-v2/bus"
import type { ClientPart } from "../types/message"
import { buildRecordDisplayData } from "../stores/message-v2/record-display-cache"
import { User as UserIcon, Bot as BotIcon, FoldVertical } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { getMessageContentIcon } from "./message-content-icons"
import { Markdown } from "./markdown"
import { createTimelinePreviews } from "../stores/timeline-previews"
import { collectTextFromPart, foldTimelineSegments, getToolTitle, type TimelineSegment, type TimelineSegmentType } from "./message-timeline-projection"

export type { TimelineSegment, TimelineSegmentType }

interface MessageTimelineProps {
  segments: TimelineSegment[]
  onSegmentClick?: (segment: TimelineSegment) => void
  activeSegmentId?: string | null
  instanceId: string
  sessionId: string
  isActive?: boolean
  /** Content hidden in Message content (tool types, thinking, system context) is hidden here too. */
  isSegmentHidden?: (segment: TimelineSegment) => boolean
  searchMatchedSegmentIds?: Accessor<Set<string>>
  activeSearchSegmentId?: Accessor<string | null>
  revealActiveToken?: number
}

type ToolCallPart = Extract<ClientPart, { type: "tool" }>

interface TimelineSegmentState {
  hasActivePermission: boolean
  hidden: boolean
}

const MessageTimeline: Component<MessageTimelineProps> = (props) => {
  const { t } = useI18n()
  const previewId = createUniqueId()
  const store = () => messageStoreBus.getOrCreate(props.instanceId)
  const [hoveredSegment, setHoveredSegment] = createSignal<TimelineSegment | null>(null)
  const [visiblePreviewSegments, setVisiblePreviewSegments] = createSignal<TimelineSegment[]>([])
  const previews = createTimelinePreviews({ instanceId: () => props.instanceId, sessionId: () => props.sessionId,
    active: () => props.isActive !== false,
    requested: () => {
      const visible = visiblePreviewSegments(), center = Math.floor(visible.length / 2)
      const nearby = [...visible].sort((a, b) => Math.abs(visible.indexOf(a) - center) - Math.abs(visible.indexOf(b) - center))
      return [hoveredSegment()?.messageId, ...nearby.map(segment => segment.messageId)].filter((id): id is string => Boolean(id))
    } })
  const previewText = createMemo(() => {
    const segment = hoveredSegment()
    if (!segment || props.isActive === false) return ""
    const record = store().getMessage(segment.messageId)
    if (record) {
      // A loaded marker previews its own block; an indexed one its message's parts of that kind.
      const own = new Set([...segment.partIds ?? [], ...segment.toolPartIds ?? [], ...segment.partId ? [segment.partId] : []])
      const parts = buildRecordDisplayData(props.instanceId, record).orderedParts
      const text = parts.filter(part => own.size ? own.has(part.id ?? "") : segment.type === "tool" ? part.type === "tool"
        : segment.type === "reasoning" ? part.type === "reasoning" : part.type !== "tool" && part.type !== "reasoning")
        .map(part => part.type === "tool" ? `${getToolTitle(part as ToolCallPart, t)}\n${part.state && "output" in part.state && typeof part.state.output === "string" ? part.state.output.slice(0, 4096) : ""}`
          : collectTextFromPart(part, t).slice(0, 4096)).join("\n\n").slice(0, 4096)
      if (text) return text
    }
    // Excerpts carry a message's text and tools, not its thinking.
    if (segment.type === "reasoning") return segment.tooltip
    const preview = previews(segment.messageId)
    return (segment.type === "tool" ? preview?.tools : preview?.text) || segment.tooltip || ""
  })
  const [tooltipCoords, setTooltipCoords] = createSignal<{ top: number; left: number }>({ top: 0, left: 0 })
  const [hoverAnchorRect, setHoverAnchorRect] = createSignal<{ top: number; left: number; width: number; height: number } | null>(null)
  const [tooltipSize, setTooltipSize] = createSignal<{ width: number; height: number }>({ width: 360, height: 120 })
  const [tooltipElement, setTooltipElement] = createSignal<HTMLDivElement | null>(null)
  let hoverTimer: number | null = null
  let closeTimer: number | null = null
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

  const clearHoverPreview = () => {
    clearHoverTimer()
    clearCloseTimer()
    setHoveredSegment(null)
    setHoverAnchorRect(null)
  }

  const scheduleClose = () => {
    if (typeof window === "undefined") return
    clearHoverTimer()
    clearCloseTimer()
    // Small delay so the pointer can travel from the segment to the tooltip.
    closeTimer = window.setTimeout(() => {
      closeTimer = null
      clearHoverPreview()
    }, 160)
  }

  const handleMouseEnter = (segment: TimelineSegment, event: MouseEvent | FocusEvent) => {
    if (typeof window === "undefined") return
    clearHoverTimer()
    clearCloseTimer()
    const target = event.currentTarget as HTMLButtonElement
    hoverTimer = window.setTimeout(() => {
      hoverTimer = null
      if (!target.isConnected) return
      const rect = target.getBoundingClientRect()
      setHoverAnchorRect({ top: rect.top, left: rect.left, width: rect.width, height: rect.height })
      setHoveredSegment(segment)
    }, 200)
  }

  const handleMouseLeave = () => {
    scheduleClose()
  }

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
    const clampedTop = Math.max(verticalGap, Math.min(maxTop, preferredTop))
    const preferredLeft = anchor.left >= width + horizontalGap
      ? anchor.left - width - horizontalGap : anchor.left + anchor.width + horizontalGap
    const clampedLeft = Math.max(horizontalGap, Math.min(window.innerWidth - width - horizontalGap, preferredLeft))
    setTooltipCoords({ top: clampedTop, left: clampedLeft })
  })

  onCleanup(() => {
    clearHoverPreview()
  })

  const [scrollElement, setScrollElement] = createSignal<HTMLDivElement | undefined>()
  const [virtualizerHandle, setVirtualizerHandle] = createSignal<TimelineListHandle | undefined>()
  let browsingRail = false
  const cancelReveal = () => { browsingRail = true }

  const handleScroll = () => {
    clearHoverPreview()
  }
  createEffect(() => { if (props.isActive === false) clearHoverPreview() })

  createEffect(on(() => props.revealActiveToken, () => { browsingRail = false }))
  createEffect(() => {
    props.revealActiveToken
    const activeId = activeVisibleId()
    const index = activeId ? segmentIndexById().get(activeId) : undefined
    const handle = virtualizerHandle()
    // Wait for the exact extent to reach layout, but never queue a reveal past
    // a manual rail gesture or a newer active marker.
    const frame = requestAnimationFrame(() => {
      if (!browsingRail && index !== undefined) handle?.scrollToIndex(index)
    })
    onCleanup(() => cancelAnimationFrame(frame))
  })

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
    window.addEventListener("resize", clearHoverPreview)
    onCleanup(() => { observer.disconnect(); window.removeEventListener("resize", clearHoverPreview) })
  })

  const segmentStates = createMemo(() => {
    const resolvedStore = store()
    const result = new Map<string, TimelineSegmentState>()

    for (const segment of props.segments) {
      let hasActivePermission = false
      if (segment.type === "tool") {
        const partIds = segment.toolPartIds ?? []
        for (const partId of partIds) {
          const permissionState = resolvedStore.getPermissionState(segment.messageId, partId)
          if (permissionState?.active) {
            hasActivePermission = true
            break
          }
        }
      }

      // A marker follows its content (a tool by the type its icon shows); pending permissions stay visible.
      const hidden = !hasActivePermission && Boolean(props.isSegmentHidden?.(segment))

      result.set(segment.id, {
        hasActivePermission,
        hidden,
      })
    }

    return result
  })

  const segmentStateFor = (segmentId: string): TimelineSegmentState => {
    return segmentStates().get(segmentId) ?? {
      hasActivePermission: false,
      hidden: false,
    }
  }

  // The rail keeps the transcript's row boundaries under the same visibility.
  const fold = createMemo(() => foldTimelineSegments(props.segments, segment => segmentStateFor(segment.id).hidden))
  const visibleSegments = () => fold().visible
  const segmentIndexById = createMemo(() => new Map(visibleSegments().map((segment, index) => [segment.id, index])))
  // A folded marker is represented by its row's marker; one whose content is
  // hidden, by its message's first visible marker.
  const messageBySegmentId = createMemo(() => new Map(props.segments.map(segment => [segment.id, segment.messageId])))
  const firstVisibleByMessage = createMemo(() => {
    const result = new Map<string, string>()
    for (const segment of visibleSegments()) if (!result.has(segment.messageId)) result.set(segment.messageId, segment.id)
    return result
  })
  const activeVisibleId = createMemo(() => {
    const requested = props.activeSegmentId
    if (!requested) return null
    const id = fold().representative.get(requested) ?? requested
    if (segmentIndexById().has(id)) return id
    const messageId = messageBySegmentId().get(id)
    return messageId === undefined ? null : firstVisibleByMessage().get(messageId) ?? null
  })
  // One uniform gap between visible markers, none before the first. V2 records
  // each model call as its own message, so message-based group gaps were noise.
  const segmentSpacerHeights = createMemo(() => new Map(visibleSegments().map((segment, index) => [segment.id, index ? 1 : 0])))

  return (
    <div class="message-timeline-container">
      <div
        ref={(element) => {
          setScrollElement(element)
        }}
        class="message-timeline"
        data-segment-count={visibleSegments().length}
        role="navigation"
        tabIndex={0}
        aria-label={t("messageTimeline.ariaLabel")}
        onScroll={handleScroll}
        onWheel={cancelReveal}
        onPointerEnter={cancelReveal}
        onPointerDown={cancelReveal}
        onFocusIn={cancelReveal}
        onTouchStart={cancelReveal}
        onKeyDown={(event) => { cancelReveal(); if (event.key === "Escape") clearHoverPreview() }}
      >
        <TimelineVirtualList register={setVirtualizerHandle} onVisibleItems={setVisiblePreviewSegments} items={visibleSegments()} scrollElement={scrollElement()} gap={segment => segmentSpacerHeights().get(segment.id) ?? 0}>
          {(segment) => {
            const isActive = () => activeVisibleId() === segment.id
            const isSearchMatch = () => props.searchMatchedSegmentIds?.().has(segment.id) ?? false
            const isActiveSearchMatch = () => props.activeSearchSegmentId?.() === segment.id
            const state = () => segmentStateFor(segment.id)
            const hasActivePermission = () => state().hasActivePermission
            const isHidden = () => state().hidden

            const shortLabelContent = () => {
              if (segment.type === "tool") {
                return <Dynamic component={getMessageContentIcon(segment.toolName)} class="message-timeline-icon" aria-hidden="true" />
              }
              if (segment.type === "compaction") {
                return <FoldVertical class="message-timeline-icon" aria-hidden="true" />
              }
              if (segment.type === "reasoning" || segment.type === "system") {
                return <Dynamic component={getMessageContentIcon(segment.type === "reasoning" ? "thinking" : "system")} class="message-timeline-icon" aria-hidden="true" />
              }
              if (segment.type === "user") {
                return <UserIcon class="message-timeline-icon" aria-hidden="true" />
              }
              return <BotIcon class="message-timeline-icon" aria-hidden="true" />
            }

              return (
              <div class="message-timeline-item">
                <button
                    type="button"
                    data-variant={segment.variant}
                  class={`message-timeline-segment message-timeline-${segment.type} ${hasActivePermission() ? "message-timeline-segment-permission" : ""} ${segment.type === "compaction" ? `message-timeline-compaction-${segment.variant ?? "manual"}` : ""} ${isActive() ? "message-timeline-segment-active" : ""} ${isHidden() ? "message-timeline-segment-hidden" : ""} ${isSearchMatch() ? "message-timeline-segment-search-match" : ""} ${isActiveSearchMatch() ? "message-timeline-segment-search-active" : ""}`}
                  aria-current={isActive() ? "true" : undefined}
                  aria-label={segment.tooltip || segment.label}
                   aria-describedby={hoveredSegment()?.id === segment.id && previewText() ? previewId : undefined}
                  data-message-id={segment.messageId}
                  aria-hidden={isHidden() ? "true" : undefined}
                    onClick={() => { clearHoverPreview(); props.onSegmentClick?.(segment) }}
                  onMouseEnter={(event) => handleMouseEnter(segment, event)}
                  onMouseLeave={handleMouseLeave}
                  onFocus={(event) => handleMouseEnter(segment, event)}
                  onBlur={handleMouseLeave}
                >
                  <span class="message-timeline-label message-timeline-label-full">{segment.label}</span>
                  <span class="message-timeline-label message-timeline-label-short">{shortLabelContent()}</span>
                </button>
              </div>
            )
          }}
        </TimelineVirtualList>
        <Show when={hoveredSegment() && previewText()}>
          {(data) => {
            onCleanup(() => setTooltipElement(null))
            return (
              <Portal>
                <div
                  ref={(element) => setTooltipElement(element)}
                  class="message-timeline-tooltip"
                  id={previewId}
                  role="tooltip"
                  style={{ top: `${tooltipCoords().top}px`, left: `${tooltipCoords().left}px` }}
                  onMouseEnter={() => clearCloseTimer()}
                  onMouseLeave={() => scheduleClose()}
                >
                   <Markdown part={{ type: "text", text: data() }} instanceId={props.instanceId} sessionId={props.sessionId}
                     size="sm" disableHighlight escapeRawHtml literalRawHtml={hoveredSegment()?.type === "user"} />
                </div>
              </Portal>
            )
          }}
        </Show>
      </div>

    </div>
  )
}

export default MessageTimeline
