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

  it("changes its structural signature when a same-id part changes type or renderability", () => {
    const text = record([{ id: "part", type: "text", text: "hello" }])
    const empty = record([{ id: "part", type: "text", text: "" }])
    const tool = record([{ id: "part", type: "tool", revision: 1 }])

    assert.notEqual(getTimelineRecordSignature(text), getTimelineRecordSignature(empty))
    assert.notEqual(getTimelineRecordSignature(text), getTimelineRecordSignature(tool))
  })

  it("accepts provisional text and reasoning parts without text", () => {
    assert.doesNotThrow(() => getTimelineRecordSignature(record([{ id: "text", type: "text" }])))
    assert.doesNotThrow(() => getTimelineRecordSignature(record([{ id: "reasoning", type: "reasoning" }])))
    assert.equal(
      getTimelineRecordSignature(record([{ id: "text", type: "text" }])),
      getTimelineRecordSignature(record([{ id: "text", type: "text", text: "" }])),
    )
  })

  it("throttles streamed text projection updates and tracks tool revisions", () => {
    const shortText = record([{ id: "text", type: "text", text: "a" }])
    const sameBucketText = record([{ id: "text", type: "text", text: "a longer streamed value", revision: 20 }])
    const nextBucketText = record([{ id: "text", type: "text", text: "a".repeat(129), revision: 40 }])
    const firstTool = record([{ id: "tool", type: "tool", revision: 1 }])
    const updatedTool = record([{ id: "tool", type: "tool", revision: 2 }])

    assert.equal(getTimelineRecordSignature(shortText), getTimelineRecordSignature(sameBucketText))
    assert.notEqual(getTimelineRecordSignature(sameBucketText), getTimelineRecordSignature(nextBucketText))
    assert.notEqual(getTimelineRecordSignature(firstTool), getTimelineRecordSignature(updatedTool))
  })

  it("invalidates the projection once when streaming reaches a terminal status", () => {
    const streaming = record([{ id: "text", type: "text", text: "partial" }])
    const complete = { ...record([{ id: "text", type: "text", text: "final response" }]), status: "complete" as const }

    assert.notEqual(getTimelineRecordSignature(streaming), getTimelineRecordSignature(complete))
  })
})
