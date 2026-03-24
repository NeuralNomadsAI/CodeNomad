import type { JSX } from "solid-js"
import type { ClientPart } from "../../types/message"
import type { MessageRecord } from "../../stores/message-v2/types"
import { buildRecordDisplayData } from "../../stores/message-v2/record-display-cache"
import { getPartCharCount } from "../../lib/token-utils"
import { getToolIcon } from "../tool-call/utils"

export type TimelineSegmentType = "user" | "assistant" | "tool" | "compaction"

type PartFields = Record<string, unknown> & {
  text?: string
  content?: unknown[]
  filename?: string
  id?: string
  auto?: boolean
}

export interface TimelineSegment {
  id: string
  messageId: string
  type: TimelineSegmentType
  label: string
  tooltip: string
  shortLabel?: JSX.Element | string
  variant?: "auto" | "manual"
  toolPartIds?: string[]
  partIds?: string[]
  partId?: string
  totalChars: number
}

const MAX_TOOLTIP_LENGTH = 220
type ToolCallPart = Extract<ClientPart, { type: "tool" }>

interface PendingSegment {
  type: TimelineSegmentType
  texts: string[]
  reasoningTexts: string[]
  partIds: string[]
  totalChars: number
  hasPrimaryText: boolean
}

export const truncateText = (value: string): string =>
  value.length <= MAX_TOOLTIP_LENGTH ? value : `${value.slice(0, MAX_TOOLTIP_LENGTH - 1).trimEnd()}…`

export function flattenNodeContent(content: unknown): string {
  if (typeof content === "string") return content
  if (content && typeof content === "object") {
    const obj = content as { text?: unknown; value?: unknown; content?: unknown[] }
    const parts: string[] = []
    if (typeof obj.text === "string") parts.push(obj.text)
    if (typeof obj.value === "string") parts.push(obj.value)
    if (Array.isArray(obj.content)) {
      parts.push(obj.content.map(flattenNodeContent).join("\n"))
    }
    return parts.filter(Boolean).join("\n")
  }
  return ""
}

export function collectReasoningText(part: ClientPart): string {
  if (!part) return ""
  const fields = part as PartFields
  if (typeof fields.text === "string") return fields.text
  if (Array.isArray(fields.content)) return flattenNodeContent(fields.content)
  return ""
}

export function collectTextFromPart(part: ClientPart, t: (key: string, params?: Record<string, unknown>) => string): string {
  if (!part) return ""
  const fields = part as PartFields
  if (part.type === "file") {
    const filename = fields.filename
    return typeof filename === "string" && filename.length > 0
      ? t("messageTimeline.text.filePrefix", { filename })
      : t("messageTimeline.text.attachment")
  }
  if (typeof fields.text === "string") return fields.text
  if (part.type === "reasoning") return collectReasoningText(part)
  if (Array.isArray(fields.content)) return flattenNodeContent(fields.content)
  return ""
}

export const getToolTitle = (part: ToolCallPart, t: (key: string, params?: Record<string, unknown>) => string): string => {
  const metadata = (((part as unknown as { state?: { metadata?: unknown } })?.state?.metadata) || {}) as { title?: unknown }
  return (typeof metadata.title === "string" && metadata.title.length > 0 ? metadata.title : undefined)
    ?? (typeof part.tool === "string" && part.tool.length > 0 ? part.tool : undefined)
    ?? t("messageTimeline.tool.fallbackLabel")
}

export const getToolTypeLabel = (part: ToolCallPart, t: (key: string, params?: Record<string, unknown>) => string): string =>
  (typeof part.tool === "string" && part.tool.trim().length > 0 ? part.tool.trim() : t("messageTimeline.tool.fallbackLabel")).slice(0, 4)

export const formatTextsTooltip = (texts: string[], fallback: string): string => {
  const combined = texts.map((text) => text.trim()).filter(Boolean).join("\n\n")
  return combined.length > 0 ? truncateText(combined) : fallback
}

export const formatToolTooltip = (titles: string[], t: (key: string, params?: Record<string, unknown>) => string): string =>
  titles.length === 0 ? t("messageTimeline.tool.fallbackLabel") : truncateText(`${t("messageTimeline.tool.fallbackLabel")}: ${titles.join(", ")}`)

export function buildTimelineSegments(
  instanceId: string,
  record: MessageRecord,
  t: (key: string, params?: Record<string, unknown>) => string,
): TimelineSegment[] {
  if (!record) return []
  const { orderedParts } = buildRecordDisplayData(instanceId, record)
  if (!orderedParts || orderedParts.length === 0) return []

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
        const fields = part as PartFields
        if (typeof fields.id === "string" && fields.id.length > 0) {
          target.partIds.push(fields.id)
        }
        target.totalChars += getPartCharCount(part)
      }
      continue
    }

    if (part.type === "compaction") {
      flushPending()
      const fields = part as PartFields
      const isAuto = Boolean(fields.auto)
      const partId = typeof fields.id === "string" ? fields.id : ""
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
      const fields = part as PartFields
      if (typeof fields.id === "string" && fields.id.length > 0) {
        target.partIds.push(fields.id)
      }
      target.totalChars += getPartCharCount(part)
    }
  }

  flushPending()
  return result
}
