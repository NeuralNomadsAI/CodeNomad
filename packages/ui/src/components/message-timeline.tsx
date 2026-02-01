import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, type Component } from "solid-js"
import { Portal } from "solid-js/web"
import MessagePreview from "./message-preview"
import { messageStoreBus } from "../stores/message-v2/bus"
import type { ClientPart } from "../types/message"
import type { MessageRecord } from "../stores/message-v2/types"
import { buildRecordDisplayData } from "../stores/message-v2/record-display-cache"
import { getToolIcon } from "./tool-call/utils"
import { User as UserIcon, Bot as BotIcon } from "lucide-solid"
import { cn } from "../lib/cn"

export type TimelineSegmentType = "user" | "assistant" | "tool"

export interface TimelineSegment {
  id: string
  messageId: string
  type: TimelineSegmentType
  label: string
  tooltip: string
  shortLabel?: string
}

interface TurnGroup {
  id: string
  type: "user" | "assistant-turn"
  segments: TimelineSegment[]
  count: number
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

function shortLabelForSegment(segment: TimelineSegment) {
  if (segment.type === "tool") {
    return segment.shortLabel ?? getToolIcon("tool")
  }
  if (segment.type === "user") {
    return <UserIcon class="size-4" aria-hidden="true" />
  }
  return <BotIcon class="size-4" aria-hidden="true" />
}

function groupByTurns(segments: TimelineSegment[]): TurnGroup[] {
  const turns: TurnGroup[] = []
  let currentAssistantSegments: TimelineSegment[] = []

  const flushAssistantTurn = () => {
    if (currentAssistantSegments.length === 0) return
    turns.push({
      id: `turn-${currentAssistantSegments[0].id}`,
      type: "assistant-turn",
      segments: currentAssistantSegments,
      count: currentAssistantSegments.length,
    })
    currentAssistantSegments = []
  }

  for (const segment of segments) {
    if (segment.type === "user") {
      flushAssistantTurn()
      turns.push({
        id: `turn-${segment.id}`,
        type: "user",
        segments: [segment],
        count: 1,
      })
    } else {
      currentAssistantSegments.push(segment)
    }
  }
  flushAssistantTurn()

  return turns
}

const MessageTimeline: Component<MessageTimelineProps> = (props) => {
  const buttonRefs = new Map<string, HTMLButtonElement>()
  const store = () => messageStoreBus.getOrCreate(props.instanceId)
  const [hoveredSegment, setHoveredSegment] = createSignal<TimelineSegment | null>(null)
  const [tooltipCoords, setTooltipCoords] = createSignal<{ top: number; left: number }>({ top: 0, left: 0 })
  const [hoverAnchorRect, setHoverAnchorRect] = createSignal<{ top: number; left: number; width: number; height: number } | null>(null)
  const [tooltipSize, setTooltipSize] = createSignal<{ width: number; height: number }>({ width: 520, height: 600 })
  const [tooltipElement, setTooltipElement] = createSignal<HTMLDivElement | null>(null)
  let hoverTimer: number | null = null
  const showTools = () => props.showToolSegments ?? true

  const [expandedGroups, setExpandedGroups] = createSignal<Set<string>>(new Set())

  const groupedSegments = createMemo(() => groupByTurns(props.segments))

  // Auto-expand the turn containing the active message whenever activeMessageId changes.
  // Uses `on()` so only activeMessageId is tracked — reading expandedGroups/groupedSegments
  // inside won't re-trigger the effect (allows manual collapse to stick).
  createEffect(
    on(
      () => props.activeMessageId,
      (activeId) => {
        if (!activeId) return
        const turns = groupedSegments()
        const activeTurn = turns.find(
          (t) => t.type === "assistant-turn" && t.segments.some((s) => s.messageId === activeId),
        )
        if (activeTurn && !expandedGroups().has(activeTurn.id)) {
          setExpandedGroups((prev) => {
            const next = new Set(prev)
            next.add(activeTurn.id)
            return next
          })
        }
      },
    ),
  )

  const toggleGroup = (groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) {
        next.delete(groupId)
      } else {
        next.add(groupId)
      }
      return next
    })
  }

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
    let element = buttonRefs.get(targetSegment.id)
    // Fall back to group header when segment button is not rendered (collapsed)
    if (!element) {
      const groups = groupedSegments()
      const parentGroup = groups.find((g) => g.segments.some((s) => s.id === targetSegment.id))
      if (parentGroup) {
        element = buttonRefs.get(parentGroup.id)
      }
    }
    if (!element) return
    const timer = typeof window !== "undefined" ? window.setTimeout(() => {
      element!.scrollIntoView({ block: "nearest", behavior: "smooth" })
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
    <div
      class="flex flex-1 flex-col gap-1.5 p-1 overflow-y-auto overflow-x-hidden rounded-lg bg-background shadow-lg [contain:layout_style]"
      role="navigation"
      aria-label="Message timeline"
    >
      <For each={groupedSegments()}>
        {(turn) => {
          const firstSegment = () => turn.segments[0]
          const isTurnExpanded = () => expandedGroups().has(turn.id)
          const turnContainsActive = () =>
            turn.segments.some((s) => s.messageId === props.activeMessageId)

          onCleanup(() => {
            buttonRefs.delete(turn.id)
            for (const s of turn.segments) {
              buttonRefs.delete(s.id)
            }
          })

          // User turns: render as a single segment button
          if (turn.type === "user") {
            const segment = firstSegment()
            const isActive = () => props.activeMessageId === segment.messageId
            return (
              <div class="flex flex-col first:mt-0 mt-1">
                <button
                  ref={(el) => {
                    registerButtonRef(turn.id, el)
                    registerButtonRef(segment.id, el)
                  }}
                  type="button"
                  class={cn(
                    "w-full min-h-6 h-6 shrink-0 rounded-md border border-primary/30 bg-primary/5 flex items-center justify-center gap-0.5 text-[0.65rem] font-semibold tracking-wide uppercase text-foreground cursor-pointer transition-all duration-150 [contain:layout_style_paint]",
                    isActive() && "!border-transparent !bg-success !text-success-foreground font-bold shadow-[inset_0_0_0_1px_rgba(0,0,0,0.35)]",
                    !isActive() && "hover:bg-accent hover:text-foreground hover:-translate-y-px focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  )}
                  aria-current={isActive() ? "true" : undefined}
                  onClick={() => props.onSegmentClick?.(segment)}
                  onMouseEnter={(event) => handleMouseEnter(segment, event)}
                  onMouseLeave={handleMouseLeave}
                >
                  <span class="pointer-events-none inline-flex leading-none items-center justify-center">
                    <UserIcon class="size-4" aria-hidden="true" />
                  </span>
                </button>
              </div>
            )
          }

          // Assistant turns: collapsible header with expandable children
          const expanded = isTurnExpanded
          const visibleCount = () =>
            showTools()
              ? turn.count
              : turn.segments.filter((s) => s.type !== "tool").length
          const isSingle = () => visibleCount() <= 1

          const handleHeaderClick = () => {
            if (isSingle()) {
              props.onSegmentClick?.(firstSegment())
              return
            }
            if (!expanded()) {
              props.onSegmentClick?.(firstSegment())
            }
            toggleGroup(turn.id)
          }

          return (
            <div class="flex flex-col first:mt-0 mt-1">
              {/* Turn header */}
              <button
                ref={(el) => {
                  registerButtonRef(turn.id, el)
                  if (isSingle()) registerButtonRef(firstSegment().id, el)
                }}
                type="button"
                class={cn(
                  "w-full min-h-6 h-6 shrink-0 rounded-md border border-muted bg-muted/30 flex items-center justify-center gap-0.5 text-[0.65rem] font-semibold tracking-wide uppercase text-foreground cursor-pointer transition-all duration-150 [contain:layout_style_paint]",
                  turnContainsActive() && "!border-transparent !bg-success !text-success-foreground font-bold shadow-[inset_0_0_0_1px_rgba(0,0,0,0.35)]",
                  !turnContainsActive() && "hover:bg-accent hover:text-foreground hover:-translate-y-px focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  !isSingle() && expanded() && "rounded-b-none border-b-transparent"
                )}
                aria-current={turnContainsActive() ? "true" : undefined}
                onClick={handleHeaderClick}
                onMouseEnter={(event) => handleMouseEnter(firstSegment(), event)}
                onMouseLeave={handleMouseLeave}
              >
                <span class="pointer-events-none inline-flex leading-none items-center justify-center">
                  <BotIcon class="size-3.5" aria-hidden="true" />
                </span>
                <Show when={visibleCount() > 1}>
                  <span class={cn(
                    "text-[0.6rem] font-bold text-muted-foreground pointer-events-none leading-none",
                    turnContainsActive() && "text-white/85"
                  )}>({visibleCount()})</span>
                </Show>
              </button>

              {/* Expanded children */}
              <Show when={expanded() && turn.count > 1}>
                <div class="flex flex-col gap-px border-l-2 border-border/50 ml-2 max-sm:ml-1">
                  <For each={turn.segments}>
                    {(segment) => {
                      const isChildActive = () => props.activeMessageId === segment.messageId
                      const isChildHidden = () =>
                        segment.type === "tool" && !(showTools() || isChildActive())
                      onCleanup(() => buttonRefs.delete(segment.id))
                      return (
                        <button
                          ref={(el) => registerButtonRef(segment.id, el)}
                          type="button"
                          class={cn(
                            "relative w-full min-h-5 h-5 shrink-0 text-[0.6rem] font-semibold tracking-wide uppercase text-foreground border-none bg-secondary rounded-none flex items-center justify-center cursor-pointer transition-colors duration-150 last:rounded-b-md",
                            isChildActive() && "!bg-success !text-success-foreground",
                            !isChildActive() && "hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none",
                            isChildHidden() && "!hidden"
                          )}
                          aria-current={isChildActive() ? "true" : undefined}
                          aria-hidden={isChildHidden() ? "true" : undefined}
                          onClick={() => props.onSegmentClick?.(segment)}
                          onMouseEnter={(event) => handleMouseEnter(segment, event)}
                          onMouseLeave={handleMouseLeave}
                        >
                          <span class="absolute -left-2 top-1/2 w-1.5 h-px bg-border/50 pointer-events-none max-sm:-left-1 max-sm:w-0.5" />
                          <span class="pointer-events-none inline-flex leading-none items-center justify-center">
                            {shortLabelForSegment(segment)}
                          </span>
                        </button>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </div>
          )
        }}
      </For>
      <Portal>
        <Show when={previewData()}>
          {(data) => {
            onCleanup(() => setTooltipElement(null))
            return (
              <div
                ref={(element) => setTooltipElement(element)}
                class="fixed z-[1000] pointer-events-none"
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
      </Portal>
    </div>
  )
}

export default MessageTimeline
