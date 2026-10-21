import type { OutlineEntry } from "../../../server/src/opencode/session-pruning/navigation-contract"
import { timelineSegmentId, timelineSegmentLabel, type TimelineSegment, type TimelineSegmentType } from "./message-timeline-projection"

type Translate = (key: string, params?: Record<string, unknown>) => string
const kindTypes: Record<string, TimelineSegmentType> = { U: "user", C: "compaction", S: "system", R: "reasoning", T: "assistant", X: "tool" }

const toolCount = (kinds: string) => kinds.replace(/[^X]/g, "").length

/**
 * The runs a bounded layout omits between `before` and `after`, in an order
 * the transcript could show: no two thinking or two text runs touch, as they
 * would share one row. Excess runs of one kind take a slot each between tools,
 * the balanced rest alternates within one slot.
 */
function omittedKinds(reasoning: number, text: number, tools: number, before = "", after = ""): string {
  const slots = Array.from({ length: tools + 1 }, () => "")
  const excess = reasoning > text ? "R" : "T", other = excess === "R" ? "T" : "R"
  let extra = Math.abs(reasoning - text)
  for (let slot = 0; slot < slots.length && extra > 0; slot++) {
    if ((slot === 0 && before === excess) || (slot === tools && after === excess)) continue
    slots[slot] = excess
    extra--
  }
  // Counts stay exact even for an arrangement the native order cannot have.
  if (extra > 0) slots[tools] += excess.repeat(extra)
  const pairs = Math.min(reasoning, text)
  const host = slots.findIndex(slot => slot === excess)
  if (host >= 0) slots[host] = excess + (other + excess).repeat(pairs)
  else if (pairs) {
    const startsWithText = before === "R" || (tools === 0 && after === "T")
    slots[0] = (startsWithText ? "TR" : "RT").repeat(pairs)
  }
  return slots.join("X")
}

/** The markers the transcript will show for an indexed message, in its part order. */
function outlineSegments(entry: OutlineEntry, t: Translate): TimelineSegment[] {
  let kinds = entry.type === "user" ? "U" : entry.type === "compaction" ? "C" : entry.type === "system" ? "S" : ""
  if (entry.type === "assistant") {
    // A long layout keeps its ends around the omitted runs' counts. An index
    // without layouts (an older plugin copy) has counts only: steps usually
    // think, answer, then call tools, and unknown text keeps its marker.
    const [head, tail] = entry.layout?.split("-") ?? []
    kinds = tail !== undefined
      ? head + omittedKinds(entry.omitted?.reasoning ?? 0, entry.omitted?.text ?? 0,
        Math.max(0, entry.tools - toolCount(head) - toolCount(tail)), head.at(-1), tail[0]) + tail
      : head !== undefined
        ? head + "X".repeat(Math.max(0, entry.tools - toolCount(head)))
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
        && cached.toolName === segment.toolName && cached.omittedBefore === segment.omittedBefore
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
