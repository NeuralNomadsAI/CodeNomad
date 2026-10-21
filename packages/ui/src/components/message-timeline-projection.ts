import { isHiddenSyntheticTextPart, partHasRenderableText, type ClientPart } from "../types/message"
import type { MessageRecord } from "../stores/message-v2/types"
import { buildRecordDisplayData } from "../stores/message-v2/record-display-cache"
import { extractReasoningTextForRender } from "../lib/message-render-cache"
import { getPartCharCount } from "../lib/token-utils"
import { groupTranscriptRows, toolGroupKind, type TranscriptRowKind } from "../lib/message-part-grouping"

const STREAMED_TEXT_SIGNATURE_BUCKET = 128
const MAX_TOOLTIP_LENGTH = 220
const SEGMENT_TYPES = new Set(["user", "assistant", "tool", "compaction", "reasoning", "system"])

type Translate = (key: string, params?: Record<string, unknown>) => string
type ToolCallPart = Extract<ClientPart, { type: "tool" }>

export type TimelineSegmentType = "user" | "assistant" | "tool" | "compaction" | "reasoning" | "system"

export interface TimelineSegment {
  id: string
  messageId: string
  type: TimelineSegmentType
  label: string
  tooltip: string
  toolName?: string
  variant?: "auto" | "manual"
  toolPartIds?: string[]
  partIds?: string[]
  partId?: string
  totalChars: number
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

export function parseTimelineSegmentId(messageId: string, id: string): { type: TimelineSegmentType; ordinal: number; continued: boolean } | undefined {
  if (!id.startsWith(`${messageId}:`)) return
  const [type, ordinal, suffix, ...rest] = id.slice(messageId.length + 1).split(":")
  if (rest.length || (suffix !== undefined && suffix !== "continued") || !SEGMENT_TYPES.has(type) || !/^\d+$/.test(ordinal ?? "")) return
  return { type: type as TimelineSegmentType, ordinal: Number(ordinal), continued: suffix === "continued" }
}

export function timelineSegmentLabel(type: TimelineSegmentType, t: (key: string, params?: Record<string, unknown>) => string): string {
  if (type === "user") return t("messageTimeline.segment.user.label")
  if (type === "assistant") return t("messageTimeline.segment.assistant.label")
  if (type === "compaction") return t("messageTimeline.segment.compaction.label")
  if (type === "reasoning") return t("messageBlock.reasoning.thoughtLabel")
  if (type === "system") return t("messageBlock.system.label")
  return t("messageTimeline.tool.fallbackLabel").slice(0, 4)
}

export function getTimelineRecordSignature(record: MessageRecord): string {
  const parts = record.partIds.map((partId) => {
    const part = record.parts[partId]
    const data = part?.data
    const structuralRevision = data?.type === "tool"
      ? part.revision
      : 0
    const fileName = data?.type === "file" && typeof data.filename === "string" ? data.filename : ""
    const textLength = (data?.type === "text" || data?.type === "reasoning" || data?.type === "compaction") && typeof data.text === "string"
      ? data.text.length
      : 0
    const textBucket = Math.ceil(textLength / STREAMED_TEXT_SIGNATURE_BUCKET)
    return `${partId}:${data?.type ?? "unknown"}:${data && partHasRenderableText(data) ? 1 : 0}:${structuralRevision}:${fileName}:${textBucket}`
  }).join("|")
  return `${record.status}|${parts}`
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

function getToolTypeLabel(part: ToolCallPart, t: Translate): string {
  if (typeof part.tool === "string" && part.tool.trim().length > 0) return part.tool.trim().slice(0, 4)
  return t("messageTimeline.tool.fallbackLabel").slice(0, 4)
}

function formatTextsTooltip(texts: string[], fallback: string): string {
  const combined = texts.map((text) => text.trim()).filter((text) => text.length > 0).join("\n\n")
  return combined.length > 0 ? truncateText(combined) : fallback
}

/**
 * Each part's marker run over the message's whole native sequence: consecutive
 * text (or thinking) parts form one run, each tool, compaction and system part
 * its own; blank parts belong to none. Ordinals count runs per type.
 */
function nativeTimelineRuns(record: MessageRecord, t: Translate): Array<{ type: TimelineSegmentType; ordinal: number } | undefined> {
  const contentType = record.role === "user" ? "user" : "assistant"
  const ordinals = new Map<TimelineSegmentType, number>()
  let previous: { type: TimelineSegmentType; ordinal: number } | undefined
  return record.partIds.map((partId) => {
    const part = record.parts[partId]?.data as ClientPart | undefined
    if (!part) return undefined
    const type: TimelineSegmentType | undefined = part.type === "tool" || part.type === "compaction" || part.type === "system" ? part.type
      : part.type === "reasoning" ? (extractReasoningTextForRender(part).trim() ? "reasoning" : undefined)
        : collectTextFromPart(part, t).trim() ? contentType : undefined
    if (!type) return undefined
    if (previous?.type === type && (type === "reasoning" || type === contentType)) return previous
    const ordinal = ordinals.get(type) ?? 0
    ordinals.set(type, ordinal + 1)
    return previous = { type, ordinal }
  })
}

/** Index in `record.partIds` where a marker's native run starts, if it exists. */
export function timelineRunStart(record: MessageRecord, segmentId: string, t: Translate): number | undefined {
  const parsed = parseTimelineSegmentId(record.id, segmentId)
  if (!parsed) return undefined
  const index = nativeTimelineRuns(record, t).findIndex((run) => run?.type === parsed.type && run.ordinal === parsed.ordinal)
  return index < 0 ? undefined : index
}

/** The markers of a message's displayed parts, one per text or thinking run and per tool, compaction and system part. */
export function buildTimelineSegments(instanceId: string, record: MessageRecord, t: Translate): TimelineSegment[] {
  if (!record) return []
  const { orderedParts, hiddenCount, hiddenStart } = buildRecordDisplayData(instanceId, record)
  if (!orderedParts || orderedParts.length === 0) return []
  const runs = nativeTimelineRuns(record, t)
  const result: TimelineSegment[] = []
  const emitted = new Set<string>()
  let omittedBefore = false
  const push = (type: TimelineSegmentType, ordinal: number, segment: Omit<TimelineSegment, "id" | "messageId" | "type">) => {
    const id = timelineSegmentId(record.id, type, ordinal, emitted.has(timelineSegmentId(record.id, type, ordinal)))
    emitted.add(id)
    result.push({ id, messageId: record.id, type, ...segment, ...(omittedBefore ? { omittedBefore: true as const } : {}) })
    omittedBefore = false
  }
  let pending: { type: TimelineSegmentType; ordinal: number; texts: string[]; partIds: string[]; totalChars: number } | null = null
  const flushPending = () => {
    if (!pending) return
    const { type, ordinal, texts, partIds, totalChars } = pending
    pending = null
    const fallback = type === "user" ? t("messageTimeline.tooltip.userFallback")
      : type === "reasoning" ? t("messageBlock.reasoning.thoughtsFallback") : t("messageTimeline.tooltip.assistantFallback")
    push(type, ordinal, { label: timelineSegmentLabel(type, t), tooltip: formatTextsTooltip(texts, fallback), partIds, totalChars })
  }
  const appendRun = (run: { type: TimelineSegmentType; ordinal: number }, text: string, part: ClientPart) => {
    if (pending?.type !== run.type || pending.ordinal !== run.ordinal) {
      flushPending()
      pending = { ...run, texts: [], partIds: [], totalChars: 0 }
    }
    pending.texts.push(text)
    if (typeof part.id === "string" && part.id.length > 0) pending.partIds.push(part.id)
    pending.totalChars += getPartCharCount(part)
  }

  // Displayed parts follow `record.partIds` order, omitting the hidden range.
  let cursor = 0
  for (let index = 0; index < record.partIds.length; index++) {
    if (hiddenCount > 0 && index === hiddenStart) {
      // Omitted parts render as a placeholder between the runs around them.
      flushPending()
      omittedBefore = true
      index += hiddenCount - 1
      continue
    }
    if (!record.parts[record.partIds[index]]?.data) continue
    const part = orderedParts[cursor++]
    const run = runs[index]
    if (!part || !run) continue
    const partId = typeof part.id === "string" ? part.id : ""

    if (run.type === "tool") {
      flushPending()
      const toolPart = part as ToolCallPart
      push("tool", run.ordinal, {
        label: getToolTypeLabel(toolPart, t) || timelineSegmentLabel("tool", t),
        tooltip: truncateText(`${t("messageTimeline.tool.fallbackLabel")}: ${getToolTitle(toolPart, t)}`),
        toolName: typeof toolPart.tool === "string" ? toolPart.tool.trim() : "",
        toolPartIds: partId ? [partId] : undefined,
        totalChars: getPartCharCount(part),
      })
    } else if (run.type === "compaction") {
      flushPending()
      const isAuto = Boolean((part as any)?.auto)
      push("compaction", run.ordinal, {
        label: timelineSegmentLabel("compaction", t),
        tooltip: isAuto ? t("messageTimeline.tooltip.compaction.auto") : t("messageTimeline.tooltip.compaction.manual"),
        variant: isAuto ? "auto" : "manual",
        partId,
        totalChars: 0,
      })
    } else if (run.type === "system" && part.type === "system") {
      flushPending()
      push("system", run.ordinal, { label: timelineSegmentLabel("system", t), tooltip: truncateText(part.description?.trim() || part.text.trim() || timelineSegmentLabel("system", t)),
        partId, totalChars: getPartCharCount(part) })
    } else {
      appendRun(run, run.type === "reasoning" ? collectReasoningText(part) : collectTextFromPart(part, t), part)
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
