import { isHiddenSyntheticTextPart, type ClientPart } from "../types/message"
import type { MessageRecord } from "../stores/message-v2/types"
import { getRecordPartDisplayWindow } from "../stores/message-v2/record-display-cache"
import { extractReasoningTextForRender } from "../lib/message-render-cache"
import { groupTranscriptRows, toolGroupKind, type TranscriptRowKind } from "../lib/message-part-grouping"

const MAX_TOOLTIP_LENGTH = 220
const SEGMENT_TYPES = new Set(["user", "assistant", "tool", "compaction", "reasoning", "system"])

type Translate = (key: string, params?: Record<string, unknown>) => string
type ToolCallPart = Extract<ClientPart, { type: "tool" }>

export type TimelineSegmentType = "user" | "assistant" | "tool" | "compaction" | "reasoning" | "system"

export interface TimelineSegment {
  id: string
  messageId: string
  type: TimelineSegmentType
  toolName?: string
  variant?: "auto" | "manual"
  toolPartIds?: string[]
  partIds?: string[]
  partId?: string
  /** The message's omitted parts render just before this marker's block. */
  omittedBefore?: true
}

/**
 * Markers are keyed by type and native ordinal in their message (over all of
 * its parts, displayed or omitted), so indexed and loaded markers agree. A run
 * the omitted-parts placeholder splits keeps its id before the gap; its tail
 * after the gap is `continued`.
 */
export function timelineSegmentId(messageId: string, type: TimelineSegmentType, ordinal: number, continued = false): string {
  return `${messageId}:${type}:${ordinal}${continued ? ":continued" : ""}`
}

export function parseTimelineSegmentId(id: string): { messageId: string; type: TimelineSegmentType; ordinal: number; continued: boolean } | undefined {
  const match = /^(.+):([a-z]+):(\d+)(:continued)?$/.exec(id)
  if (!match || !SEGMENT_TYPES.has(match[2])) return
  return { messageId: match[1], type: match[2] as TimelineSegmentType, ordinal: Number(match[3]), continued: Boolean(match[4]) }
}

/**
 * The marker standing for a selected id once reveals or omissions changed its
 * message's markers: itself, or for a continuation the omitted parts no longer
 * split, its run's marker.
 */
export function survivingTimelineSegmentId(id: string, exists: (id: string) => boolean): string {
  const parsed = parseTimelineSegmentId(id)
  return exists(id) || !parsed?.continued ? id : timelineSegmentId(parsed.messageId, parsed.type, parsed.ordinal)
}

export function timelineSegmentLabel({ type, toolName, toolPartIds }: TimelineSegment, t: Translate): string {
  if (type === "user") return t("messageTimeline.segment.user.label")
  if (type === "assistant") return t("messageTimeline.segment.assistant.label")
  if (type === "compaction") return t("messageTimeline.segment.compaction.label")
  if (type === "reasoning") return t("messageBlock.reasoning.thoughtLabel")
  if (type === "system") return t("messageBlock.system.label")
  return ((toolPartIds?.length && toolName) || t("messageTimeline.tool.fallbackLabel")).slice(0, 4)
}

export function sameTimelineList<T>(a: readonly T[], b: readonly T[]) {
  return a === b || (a.length === b.length && a.every((item, index) => item === b[index]))
}

export function sameTimelineSegment(a: TimelineSegment, b: TimelineSegment) {
  const sameParts = (x?: string[], y?: string[]) => x === y || Boolean(x && y && sameTimelineList(x, y))
  return a === b || (a.id === b.id && a.messageId === b.messageId && a.type === b.type
    && a.toolName === b.toolName && a.variant === b.variant
    && a.omittedBefore === b.omittedBefore && a.partId === b.partId
    && sameParts(a.partIds, b.partIds) && sameParts(a.toolPartIds, b.toolPartIds))
}

function truncateText(value: string): string {
  return value.length <= MAX_TOOLTIP_LENGTH ? value : `${value.slice(0, MAX_TOOLTIP_LENGTH - 1).trimEnd()}…`
}

function collectReasoningText(part: ClientPart): string {
  const stringifySegment = (segment: unknown): string => {
    if (typeof segment === "string") return segment
    if (segment && typeof segment === "object") {
      const obj = segment as { text?: unknown; value?: unknown; content?: unknown[] }
      const parts: string[] = []
      if (typeof obj.text === "string") parts.push(obj.text)
      if (typeof obj.value === "string") parts.push(obj.value)
      if (Array.isArray(obj.content)) parts.push(obj.content.map((entry) => stringifySegment(entry)).join("\n"))
      return parts.filter(Boolean).join("\n")
    }
    return ""
  }

  if (typeof (part as any)?.text === "string") return (part as any).text
  if (Array.isArray((part as any)?.content)) return (part as any).content.map((entry: unknown) => stringifySegment(entry)).join("\n")
  return ""
}

