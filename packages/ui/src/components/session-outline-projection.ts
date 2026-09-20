import type { OutlineEntry } from "../../../server/src/opencode/session-pruning/navigation-contract"
import type { TimelineSegment } from "./message-timeline"

export function projectSessionOutline(entries: readonly OutlineEntry[], resident: readonly TimelineSegment[], t: (key: string, params?: Record<string, unknown>) => string): TimelineSegment[] {
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
