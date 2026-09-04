import { Show, createEffect, createMemo, createSignal, onCleanup, on, type Component, type Accessor } from "solid-js"
import { Virtualizer, type VirtualizerHandle } from "virtua/solid"
import { Portal } from "solid-js/web"
import MessagePreview from "./message-preview"
import { messageStoreBus } from "../stores/message-v2/bus"
import type { ClientPart } from "../types/message"
import { isHiddenSyntheticTextPart } from "../types/message"
import type { MessageRecord } from "../stores/message-v2/types"
import { buildRecordDisplayData } from "../stores/message-v2/record-display-cache"
import { getPartCharCount } from "../lib/token-utils"
import { getToolIcon } from "./tool-call/utils"
import { User as UserIcon, Bot as BotIcon, FoldVertical, ShieldAlert } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { getBottomAnchoredViewportOffset } from "./virtual-follow-behavior"

export type TimelineSegmentType = "user" | "assistant" | "tool" | "compaction"

export interface TimelineSegment {
  id: string
  messageId: string
  type: TimelineSegmentType
  label: string
  tooltip: string
  shortLabel?: string
  variant?: "auto" | "manual"
  toolPartIds?: string[]
  partIds?: string[]
  partId?: string
  totalChars: number
}

interface MessageTimelineProps {
  segments: TimelineSegment[]
  onSegmentClick?: (segment: TimelineSegment) => void
  expandedMessageIds?: Accessor<Set<string>>
  activeSegmentId?: string | null
  instanceId: string
  sessionId: string
  showToolSegments?: boolean
  searchMatchedSegmentIds?: Accessor<Set<string>>
  activeSearchSegmentId?: Accessor<string | null>
}

const MAX_TOOLTIP_LENGTH = 220
const TIMELINE_VIRTUALIZER_BUFFER_PX = 240

type ToolCallPart = Extract<ClientPart, { type: "tool" }>

interface PendingSegment {
  type: TimelineSegmentType
  texts: string[]
  reasoningTexts: string[]
  partIds: string[]
  totalChars: number
  hasPrimaryText: boolean
}

interface TimelineSegmentState {
  hasActivePermission: boolean
  hidden: boolean
}

function truncateText(value: string): string {
  if (value.length <= MAX_TOOLTIP_LENGTH) {
    return value
  }
  return `${value.slice(0, MAX_TOOLTIP_LENGTH - 1).trimEnd()}…`
}

function collectReasoningText(part: ClientPart): string {
  const stringifySegment = (segment: unknown): string => {
    if (typeof segment === "string") {
      return segment
    }
    if (segment && typeof segment === "object") {
      const obj = segment as { text?: unknown; value?: unknown; content?: unknown[] }
      const parts: string[] = []
      if (typeof obj.text === "string") {
        parts.push(obj.text)
      }
      if (typeof obj.value === "string") {
        parts.push(obj.value)
      }
      if (Array.isArray(obj.content)) {
        parts.push(obj.content.map((entry) => stringifySegment(entry)).join("\n"))
      }
      return parts.filter(Boolean).join("\n")
    }
    return ""
  }

  if (typeof (part as any)?.text === "string") {
    return (part as any).text
  }
  if (Array.isArray((part as any)?.content)) {
    return (part as any).content.map((entry: unknown) => stringifySegment(entry)).join("\n")
  }
  return ""
}

function collectTextFromPart(part: ClientPart, t: (key: string, params?: Record<string, unknown>) => string): string {
  if (!part) return ""
  if (isHiddenSyntheticTextPart(part)) return ""
  if (typeof (part as any).text === "string") {
    return (part as any).text as string
  }
  if (part.type === "reasoning") {
    return collectReasoningText(part)
  }
  if (Array.isArray((part as any)?.content)) {
    return ((part as any).content as unknown[])
      .map((entry) => (typeof entry === "string" ? entry : ""))
      .filter(Boolean)
      .join("\n")
  }
  if (part.type === "file") {
    const filename = (part as any)?.filename
    return typeof filename === "string" && filename.length > 0
      ? t("messageTimeline.text.filePrefix", { filename })
      : t("messageTimeline.text.attachment")
  }
  return ""
}

