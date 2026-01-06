import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js"
import MessagePreview from "./message-preview"
import { messageStoreBus } from "../stores/message-v2/bus"
import type { ClientPart } from "../types/message"
import type { MessageRecord } from "../stores/message-v2/types"
import { buildRecordDisplayData } from "../stores/message-v2/record-display-cache"
import { getToolIcon } from "./tool-call/utils"
import { User as UserIcon, Bot as BotIcon, FoldVertical } from "lucide-solid"

export type TimelineSegmentType = "user" | "assistant" | "tool" | "compaction"

export interface TimelineSegment {
  id: string
  messageId: string
  type: TimelineSegmentType
  label: string
  tooltip: string
  shortLabel?: string
  variant?: "auto" | "manual"
}

interface MessageTimelineProps {
  segments: TimelineSegment[]
  onSegmentClick?: (segment: TimelineSegment) => void
  activeMessageId?: string | null
  instanceId: string
  sessionId: string
  showToolSegments?: boolean
}

const SEGMENT_LABELS: Record<TimelineSegmentType, string> = {
  user: "You",
  assistant: "Asst",
  tool: "Tool",
  compaction: "Compaction",
}

const TOOL_FALLBACK_LABEL = "Tool Call"
const MAX_TOOLTIP_LENGTH = 220

type ToolCallPart = Extract<ClientPart, { type: "tool" }>

interface PendingSegment {
  type: TimelineSegmentType
  texts: string[]
  reasoningTexts: string[]
  toolTitles: string[]
  toolTypeLabels: string[]
  toolIcons: string[]
  hasPrimaryText: boolean
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

function collectTextFromPart(part: ClientPart): string {
  if (!part) return ""
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
    return typeof filename === "string" && filename.length > 0 ? `[File] ${filename}` : "Attachment"
  }
  return ""
}

function getToolTitle(part: ToolCallPart): string {
  const metadata = (((part as unknown as { state?: { metadata?: unknown } })?.state?.metadata) || {}) as { title?: unknown }
  const title = typeof metadata.title === "string" && metadata.title.length > 0 ? metadata.title : undefined
  if (title) return title
  if (typeof part.tool === "string" && part.tool.length > 0) {
    return part.tool
  }
  return TOOL_FALLBACK_LABEL
}

