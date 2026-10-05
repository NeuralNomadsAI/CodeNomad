import type { OutlineEntry } from "../../../server/src/opencode/session-pruning/navigation-contract"
import type { TimelineSegment } from "./message-timeline"

function projectSessionOutline(entries: readonly OutlineEntry[], resident: readonly TimelineSegment[], t: (key: string, params?: Record<string, unknown>) => string): TimelineSegment[] {
  const byMessage = new Map<string, TimelineSegment[]>()
  for (const segment of resident) {
    const list = byMessage.get(segment.messageId) ?? []
    list.push(segment); byMessage.set(segment.messageId, list)
  }
  const metadata = new Map(entries.map(entry => [entry.id, entry]))
  const ids = [...entries.map(entry => entry.id), ...[...byMessage.keys()].filter(id => !metadata.has(id))]
  return ids.flatMap(id => {
    const entry = metadata.get(id)
    const local = byMessage.get(id) ?? []
    const nativeType = entry?.type ?? local.find(segment => segment.type !== "tool")?.type ?? "assistant"
    if (!["user", "assistant", "compaction", "shell"].includes(nativeType)) return []
    const type = nativeType === "user" ? "user" : nativeType === "compaction" ? "compaction" : "assistant"
    const label = t(`messageTimeline.segment.${type}.label`)
    const text = local.filter(segment => segment.type !== "tool").map(segment => segment.tooltip).join("\n")
    const chars = local.length ? local.reduce((n, segment) => n + segment.totalChars, 0) : 0
    const localTools = local.filter(segment => segment.type === "tool")
    const tools = local.length ? localTools.length : entry?.tools ?? 0
    const toolName = localTools.find(segment => segment.toolName?.trim())?.toolName ?? entry?.toolName
    const result: TimelineSegment[] = [{ id: `${id}:outline`, messageId: id, type, label, tooltip: text.slice(0, 220), totalChars: chars }]
    if (tools) result.unshift({ id: `${id}:outline-tools`, messageId: id, type: "tool", label: t("messageTimeline.tool.fallbackLabel"),
      tooltip: local.filter(segment => segment.type === "tool").map(segment => segment.tooltip).join("\n").slice(0, 220), totalChars: tools * 100,
      toolName: toolName?.trim() || undefined, toolPartIds: local.flatMap(segment => segment.toolPartIds ?? []) })
    return result
  })
}

// Virtua keys rows by item identity. Keep unchanged historical markers mounted
// when resident streaming content changes; otherwise a hovered/focused target
// disappears on every token, even thousands of messages away from that token.
export function createSessionOutlineProjection() {
  let previous = new Map<string, TimelineSegment>()
  let previousEntries: readonly OutlineEntry[] | undefined
  let previousResident: readonly TimelineSegment[] = []
  let previousLabels: string[] = []
  let previousSegments: TimelineSegment[] = []
  return (entries: readonly OutlineEntry[], resident: readonly TimelineSegment[], t: Parameters<typeof projectSessionOutline>[2]): TimelineSegment[] => {
    // Outline snapshots and resident markers are immutable publications. The
    // resident array is rebuilt per token, but its marker identities only change
    // when their structural signature changes. Avoid rescanning all history for
    // identical markers, and retain locale tracking even on this fast path.
    const labelKeys = ["messageTimeline.segment.user.label", "messageTimeline.segment.assistant.label",
      "messageTimeline.segment.compaction.label", "messageTimeline.tool.fallbackLabel"]
    const labels = labelKeys.map(key => t(key))
    if (entries === previousEntries && resident.length === previousResident.length
      && resident.every((segment, index) => segment === previousResident[index])
      && labels.every((label, index) => label === previousLabels[index])) return previousSegments
    const translated = new Map(labelKeys.map((key, index) => [key, labels[index]]))
    const segments = projectSessionOutline(entries, resident, key => translated.get(key) ?? t(key)).map(segment => {
      const cached = previous.get(segment.id)
      return cached && cached.type === segment.type && cached.label === segment.label
        && cached.tooltip === segment.tooltip && cached.totalChars === segment.totalChars
        && cached.toolName === segment.toolName
        && cached.toolPartIds?.length === segment.toolPartIds?.length
        && (segment.toolPartIds ?? []).every((id, index) => id === cached.toolPartIds?.[index])
        ? cached : segment
    })
    previous = new Map(segments.map(segment => [segment.id, segment]))
    previousEntries = entries
    previousResident = [...resident]
    previousLabels = labels
    if (segments.length !== previousSegments.length || segments.some((segment, index) => segment !== previousSegments[index])) {
      previousSegments = segments
    }
    return previousSegments
  }
}
