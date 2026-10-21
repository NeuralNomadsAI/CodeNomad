import type { TranscriptTechnicalGroup } from "../lib/message-part-grouping"
import type { TimelineSegment } from "./message-timeline-projection"

// A block cut by the viewport top within this distance is already read.
const READING_LINE_OFFSET_PX = 4
// Transcript blocks with a timeline marker, in document order.
const SEGMENT_BLOCK_SELECTOR = '.message-item-base[data-message-content-start-part-id], .tool-call-message[data-part-id], .message-technical-group-toggle, .message-reasoning-card[data-part-id], .message-compaction-card, [data-message-kind="system"]'

const shown = (element: Element | null | undefined): element is HTMLElement => element instanceof HTMLElement && element.getBoundingClientRect().height > 0

function transcriptRow(scroller: HTMLElement, messageId: string) {
  return scroller.querySelector<HTMLElement>(`[data-virtual-follow-key="${CSS.escape(messageId)}"]`)
}

/** The rendered transcript block a marker stands for; a collapsed group's tools share its header. */
export function findTimelineSegmentBlock(scroller: HTMLElement, segment: TimelineSegment,
  technicalGroupForPart: (messageId: string, partId: string) => TranscriptTechnicalGroup | undefined): HTMLElement | null {
  const row = transcriptRow(scroller, segment.messageId)
  if (!row) return null
  const byPart = (selector: (id: string) => string, ids: readonly string[] | undefined) =>
    (ids ?? []).map(id => row.querySelector(selector(CSS.escape(id)))).find(shown) ?? null
  // The header renders in the message where the group starts.
  const groupHeader = (partId: string | undefined) => {
    if (!partId) return null
    const start = technicalGroupForPart(segment.messageId, partId)?.parts[0]
    const scope = start ? transcriptRow(scroller, start.messageId) : row
    const header = scope?.querySelector(`[data-group-part-ids~="${CSS.escape(start?.partId ?? partId)}"] .message-technical-group-toggle`)
    return shown(header) ? header : null
  }
  switch (segment.type) {
    case "user":
    case "assistant":
      return byPart(id => `.message-item-base[data-message-content-start-part-id="${id}"]`, segment.partIds)
    case "reasoning":
      return byPart(id => `.message-reasoning-card[data-part-id="${id}"]`, segment.partIds) ?? groupHeader(segment.partIds?.[0])
    case "tool":
      return byPart(id => `.tool-call-message[data-part-id="${id}"]`, segment.toolPartIds) ?? groupHeader(segment.toolPartIds?.[0])
    case "compaction": {
      const card = row.querySelector(".message-compaction-card")
      return shown(card) ? card : null
    }
    case "system": {
      const block = row.querySelector('[data-message-kind="system"]')
      return shown(block) ? block : null
    }
  }
}

/** The marker of the first marked block reaching below the reading line, from the mounted rows only. */
export function readingLineSegmentId(scroller: HTMLElement, segmentsByMessage: ReadonlyMap<string, readonly TimelineSegment[]>): string | null {
  const line = scroller.getBoundingClientRect().top + READING_LINE_OFFSET_PX
  const rows = Array.from(scroller.querySelectorAll<HTMLElement>("[data-virtual-follow-key]"), row => ({ row, rect: row.getBoundingClientRect() }))
    .filter(({ rect }) => rect.height > 0 && rect.bottom > line)
    .sort((a, b) => a.rect.top - b.rect.top)
  for (const { row } of rows) {
    const messageId = row.dataset.virtualFollowKey!
    const segments = segmentsByMessage.get(messageId)
    if (!segments) continue
    for (const block of row.querySelectorAll<HTMLElement>(SEGMENT_BLOCK_SELECTOR)) {
      const rect = block.getBoundingClientRect()
      if (rect.height === 0 || rect.bottom <= line) continue
      const segment = segmentForBlock(messageId, segments, block)
      if (segment) return segment.id
    }
  }
  return null
}

function segmentForBlock(messageId: string, segments: readonly TimelineSegment[], block: HTMLElement) {
  const has = (ids: readonly string[] | undefined, id: string | undefined) => Boolean(id && ids?.includes(id))
  if (block.matches(".message-item-base")) {
    return block.dataset.messageId === messageId
      ? segments.find(segment => (segment.type === "user" || segment.type === "assistant") && has(segment.partIds, block.dataset.messageContentStartPartId))
      : undefined
  }
  if (block.matches(".tool-call-message")) return segments.find(segment => segment.type === "tool" && has(segment.toolPartIds, block.dataset.partId))
  if (block.matches(".message-reasoning-card")) return segments.find(segment => segment.type === "reasoning" && has(segment.partIds, block.dataset.partId))
  if (block.matches(".message-technical-group-toggle")) {
    const ids = block.closest<HTMLElement>("[data-group-part-ids]")?.dataset.groupPartIds?.split(" ") ?? []
    return segments.find(segment => ids.some(id => has(segment.toolPartIds, id) || (segment.type === "reasoning" && has(segment.partIds, id))))
  }
  return segments.find(segment => segment.type === (block.matches(".message-compaction-card") ? "compaction" : "system"))
}