function getToolTitle(part: ToolCallPart, t: (key: string, params?: Record<string, unknown>) => string): string {
  const metadata = (((part as unknown as { state?: { metadata?: unknown } })?.state?.metadata) || {}) as { title?: unknown }
  const title = typeof metadata.title === "string" && metadata.title.length > 0 ? metadata.title : undefined
  if (title) return title
  if (typeof part.tool === "string" && part.tool.length > 0) {
    return part.tool
  }
  return t("messageTimeline.tool.fallbackLabel")
}

function getToolTypeLabel(part: ToolCallPart, t: (key: string, params?: Record<string, unknown>) => string): string {
  if (typeof part.tool === "string" && part.tool.trim().length > 0) {
    return part.tool.trim().slice(0, 4)
  }
  return t("messageTimeline.tool.fallbackLabel").slice(0, 4)
}

function formatTextsTooltip(texts: string[], fallback: string): string {
  const combined = texts
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n")
  if (combined.length > 0) {
    return truncateText(combined)
  }
  return fallback
}

function formatToolTooltip(
  titles: string[],
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  if (titles.length === 0) {
    return t("messageTimeline.tool.fallbackLabel")
  }
  return truncateText(`${t("messageTimeline.tool.fallbackLabel")}: ${titles.join(", ")}`)
}

export function buildTimelineSegments(
  instanceId: string,
  record: MessageRecord,
  t: (key: string, params?: Record<string, unknown>) => string,
): TimelineSegment[] {
  if (!record) return []
  const { orderedParts } = buildRecordDisplayData(instanceId, record)
  if (!orderedParts || orderedParts.length === 0) {
    return []
  }

  const segmentLabel = (type: TimelineSegmentType) => {
    if (type === "user") return t("messageTimeline.segment.user.label")
    if (type === "assistant") return t("messageTimeline.segment.assistant.label")
    if (type === "compaction") return t("messageTimeline.segment.compaction.label")
    return t("messageTimeline.tool.fallbackLabel").slice(0, 4)
  }

  const result: TimelineSegment[] = []
  let segmentIndex = 0
  let pending: PendingSegment | null = null
  const flushPending = () => {
    if (!pending) return
    if (pending.type === "assistant" && !pending.hasPrimaryText) {
      pending = null
      return
    }
    const label = segmentLabel(pending.type)
    const shortLabel = undefined
    const tooltip = formatTextsTooltip(
      [...pending.texts, ...pending.reasoningTexts],
      pending.type === "user" ? t("messageTimeline.tooltip.userFallback") : t("messageTimeline.tooltip.assistantFallback"),
    )

    result.push({
      id: `${record.id}:${segmentIndex}`,
      messageId: record.id,
      type: pending.type,
      label,
      tooltip,
      shortLabel,
      partIds: pending.partIds,
      totalChars: pending.totalChars,
    })
    segmentIndex += 1
    pending = null
  }

  const ensureSegment = (type: TimelineSegmentType): PendingSegment => {
    if (!pending || pending.type !== type) {
      flushPending()
      pending = {
        type,
        texts: [],
        reasoningTexts: [],
        partIds: [],
        totalChars: 0,
        hasPrimaryText: type !== "assistant",
      }
    }
    return pending!
  }


  const defaultContentType: TimelineSegmentType = record.role === "user" ? "user" : "assistant"

  for (const part of orderedParts) {
    if (!part || typeof part !== "object") continue

    if (part.type === "tool") {
      flushPending()
      const toolPart = part as ToolCallPart
      const partId = typeof toolPart.id === "string" ? toolPart.id : ""
      const title = getToolTitle(toolPart, t)
      result.push({
        id: `${record.id}:${segmentIndex}`,
        messageId: record.id,
        type: "tool",
        label: getToolTypeLabel(toolPart, t) || segmentLabel("tool"),
        tooltip: formatToolTooltip([title], t),
        shortLabel: getToolIcon(typeof toolPart.tool === "string" ? toolPart.tool : "tool"),
        toolPartIds: partId ? [partId] : undefined,
        totalChars: getPartCharCount(part),
      })
      segmentIndex += 1
      continue
    }

    if (part.type === "reasoning") {
      const text = collectReasoningText(part)
      if (text.trim().length === 0) continue
      const target = ensureSegment(defaultContentType)
      if (target) {
        target.reasoningTexts.push(text)
        if (typeof (part as any).id === "string" && (part as any).id.length > 0) {
          target.partIds.push((part as any).id)
        }
        target.totalChars += getPartCharCount(part)
      }
      continue
    }

    if (part.type === "compaction") {
      flushPending()
      const isAuto = Boolean((part as any)?.auto)
      const partId = typeof (part as any)?.id === "string" ? ((part as any).id as string) : ""
      result.push({
        id: `${record.id}:${segmentIndex}`,
        messageId: record.id,
        type: "compaction",
        label: segmentLabel("compaction"),
        tooltip: isAuto ? t("messageTimeline.tooltip.compaction.auto") : t("messageTimeline.tooltip.compaction.manual"),
        variant: isAuto ? "auto" : "manual",
        partId,
        totalChars: 0,
      })
      segmentIndex += 1
      continue
    }

    if (part.type === "step-start" || part.type === "step-finish") {
      continue
    }

    const text = collectTextFromPart(part, t)
    if (text.trim().length === 0) continue
    const target = ensureSegment(defaultContentType)
    if (target) {
      target.texts.push(text)
      target.hasPrimaryText = true
      if (typeof (part as any).id === "string" && (part as any).id.length > 0) {
        target.partIds.push((part as any).id)
      }
      target.totalChars += getPartCharCount(part)
    }
  }


  flushPending()

  return result
}

