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
    const text = local.filter(segment => segment.type !== "tool").map(segment => segment.tooltip).join("\n") || entry?.preview || label
    const chars = local.length ? local.reduce((n, segment) => n + segment.totalChars, 0) : entry?.chars ?? 0
    const tools = entry?.tools ?? local.filter(segment => segment.type === "tool").length
    const result: TimelineSegment[] = [{ id: `${id}:outline`, messageId: id, type, label, tooltip: text.slice(0, 220), totalChars: chars }]
    if (tools) result.unshift({ id: `${id}:outline-tools`, messageId: id, type: "tool", label: t("messageTimeline.tool.fallbackLabel"),
      tooltip: t("history.counts", { messages: 1, tools, reasoning: entry?.reasoning ?? 0 }), totalChars: tools * 100,
      toolPartIds: local.flatMap(segment => segment.toolPartIds ?? []) })
    return result
  })
}

// Virtua keys rows by item identity. Keep unchanged historical markers mounted
// when resident streaming content changes; otherwise a hovered/focused target
// disappears on every token, even thousands of messages away from that token.
export function createSessionOutlineProjection() {
  let previous = new Map<string, TimelineSegment>()
  return (...args: Parameters<typeof projectSessionOutline>): TimelineSegment[] => {
    const segments = projectSessionOutline(...args).map(segment => {
      const cached = previous.get(segment.id)
      return cached && cached.type === segment.type && cached.label === segment.label
        && cached.tooltip === segment.tooltip && cached.totalChars === segment.totalChars
        && cached.toolPartIds?.length === segment.toolPartIds?.length
        && (segment.toolPartIds ?? []).every((id, index) => id === cached.toolPartIds?.[index])
        ? cached : segment
    })
    previous = new Map(segments.map(segment => [segment.id, segment]))
    return segments
  }
}
