import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js"
import MessagePreview from "./message-preview"
import { messageStoreBus } from "../stores/message-v2/bus"
import type { ClientPart } from "../types/message"
import type { MessageRecord } from "../stores/message-v2/types"
import { buildRecordDisplayData } from "../stores/message-v2/record-display-cache"
import { getToolIcon } from "./tool-call/utils"
import { User as UserIcon, Bot as BotIcon, FoldVertical, ShieldAlert } from "lucide-solid"
import { useI18n } from "../lib/i18n"

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
}

interface MessageTimelineProps {
  segments: TimelineSegment[]
  onSegmentClick?: (segment: TimelineSegment) => void
  activeMessageId?: string | null
  instanceId: string
  sessionId: string
  showToolSegments?: boolean
}

const MAX_TOOLTIP_LENGTH = 220

type ToolCallPart = Extract<ClientPart, { type: "tool" }>

interface PendingSegment {
  type: TimelineSegmentType
  texts: string[]
  reasoningTexts: string[]
  toolTitles: string[]
  toolTypeLabels: string[]
  toolIcons: string[]
  toolPartIds: string[]
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

function collectTextFromPart(part: ClientPart, t: (key: string, params?: Record<string, unknown>) => string): string {
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
    const isToolSegment = pending.type === "tool"
    const label = isToolSegment
      ? pending.toolTypeLabels[0] || segmentLabel("tool")
      : segmentLabel(pending.type)
    const shortLabel = isToolSegment ? pending.toolIcons[0] || getToolIcon("tool") : undefined
    const tooltip = isToolSegment
      ? formatToolTooltip(pending.toolTitles, t)
      : formatTextsTooltip(
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
      toolPartIds: isToolSegment ? pending.toolPartIds : undefined,
    })
    segmentIndex += 1
    pending = null
  }
 
  const ensureSegment = (type: TimelineSegmentType): PendingSegment => {
    if (!pending || pending.type !== type) {
      flushPending()
      pending = { type, texts: [], reasoningTexts: [], toolTitles: [], toolTypeLabels: [], toolIcons: [], toolPartIds: [], hasPrimaryText: type !== "assistant" }
    }
    return pending!
  }


  const defaultContentType: TimelineSegmentType = record.role === "user" ? "user" : "assistant"

  for (const part of orderedParts) {
    if (!part || typeof part !== "object") continue

    if (part.type === "tool") {
      const target = ensureSegment("tool")
      const toolPart = part as ToolCallPart
      target.toolTitles.push(getToolTitle(toolPart, t))
      target.toolTypeLabels.push(getToolTypeLabel(toolPart, t))
      target.toolIcons.push(getToolIcon(typeof toolPart.tool === "string" ? toolPart.tool : "tool"))
      if (typeof toolPart.id === "string" && toolPart.id.length > 0) {
        target.toolPartIds.push(toolPart.id)
      }
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
        label: segmentLabel("compaction"),
        tooltip: isAuto ? t("messageTimeline.tooltip.compaction.auto") : t("messageTimeline.tooltip.compaction.manual"),
        variant: isAuto ? "auto" : "manual",
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
    }
  }


  flushPending()
 
  return result
}

const MessageTimeline: Component<MessageTimelineProps> = (props) => {
  const { t } = useI18n()
  const buttonRefs = new Map<string, HTMLButtonElement>()
  const store = () => messageStoreBus.getOrCreate(props.instanceId)
  const [hoveredSegment, setHoveredSegment] = createSignal<TimelineSegment | null>(null)
  const [tooltipCoords, setTooltipCoords] = createSignal<{ top: number; left: number }>({ top: 0, left: 0 })
  const [hoverAnchorRect, setHoverAnchorRect] = createSignal<{ top: number; left: number; width: number; height: number } | null>(null)
  const [tooltipSize, setTooltipSize] = createSignal<{ width: number; height: number }>({ width: 360, height: 420 })
  const [tooltipElement, setTooltipElement] = createSignal<HTMLDivElement | null>(null)
  let hoverTimer: number | null = null
  let closeTimer: number | null = null
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
    // Small delay so the pointer can travel from the segment to the tooltip.
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
    clearHoverTimer()
    clearCloseTimer()
  })

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
    <div class="message-timeline" role="navigation" aria-label={t("messageTimeline.ariaLabel")}>
      <For each={props.segments}>
        {(segment) => {
          onCleanup(() => buttonRefs.delete(segment.id))
          const isActive = () => props.activeMessageId === segment.messageId

          const hasActivePermission = () => {
            if (segment.type !== "tool") return false
            const partIds = segment.toolPartIds ?? []
            if (partIds.length === 0) return false
            for (const partId of partIds) {
              const permissionState = store().getPermissionState(segment.messageId, partId)
              if (permissionState?.active) return true
            }
            return false
          }

          const isHidden = () => segment.type === "tool" && !(showTools() || isActive() || hasActivePermission())

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
             <button
               ref={(el) => registerButtonRef(segment.id, el)}
               type="button"
               data-variant={segment.variant}
               class={`message-timeline-segment message-timeline-${segment.type} ${hasActivePermission() ? "message-timeline-segment-permission" : ""} ${segment.type === "compaction" ? `message-timeline-compaction-${segment.variant ?? "manual"}` : ""} ${isActive() ? "message-timeline-segment-active" : ""} ${isHidden() ? "message-timeline-segment-hidden" : ""}`}

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
          )
        }}
      </Show>
    </div>
  )
}
 
export default MessageTimeline