const MessageTimeline: Component<MessageTimelineProps> = (props) => {
  const { t } = useI18n()
  const store = () => messageStoreBus.getOrCreate(props.instanceId)
  const [hoveredSegment, setHoveredSegment] = createSignal<TimelineSegment | null>(null)
  const [tooltipCoords, setTooltipCoords] = createSignal<{ top: number; left: number }>({ top: 0, left: 0 })
  const [hoverAnchorRect, setHoverAnchorRect] = createSignal<{ top: number; left: number; width: number; height: number } | null>(null)
  const [tooltipSize, setTooltipSize] = createSignal<{ width: number; height: number }>({ width: 360, height: 420 })
  const [tooltipElement, setTooltipElement] = createSignal<HTMLDivElement | null>(null)
  let hoverTimer: number | null = null
  let closeTimer: number | null = null
  const showTools = () => props.showToolSegments ?? true
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
    const clampedTop = Math.min(maxTop, Math.max(verticalGap, preferredTop))
    const preferredLeft = anchor.left - width - horizontalGap
    const clampedLeft = Math.max(horizontalGap, preferredLeft)
    setTooltipCoords({ top: clampedTop, left: clampedLeft })
  })

  onCleanup(() => {
    clearHoverPreview()
  })

  const [scrollElement, setScrollElement] = createSignal<HTMLDivElement | undefined>()
  const [virtualizerHandle, setVirtualizerHandle] = createSignal<VirtualizerHandle | undefined>()

  const handleScroll = () => {
    if (hoveredSegment()) clearHoverPreview()
  }

  createEffect(on(() => props.activeSegmentId, (activeId) => {
    if (!activeId) return
    const timer = typeof window !== "undefined" ? window.setTimeout(() => {
      const index = segmentIndexById().get(activeId)
      if (index !== undefined) virtualizerHandle()?.scrollToIndex(index, { align: "nearest", smooth: true })
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

  createEffect(() => {
    const element = scrollElement()
    if (!element || typeof ResizeObserver === "undefined") return
    let previousHeight = element.clientHeight
    let pendingHeightDelta = 0
    let pendingFrame: number | null = null
    const observer = new ResizeObserver(() => {
      const nextHeight = element.clientHeight
      if (nextHeight === previousHeight) return
      if (previousHeight <= 0 || nextHeight <= 0) {
        previousHeight = nextHeight
        return
      }
      pendingHeightDelta += previousHeight - nextHeight
      previousHeight = nextHeight
      if (pendingFrame !== null) return
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = null
        const handle = virtualizerHandle()
        const offset = getBottomAnchoredViewportOffset(handle?.scrollOffset ?? element.scrollTop, pendingHeightDelta)
        pendingHeightDelta = 0
        const maxOffset = Math.max((handle?.scrollSize ?? element.scrollHeight) - (handle?.viewportSize ?? element.clientHeight), 0)
        if (handle) handle.scrollTo(Math.min(offset, maxOffset))
        else element.scrollTop = Math.min(offset, maxOffset)
      })
    })
    observer.observe(element)
    onCleanup(() => {
      observer.disconnect()
      if (pendingFrame !== null) cancelAnimationFrame(pendingFrame)
    })
  })

  const previewData = createMemo(() => {
    const segment = hoveredSegment()
    if (!segment) return null
    const record = store().getMessage(segment.messageId)
    if (!record) return null
    return { messageId: segment.messageId }
  })

  // Pre-computed set of messageIds that have at least one tool segment.
  // Used by groupRole() inside <For> to avoid O(n) .some() per segment → O(1) .has().
  const messagesWithTools = createMemo(() => {
    const set = new Set<string>()
    for (const s of props.segments) {
      if (s.type === "tool") set.add(s.messageId)
    }
    return set
  })

  const segmentIndexById = createMemo(() => {
    const map = new Map<string, number>()
    for (let i = 0; i < props.segments.length; i++) map.set(props.segments[i].id, i)
    return map
  })

  const segmentStates = createMemo(() => {
    const expandedMessages = props.expandedMessageIds?.()
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

      const hidden = segment.type === "tool" && !(
        showTools()
        || expandedMessages?.has(segment.messageId)
        || props.activeSegmentId === segment.id
        || hasActivePermission
      )

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

  const segmentSpacerHeights = createMemo(() => {
    const states = segmentStates()
    const result = new Map<string, string>()
    let previousVisible: TimelineSegment | null = null

    for (let index = 0; index < props.segments.length; index += 1) {
      const segment = props.segments[index]
      const state = states.get(segment.id)

      if (state?.hidden) {
        result.set(segment.id, "0")
        continue
      }

      if (!previousVisible) {
        result.set(segment.id, "0")
        previousVisible = segment
        continue
      }

      const previousRaw = index > 0 ? props.segments[index - 1] : null
      const startsVisibleToolGroup = segment.type === "tool"
        && (previousVisible.type !== "tool" || previousVisible.messageId !== segment.messageId)
      const startsCollapsedToolGroup = segment.type === "assistant"
        && previousVisible.messageId !== segment.messageId
        && messagesWithTools().has(segment.messageId)
        && previousRaw?.type === "tool"
        && previousRaw.messageId === segment.messageId
      const followsVisibleGroupParent = (segment.type === "user" || segment.type === "compaction")
        && previousVisible.type === "assistant"
        && messagesWithTools().has(previousVisible.messageId)

      const gapUnits = 1 + (startsVisibleToolGroup || startsCollapsedToolGroup || followsVisibleGroupParent ? 1 : 0)
      result.set(
        segment.id,
        gapUnits === 1
          ? "var(--message-timeline-segment-gap)"
          : "calc(var(--message-timeline-segment-gap) * 2)",
      )

      previousVisible = segment
    }

    return result
  })

  return (
    <div class="message-timeline-container">
      <div
        ref={(element) => {
          setScrollElement(element)
        }}
        class="message-timeline"
        role="navigation"
        aria-label={t("messageTimeline.ariaLabel")}
        onScroll={handleScroll}
      >
        <Virtualizer ref={setVirtualizerHandle} data={props.segments} scrollRef={scrollElement()} bufferSize={TIMELINE_VIRTUALIZER_BUFFER_PX}>
          {(segment) => {
            const isActive = () => props.activeSegmentId === segment.id
            const isSearchMatch = () => props.searchMatchedSegmentIds?.().has(segment.id) ?? false
            const isActiveSearchMatch = () => props.activeSearchSegmentId?.() === segment.id
            const state = () => segmentStateFor(segment.id)
            const hasActivePermission = () => state().hasActivePermission
            const isHidden = () => state().hidden

            // Group visual indicators: tools belong to the same message as their
            // assistant.  Uses messageId for correctness (not positional adjacency).
            const groupRole = (): "child" | "parent" | "none" => {
              if (segment.type === "tool") return "child"
              if (segment.type === "assistant" && messagesWithTools().has(segment.messageId)) return "parent"
              return "none"
            }

            const shortLabelContent = () => {
              if (segment.type === "tool") {
                if (hasActivePermission()) {
                  return <ShieldAlert class="message-timeline-icon" aria-hidden="true" />
                }
                return segment.shortLabel ?? getToolIcon("tool")
              }
              if (segment.type === "compaction") {
                return <FoldVertical class="message-timeline-icon" aria-hidden="true" />
              }
              if (segment.type === "user") {
                return <UserIcon class="message-timeline-icon" aria-hidden="true" />
              }
              return <BotIcon class="message-timeline-icon" aria-hidden="true" />
            }

              return (
              <div class="message-timeline-item">
                <div aria-hidden="true" class="message-timeline-item-spacer" style={{ height: segmentSpacerHeights().get(segment.id) ?? "0" }} />
                <button
                    type="button"
                    data-variant={segment.variant}
                  class={`message-timeline-segment message-timeline-${segment.type} ${hasActivePermission() ? "message-timeline-segment-permission" : ""} ${segment.type === "compaction" ? `message-timeline-compaction-${segment.variant ?? "manual"}` : ""} ${isActive() ? "message-timeline-segment-active" : ""} ${isHidden() ? "message-timeline-segment-hidden" : ""} ${isSearchMatch() ? "message-timeline-segment-search-match" : ""} ${isActiveSearchMatch() ? "message-timeline-segment-search-active" : ""} ${groupRole() !== "none" ? `message-timeline-group-${groupRole()}` : ""}`}
                  aria-current={isActive() ? "true" : undefined}
                  aria-hidden={isHidden() ? "true" : undefined}
                    onClick={() => props.onSegmentClick?.(segment)}
                  onMouseEnter={(event) => handleMouseEnter(segment, event)}
                  onMouseLeave={handleMouseLeave}
                >
                  <span class="message-timeline-label message-timeline-label-full">{segment.label}</span>
                  <span class="message-timeline-label message-timeline-label-short">{shortLabelContent()}</span>
                </button>
              </div>
            )
          }}
        </Virtualizer>
        <Show when={previewData()}>
          {(data) => {
            onCleanup(() => setTooltipElement(null))
            return (
              <Portal>
                <div
                  ref={(element) => setTooltipElement(element)}
                  class="message-timeline-tooltip"
                  style={{ top: `${tooltipCoords().top}px`, left: `${tooltipCoords().left}px` }}
                  onMouseEnter={() => clearCloseTimer()}
                  onMouseLeave={() => scheduleClose()}
                >
                  <MessagePreview
                    messageId={data().messageId}
                    instanceId={props.instanceId}
                    sessionId={props.sessionId}
                    store={store}
                  />
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
