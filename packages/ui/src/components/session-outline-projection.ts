import type { OutlineEntry } from "../../../server/src/opencode/session-pruning/navigation-contract"
import { timelineSegmentId, timelineSegmentLabel, type TimelineSegment, type TimelineSegmentType } from "./message-timeline-projection"

type Translate = (key: string, params?: Record<string, unknown>) => string
const kindTypes: Record<string, TimelineSegmentType> = { U: "user", C: "compaction", S: "system", R: "reasoning", T: "assistant", X: "tool" }

/** The markers the transcript will show for an indexed message, in its part order. */
function outlineSegments(entry: OutlineEntry, t: Translate): TimelineSegment[] {
  let kinds = entry.type === "user" ? "U" : entry.type === "compaction" ? "C" : entry.type === "system" ? "S" : ""
  if (entry.type === "assistant") {
    // The layout lists the first 64 kinds; later tools follow it. An index from
    // an older plugin copy has none: steps usually think, answer, then call
    // tools, and unknown text keeps its marker.
    kinds = entry.layout !== undefined
      ? entry.layout + "X".repeat(Math.max(0, entry.tools - entry.layout.replace(/[^X]/g, "").length))
      : `${entry.reasoning ? "R" : ""}${entry.text !== 0 ? "T" : ""}${"X".repeat(entry.tools)}`
  }
  const ordinals = new Map<TimelineSegmentType, number>()
  return [...kinds].map(kind => {
    const type = kindTypes[kind], ordinal = ordinals.get(type) ?? 0
    ordinals.set(type, ordinal + 1)
    return { id: timelineSegmentId(entry.id, type, ordinal), messageId: entry.id, type, label: timelineSegmentLabel(type, t), tooltip: "",
      totalChars: type === "tool" ? 100 : 0, ...(type === "tool" && entry.toolName?.trim() ? { toolName: entry.toolName.trim() } : {}) }
  })
}

/**
 * Resident messages keep their exact markers, in transcript order; indexed
 * messages outside the window take their place in native sequence around them.
 * Resident messages the transcript hides have no markers.
 */
function projectSessionOutline(entries: readonly OutlineEntry[], resident: readonly TimelineSegment[], residentIds: ReadonlySet<string>, t: Translate): TimelineSegment[] {
  const position = new Map(entries.map((entry, index) => [entry.id, index]))
  const result: TimelineSegment[] = []
  let next = 0
  const indexedUntil = (end: number) => {
    for (; next < end; next++) if (!residentIds.has(entries[next].id)) result.push(...outlineSegments(entries[next], t))
  }
  for (const segment of resident) {
    const at = position.get(segment.messageId)
    if (at !== undefined && at >= next) {
      indexedUntil(at)
      next = at + 1
    }
    result.push(segment)
  }
  indexedUntil(entries.length)
  return result
}

// Virtua keys rows by item identity. Keep unchanged historical markers mounted
// when resident streaming content changes; otherwise a hovered/focused target
// disappears on every token, even thousands of messages away from that token.
export function createSessionOutlineProjection() {
  let previous = new Map<string, TimelineSegment>()
  let previousEntries: readonly OutlineEntry[] | undefined
  let previousResident: readonly TimelineSegment[] = []
  let previousResidentIds: readonly string[] = []
  let previousLabels: string[] = []
  let previousSegments: TimelineSegment[] = []
  return (entries: readonly OutlineEntry[], resident: readonly TimelineSegment[], residentIds: readonly string[], t: Translate): TimelineSegment[] => {
    // Outline snapshots and resident markers are immutable publications. The
    // resident arrays are rebuilt per token, but the window's ids and its marker
    // identities only change with its structure. Avoid rescanning all history
    // for identical markers, and retain locale tracking even on this fast path.
    const labelKeys = ["messageTimeline.segment.user.label", "messageTimeline.segment.assistant.label",
      "messageTimeline.segment.compaction.label", "messageTimeline.tool.fallbackLabel", "messageBlock.reasoning.thoughtLabel", "messageBlock.system.label"]
    const labels = labelKeys.map(key => t(key))
    if (entries === previousEntries && resident.length === previousResident.length
      && residentIds.length === previousResidentIds.length && residentIds.every((id, index) => id === previousResidentIds[index])
      && resident.every((segment, index) => segment === previousResident[index])
      && labels.every((label, index) => label === previousLabels[index])) return previousSegments
    const translated = new Map(labelKeys.map((key, index) => [key, labels[index]]))
    const segments = projectSessionOutline(entries, resident, new Set(residentIds), key => translated.get(key) ?? t(key)).map(segment => {
      const cached = previous.get(segment.id)
      return cached && cached.type === segment.type && cached.label === segment.label
        && cached.tooltip === segment.tooltip && cached.totalChars === segment.totalChars
        && cached.toolName === segment.toolName
        && cached.toolPartIds?.length === segment.toolPartIds?.length
        && (segment.toolPartIds ?? []).every((id, index) => id === cached.toolPartIds?.[index])
        && cached.partIds?.length === segment.partIds?.length
        && (segment.partIds ?? []).every((id, index) => id === cached.partIds?.[index])
        ? cached : segment
    })
    previous = new Map(segments.map(segment => [segment.id, segment]))
    previousEntries = entries
    previousResident = [...resident]
    previousResidentIds = [...residentIds]
    previousLabels = labels
    if (segments.length !== previousSegments.length || segments.some((segment, index) => segment !== previousSegments[index])) {
      previousSegments = segments
    }
    return previousSegments
  }
}
