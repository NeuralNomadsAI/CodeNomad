import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { getTimelineRecordSignature } from "./message-timeline-projection.ts"
import type { MessageRecord } from "../stores/message-v2/types.ts"

function record(parts: Array<{ id: string; type: string; text?: string; revision?: number }>): MessageRecord {
  return {
    id: "message",
    sessionId: "session",
    role: "assistant",
    status: "streaming",
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    partIds: parts.map((part) => part.id),
    parts: Object.fromEntries(parts.map((part) => [part.id, {
      id: part.id,
      revision: part.revision ?? 0,
      data: part as any,
    }])),
  }
}

describe("V2 timeline projection", () => {
  it("changes its structural signature when a provisional part is replaced at the same cardinality", () => {
    const provisional = record([{ id: "message-text-native-0", type: "text", text: "hello" }])
    const authoritative = record([{ id: "message-text-0", type: "text", text: "hello" }])

    assert.notEqual(getTimelineRecordSignature(provisional), getTimelineRecordSignature(authoritative))
  })

  it("invalidates each projected stream update and terminal state change", () => {
    const shortText = record([{ id: "text", type: "text", text: "a" }])
    const updatedText = record([{ id: "text", type: "text", text: "a longer streamed value", revision: 20 }])
    const shortCompaction = record([{ id: "compaction", type: "compaction", text: "a" }])
    const updatedCompaction = record([{ id: "compaction", type: "compaction", text: "a longer streamed value", revision: 20 }])
    const firstTool = record([{ id: "tool", type: "tool", revision: 1 }])
    const updatedTool = record([{ id: "tool", type: "tool", revision: 2 }])

    assert.notEqual(getTimelineRecordSignature(shortText), getTimelineRecordSignature(updatedText))
    assert.notEqual(getTimelineRecordSignature(shortCompaction), getTimelineRecordSignature(updatedCompaction))
    assert.notEqual(getTimelineRecordSignature(firstTool), getTimelineRecordSignature(updatedTool))
    const streaming = record([{ id: "text", type: "text", text: "partial" }])
    const complete = { ...record([{ id: "text", type: "text", text: "final response" }]), status: "complete" as const }
    assert.notEqual(getTimelineRecordSignature(streaming), getTimelineRecordSignature(complete))
  })
})
