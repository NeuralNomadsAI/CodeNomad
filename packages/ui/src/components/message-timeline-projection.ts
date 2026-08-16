import { partHasRenderableText } from "../types/message"
import type { MessageRecord } from "../stores/message-v2/types"

export function getTimelineRecordSignature(record: MessageRecord): string {
  const parts = record.partIds.map((partId) => {
    const part = record.parts[partId]
    const data = part?.data
    const structuralRevision = data?.type === "tool" || data?.type === "compaction" ? part.revision : 0
    const fileName = data?.type === "file" && typeof data.filename === "string" ? data.filename : ""
    return `${partId}:${data?.type ?? "unknown"}:${data && partHasRenderableText(data) ? 1 : 0}:${structuralRevision}:${fileName}`
  }).join("|")
  return `${record.status}|${parts}`
}