export function collectTextFromPart(part: ClientPart, t: Translate): string {
  if (!part) return ""
  if (isHiddenSyntheticTextPart(part)) return ""
  if (typeof (part as any).text === "string") return (part as any).text as string
  if (part.type === "reasoning") return collectReasoningText(part)
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

export function getToolTitle(part: ToolCallPart, t: Translate): string {
  const metadata = (((part as unknown as { state?: { metadata?: unknown } })?.state?.metadata) || {}) as { title?: unknown }
  const title = typeof metadata.title === "string" && metadata.title.length > 0 ? metadata.title : undefined
  if (title) return title
  if (typeof part.tool === "string" && part.tool.length > 0) return part.tool
  return t("messageTimeline.tool.fallbackLabel")
}

function hasTimelineProse(part: ClientPart): boolean {
  if (isHiddenSyntheticTextPart(part)) return false
  if (typeof part.text === "string") return /\S/.test(part.text)
  if (Array.isArray(part.content)) return part.content.some(entry => typeof entry === "string" && /\S/.test(entry))
  return part.type === "file"
}

/** Accessible excerpt, computed only for a mounted marker or an open preview. */
export function timelineSegmentTooltip(segment: TimelineSegment, record: MessageRecord | undefined, t: Translate): string {
  if (segment.variant) return t(segment.variant === "auto" ? "messageTimeline.tooltip.compaction.auto" : "messageTimeline.tooltip.compaction.manual")
  if (!record) return ""
  if (segment.toolPartIds?.length) {
    const part = record.parts[segment.toolPartIds[0]]?.data
    if (part?.type === "tool") return truncateText(`${t("messageTimeline.tool.fallbackLabel")}: ${getToolTitle(part, t)}`)
  }
  if (segment.partId) {
    const part = record.parts[segment.partId]?.data
    if (part?.type === "system") return truncateText(part.description?.trim() || part.text.trim() || timelineSegmentLabel(segment, t))
  }
  if (!segment.partIds?.length) return ""
  let excerpt = ""
  for (const id of segment.partIds) {
    const part = record.parts[id]?.data
    if (!part) continue
    const text = collectTextFromPart(part, t).trim()
    if (!text) continue
    if (excerpt) excerpt += "\n\n"
    excerpt += text.slice(0, Math.max(0, MAX_TOOLTIP_LENGTH + 1 - excerpt.length))
    if (excerpt.length > MAX_TOOLTIP_LENGTH) return truncateText(excerpt)
  }
  return excerpt || (segment.type === "user" ? t("messageTimeline.tooltip.userFallback")
    : segment.type === "reasoning" ? t("messageBlock.reasoning.thoughtsFallback") : t("messageTimeline.tooltip.assistantFallback"))
}

/**
 * Each part's marker run over the message's whole native sequence: consecutive
 * text (or thinking) parts form one run, each tool, compaction and system part
 * its own; blank parts belong to none. Ordinals count runs per type.
 */
function nativeTimelineRuns(record: MessageRecord): Array<{ type: TimelineSegmentType; ordinal: number } | undefined> {
  const contentType = record.role === "user" ? "user" : "assistant"
  const ordinals = new Map<TimelineSegmentType, number>()
  let previous: { type: TimelineSegmentType; ordinal: number } | undefined
  return record.partIds.map((partId) => {
    const part = record.parts[partId]?.data as ClientPart | undefined
    if (!part) return undefined
    const type: TimelineSegmentType | undefined = part.type === "tool" || part.type === "compaction" || part.type === "system" ? part.type
      : part.type === "reasoning" ? (extractReasoningTextForRender(part) ? "reasoning" : undefined)
        : hasTimelineProse(part) ? contentType : undefined
    if (!type) return undefined
    if (previous?.type === type && (type === "reasoning" || type === contentType)) return previous
    const ordinal = ordinals.get(type) ?? 0
    ordinals.set(type, ordinal + 1)
    return previous = { type, ordinal }
  })
}

/** Index in `record.partIds` where a marker's native run starts, if it exists. */
export function timelineRunStart(record: MessageRecord, segmentId: string): number | undefined {
  const parsed = parseTimelineSegmentId(segmentId)
  // A continuation stands for its run's part after the omitted ones.
  if (!parsed || parsed.messageId !== record.id || parsed.continued) return undefined
  const index = nativeTimelineRuns(record).findIndex((run) => run?.type === parsed.type && run.ordinal === parsed.ordinal)
  return index < 0 ? undefined : index
}

/** The markers of a message's displayed parts, one per text or thinking run and per tool, compaction and system part. */
export function buildTimelineSegments(instanceId: string, record: MessageRecord | undefined): TimelineSegment[] {
  if (!record?.partIds.length) return []
  const { hiddenCount, headCount } = getRecordPartDisplayWindow(instanceId, record)
  const runs = nativeTimelineRuns(record)
  const result: TimelineSegment[] = []
  const emitted = new Set<string>()
  let omittedBefore = false
  const push = (type: TimelineSegmentType, ordinal: number, segment: Omit<TimelineSegment, "id" | "messageId" | "type">) => {
    const id = timelineSegmentId(record.id, type, ordinal, emitted.has(timelineSegmentId(record.id, type, ordinal)))
    emitted.add(id)
    result.push({ id, messageId: record.id, type, ...segment, ...(omittedBefore ? { omittedBefore: true as const } : {}) })
    omittedBefore = false
  }
  let pending: { type: TimelineSegmentType; ordinal: number; partIds: string[] } | null = null
  const flushPending = () => {
    if (!pending) return
    const { type, ordinal, partIds } = pending
    pending = null
    push(type, ordinal, { partIds })
  }

  // Displayed parts follow `record.partIds` order, omitting the hidden range.
  for (let index = 0; index < record.partIds.length; index++) {
    if (hiddenCount > 0 && index === headCount) {
      // Omitted parts render as a placeholder between the runs around them.
      flushPending()
      omittedBefore = true
      index += hiddenCount - 1
      continue
    }
    const part = record.parts[record.partIds[index]]?.data
    const run = runs[index]
    if (!part || !run) continue
    const partId = typeof part.id === "string" ? part.id : ""

    if (part.type === "tool") {
      flushPending()
      push("tool", run.ordinal, {
        toolName: typeof part.tool === "string" ? part.tool.trim() : "",
        toolPartIds: partId ? [partId] : undefined,
      })
    } else if (part.type === "compaction" || part.type === "system") {
      flushPending()
      push(part.type, run.ordinal, part.type === "compaction" ? { partId, variant: part.auto ? "auto" : "manual" } : { partId })
    } else {
      if (pending?.type !== run.type || pending.ordinal !== run.ordinal) {
        flushPending()
        pending = { ...run, partIds: [] }
      }
      if (partId) pending.partIds.push(partId)
    }
  }
  flushPending()
  return result
}

function timelineRowKind(segment: TimelineSegment): TranscriptRowKind {
  if (segment.type === "user" || segment.type === "assistant") return "content"
  if (segment.type === "reasoning") return "reasoning"
  return segment.type === "tool" ? toolGroupKind(segment.toolName ?? "") ?? "part" : "part"
}

/**
 * The rail's markers for the transcript's rows, per message with its row
 * boundaries (`groupTranscriptRows`): hidden tools leave the part sequence, so
 * the text or thinking around them shares one row, while hidden thinking and
 * system context still end rows. A content or thinking row keeps its first
 * marker, which also represents the row's folded markers; every tool keeps its
 * own.
 */
export function foldTimelineSegments(segments: readonly TimelineSegment[], isHidden: (segment: TimelineSegment) => boolean) {
  const visible: TimelineSegment[] = []
  const representative = new Map<string, string>()
  let messageId: string | undefined
  let sequence: Array<TimelineSegment | null> = []
  const flush = () => {
    for (const row of groupTranscriptRows(sequence, (segment) => ({ kind: timelineRowKind(segment) }))) {
      if (!row) continue
      if (row.kind === "part") {
        if (!isHidden(row.item)) visible.push(row.item)
        continue
      }
      const [first, ...rest] = row.items
      const folds = row.kind === "content" || row.kind === "reasoning"
      if (folds) for (const folded of rest) representative.set(folded.id, first.id)
      for (const marker of folds ? [first] : row.items) if (!isHidden(marker)) visible.push(marker)
    }
    sequence = []
  }
  for (const segment of segments) {
    if (segment.messageId !== messageId) {
      flush()
      messageId = segment.messageId
    }
    if (segment.omittedBefore) sequence.push(null)
    if (segment.type === "tool" && isHidden(segment)) continue
    sequence.push(segment)
  }
  flush()
  return { visible, representative }
}
