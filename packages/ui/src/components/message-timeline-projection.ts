import { partHasRenderableText } from "../types/message"
import type { MessageRecord } from "../stores/message-v2/types"

const STREAMED_TEXT_SIGNATURE_BUCKET = 128

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
}

/** Markers are keyed by type and ordinal in their message, so indexed and loaded markers agree. */
export function timelineSegmentId(messageId: string, type: TimelineSegmentType, ordinal: number): string {
  return `${messageId}:${type}:${ordinal}`
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
