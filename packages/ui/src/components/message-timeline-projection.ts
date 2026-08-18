import { partHasRenderableText } from "../types/message"
import type { MessageRecord } from "../stores/message-v2/types"

const STREAMED_TEXT_SIGNATURE_BUCKET = 128

export function getTimelineRecordSignature(record: MessageRecord): string {
  const parts = record.partIds.map((partId) => {
    const part = record.parts[partId]
    const data = part?.data
    const structuralRevision = data?.type === "tool" || data?.type === "compaction" ? part.revision : 0
    const fileName = data?.type === "file" && typeof data.filename === "string" ? data.filename : ""
    const textLength = (data?.type === "text" || data?.type === "reasoning") && typeof data.text === "string"
      ? data.text.length
      : 0
    const textBucket = Math.ceil(textLength / STREAMED_TEXT_SIGNATURE_BUCKET)
    return `${partId}:${data?.type ?? "unknown"}:${data && partHasRenderableText(data) ? 1 : 0}:${structuralRevision}:${fileName}:${textBucket}`
  }).join("|")
  return `${record.status}|${parts}`
}
