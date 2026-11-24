import type { OutlineEntry } from "../../../server/src/opencode/session-pruning/navigation-contract"
import { sameTimelineList, sameTimelineSegment, timelineSegmentId, type TimelineSegment, type TimelineSegmentType } from "./message-timeline-projection"

const kindTypes: Record<string, TimelineSegmentType> = { U: "user", C: "compaction", S: "system", R: "reasoning", T: "assistant", X: "tool" }

const toolCount = (kinds: string) => kinds.replace(/[^X]/g, "").length

/**
 * The markers the transcript will show for an indexed message before any
 * reveal, as `buildTimelineSegments` keys them once it loads: the layout lists
 * the displayed parts' markers, and markers after the omitted parts skip the
 * native runs that start among them.
 */
function outlineSegments(entry: OutlineEntry): TimelineSegment[] {
  let head = entry.type === "user" ? "U" : entry.type === "compaction" ? "C" : entry.type === "system" ? "S" : ""
  let tail: string | undefined
  if (entry.type === "assistant") {
    // An index without layouts (an older plugin copy) has counts only: steps
    // usually think, answer, then call tools, and unknown text keeps its marker.
    if (entry.layout !== undefined) [head, tail] = entry.layout.split("-")
    else head = `${entry.reasoning ? "R" : ""}${entry.text !== 0 ? "T" : ""}${"X".repeat(entry.tools)}`
  }
  const ordinals = new Map<TimelineSegmentType, number>()
  const marker = (type: TimelineSegmentType, ordinal: number, after?: { continued: boolean }): TimelineSegment => ({
    id: timelineSegmentId(entry.id, type, ordinal, after?.continued), messageId: entry.id, type,
    ...(type === "tool" && entry.toolName?.trim() ? { toolName: entry.toolName.trim() } : {}),
    ...(after ? { omittedBefore: true as const } : {}) })
  const next = (type: TimelineSegmentType) => {
    const ordinal = ordinals.get(type) ?? 0
    ordinals.set(type, ordinal + 1)
    return ordinal
  }
  const segments = [...head].map(kind => marker(kindTypes[kind], next(kindTypes[kind])))
  if (tail === undefined) return segments
  const omitted = entry.omitted ?? { reasoning: 0, text: 0, continues: false }
  const skipped: Partial<Record<TimelineSegmentType, number>> = { reasoning: omitted.reasoning, assistant: omitted.text,
    tool: Math.max(0, entry.tools - toolCount(head) - toolCount(tail)) }
  for (const [type, count] of Object.entries(skipped) as Array<[TimelineSegmentType, number]>) ordinals.set(type, (ordinals.get(type) ?? 0) + count)
  return [...segments, ...[...tail].map((kind, index) => {
    const type = kindTypes[kind]
    // The first run after the omitted parts may continue the native run before
    // them: the head's last one (its continuation) or one that starts among them.
    if (index === 0 && omitted.continues && type !== "tool") return marker(type, (ordinals.get(type) ?? 1) - 1, { continued: !skipped[type] })
    return index === 0 ? marker(type, next(type), { continued: false }) : marker(type, next(type))
  })]
}

/**
 * Resident messages keep their exact markers, in transcript order; indexed
 * messages outside the window take their place in native sequence around them.
 * Resident messages the transcript hides have no markers.
 */
function projectSessionOutline(entries: readonly OutlineEntry[], resident: TimelineSegment[], residentIds: ReadonlySet<string>): TimelineSegment[] {
  if (!entries.length) return resident
  const position = new Map(entries.map((entry, index) => [entry.id, index]))
  const result: TimelineSegment[] = []
  let next = 0
  const indexedUntil = (end: number) => {
    for (; next < end; next++) if (!residentIds.has(entries[next].id)) result.push(...outlineSegments(entries[next]))
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

// The rail keys rows by item identity. Keep unchanged markers mounted when
// a new block, an authoritative outline or a different window changes the rail.
export function createSessionOutlineProjection() {
  let previous = new Map<string, TimelineSegment>()
  let previousEntries: readonly OutlineEntry[] | undefined
  let previousResident: readonly TimelineSegment[] = []
  let previousResidentIds: readonly string[] = []
  let previousSegments: TimelineSegment[] = []
  return (entries: readonly OutlineEntry[], resident: TimelineSegment[], residentIds: readonly string[]): TimelineSegment[] => {
    if (entries === previousEntries && sameTimelineList(residentIds, previousResidentIds)
      && sameTimelineList(resident, previousResident)) return previousSegments
    const segments = projectSessionOutline(entries, resident, new Set(residentIds)).map(segment => {
      const cached = previous.get(segment.id)
      return cached && sameTimelineSegment(cached, segment) ? cached : segment
    })
    previous = new Map(segments.map(segment => [segment.id, segment]))
    previousEntries = entries
    previousResident = resident
    previousResidentIds = residentIds
    if (!sameTimelineList(segments, previousSegments)) previousSegments = segments
    return previousSegments
  }
}