function getToolTypeLabel(part: ToolCallPart): string {
  if (typeof part.tool === "string" && part.tool.trim().length > 0) {
    return part.tool.trim().slice(0, 4)
  }
  return TOOL_FALLBACK_LABEL.slice(0, 4)
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

function formatToolTooltip(titles: string[]): string {
  if (titles.length === 0) {
    return TOOL_FALLBACK_LABEL
  }
  return truncateText(`${TOOL_FALLBACK_LABEL}: ${titles.join(", ")}`)
}

export function buildTimelineSegments(instanceId: string, record: MessageRecord): TimelineSegment[] {
  if (!record) return []
  const { orderedParts } = buildRecordDisplayData(instanceId, record)
  if (!orderedParts || orderedParts.length === 0) {
    return []
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
    const isToolSegment = pending.type === "tool"
    const label = isToolSegment
      ? pending.toolTypeLabels[0] || TOOL_FALLBACK_LABEL.slice(0, 4)
      : SEGMENT_LABELS[pending.type]
    const shortLabel = isToolSegment ? pending.toolIcons[0] || getToolIcon("tool") : undefined
    const tooltip = isToolSegment
      ? formatToolTooltip(pending.toolTitles)
      : formatTextsTooltip(
          [...pending.texts, ...pending.reasoningTexts],
          pending.type === "user" ? "User message" : "Assistant response",
        )
 
    result.push({
      id: `${record.id}:${segmentIndex}`,
      messageId: record.id,
      type: pending.type,
      label,
      tooltip,
      shortLabel,
    })
    segmentIndex += 1
    pending = null
  }
 
  const ensureSegment = (type: TimelineSegmentType): PendingSegment => {
    if (!pending || pending.type !== type) {
      flushPending()
      pending = { type, texts: [], reasoningTexts: [], toolTitles: [], toolTypeLabels: [], toolIcons: [], hasPrimaryText: type !== "assistant" }
    }
    return pending!
  }


  const defaultContentType: TimelineSegmentType = record.role === "user" ? "user" : "assistant"

  for (const part of orderedParts) {
    if (!part || typeof part !== "object") continue

    if (part.type === "tool") {
      const target = ensureSegment("tool")
      const toolPart = part as ToolCallPart
      target.toolTitles.push(getToolTitle(toolPart))
      target.toolTypeLabels.push(getToolTypeLabel(toolPart))
      target.toolIcons.push(getToolIcon(typeof toolPart.tool === "string" ? toolPart.tool : "tool"))
      continue
    }

    if (part.type === "reasoning") {
      const text = collectReasoningText(part)
      if (text.trim().length === 0) continue
      const target = ensureSegment(defaultContentType)
      if (target) {
        target.reasoningTexts.push(text)
      }
      continue
    }
 
    if (part.type === "compaction") {
      flushPending()
      const isAuto = Boolean((part as any)?.auto)
      result.push({
        id: `${record.id}:${segmentIndex}`,
        messageId: record.id,
        type: "compaction",
        label: SEGMENT_LABELS.compaction,
        tooltip: isAuto ? "Auto Compaction" : "User Compaction",
        variant: isAuto ? "auto" : "manual",
      })
      segmentIndex += 1
      continue
    }

    if (part.type === "step-start" || part.type === "step-finish") {
      continue
    }
 
    const text = collectTextFromPart(part)
    if (text.trim().length === 0) continue
    const target = ensureSegment(defaultContentType)
    if (target) {
      target.texts.push(text)
      target.hasPrimaryText = true
    }
  }


  flushPending()
 
  return result
}

const MessageTimeline: Component<MessageTimelineProps> = (props) => {
  const buttonRefs = new Map<string, HTMLButtonElement>()
  const store = () => messageStoreBus.getOrCreate(props.instanceId)
  const [hoveredSegment, setHoveredSegment] = createSignal<TimelineSegment | null>(null)
  const [tooltipCoords, setTooltipCoords] = createSignal<{ top: number; left: number }>({ top: 0, left: 0 })
  const [hoverAnchorRect, setHoverAnchorRect] = createSignal<{ top: number; left: number; width: number; height: number } | null>(null)
  const [tooltipSize, setTooltipSize] = createSignal<{ width: number; height: number }>({ width: 360, height: 420 })
  const [tooltipElement, setTooltipElement] = createSignal<HTMLDivElement | null>(null)
  let hoverTimer: number | null = null
  const showTools = () => props.showToolSegments ?? true
 
  const registerButtonRef = (segmentId: string, element: HTMLButtonElement | null) => {
    if (element) {
      buttonRefs.set(segmentId, element)
    } else {
      buttonRefs.delete(segmentId)
    }
  }
 
  const clearHoverTimer = () => {
    if (hoverTimer !== null && typeof window !== "undefined") {
      window.clearTimeout(hoverTimer)
      hoverTimer = null
    }
  }
 
  const handleMouseEnter = (segment: TimelineSegment, event: MouseEvent) => {
    if (typeof window === "undefined") return
    clearHoverTimer()
    const target = event.currentTarget as HTMLButtonElement
    hoverTimer = window.setTimeout(() => {
      const rect = target.getBoundingClientRect()
      setHoverAnchorRect({ top: rect.top, left: rect.left, width: rect.width, height: rect.height })
      setHoveredSegment(segment)
    }, 200)
  }

  const handleMouseLeave = () => {
    clearHoverTimer()
    setHoveredSegment(null)
    setHoverAnchorRect(null)
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

  onCleanup(() => clearHoverTimer())

  createEffect(() => {
    const activeId = props.activeMessageId

    if (!activeId) return
    const targetSegment = props.segments.find((segment) => segment.messageId === activeId)
    if (!targetSegment) return
    const element = buttonRefs.get(targetSegment.id)
    if (!element) return
    const timer = typeof window !== "undefined" ? window.setTimeout(() => {
      element.scrollIntoView({ block: "nearest", behavior: "smooth" })
    }, 120) : null
    onCleanup(() => {
      if (timer !== null && typeof window !== "undefined") {
        window.clearTimeout(timer)
      }
    })
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
    onCleanup(() => observer.disconnect())
  })

  const previewData = createMemo(() => {

    const segment = hoveredSegment()
    if (!segment) return null
    const record = store().getMessage(segment.messageId)
    if (!record) return null
    return { messageId: segment.messageId }
  })
 
  return (
    <div class="message-timeline" role="navigation" aria-label="Message timeline">
      <For each={props.segments}>
        {(segment) => {
          onCleanup(() => buttonRefs.delete(segment.id))
          const isActive = () => props.activeMessageId === segment.messageId
          const isHidden = () => segment.type === "tool" && !(showTools() || isActive())
           const shortLabelContent = () => {
             if (segment.type === "tool") {
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
             <button
               ref={(el) => registerButtonRef(segment.id, el)}
               type="button"
               data-variant={segment.variant}
               class={`message-timeline-segment message-timeline-${segment.type} ${segment.type === "compaction" ? `message-timeline-compaction-${segment.variant ?? "manual"}` : ""} ${isActive() ? "message-timeline-segment-active" : ""} ${isHidden() ? "message-timeline-segment-hidden" : ""}`}

              aria-current={isActive() ? "true" : undefined}
              aria-hidden={isHidden() ? "true" : undefined}
              onClick={() => props.onSegmentClick?.(segment)}
              onMouseEnter={(event) => handleMouseEnter(segment, event)}
              onMouseLeave={handleMouseLeave}
            >
              <span class="message-timeline-label message-timeline-label-full">{segment.label}</span>
              <span class="message-timeline-label message-timeline-label-short">{shortLabelContent()}</span>
            </button>
          )
        }}
      </For>
      <Show when={previewData()}>
        {(data) => {
          onCleanup(() => setTooltipElement(null))
          return (
            <div
              ref={(element) => setTooltipElement(element)}
              class="message-timeline-tooltip"
              style={{ top: `${tooltipCoords().top}px`, left: `${tooltipCoords().left}px` }}
            >
              <MessagePreview
                messageId={data().messageId}
                instanceId={props.instanceId}
                sessionId={props.sessionId}
                store={store}
              />
            </div>
          )
        }}
      </Show>
    </div>
  )
}
 
export default MessageTimeline

