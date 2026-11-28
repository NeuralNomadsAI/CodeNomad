import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildTimelineSegments, timelineSegmentTooltip } from "./message-timeline-projection.ts"
import type { MessageRecord } from "../stores/message-v2/types.ts"

function record(parts: Array<{ id: string; type: string; text?: string; tool?: string; state?: object; auto?: boolean }>, revision = 1): MessageRecord {
  return {
    id: "message",
    sessionId: "session",
    role: "assistant",
    status: "streaming",
    createdAt: 1,
    updatedAt: 1,
    revision,
    partIds: parts.map((part) => part.id),
    parts: Object.fromEntries(parts.map((part) => [part.id, {
      id: part.id,
      revision,
      data: part as any,
    }])),
  }
}

describe("V2 timeline projection", () => {
  const segments = (value: MessageRecord) => buildTimelineSegments("instance", value)

  it("keeps the same markers when text grows and tool payloads settle", () => {
    const text = { id: "text", type: "text", text: "a" }
    const tool = { id: "tool", type: "tool", tool: "read", state: { status: "running", input: {} } }
    const initial = segments(record([text, tool]))
    const updated = { ...record([{ ...text, text: "b".repeat(2000) },
      { ...tool, state: { status: "completed", metadata: { title: "Changed" }, output: "result" } }], 2), status: "complete" as const }
    assert.deepEqual(segments(updated), initial)
    assert.equal(timelineSegmentTooltip(initial[0], updated, key => key), "b".repeat(219) + "…")
    assert.equal(timelineSegmentTooltip(initial[1], updated, () => "Tool"), "Tool: Changed")
  })

  it("does not slice a large second fragment when the accessible excerpt is full", () => {
    const first = "a".repeat(220)
    const second = "b".repeat(1024 * 1024)
    const value = record([{ id: "first", type: "text", text: first }, { id: "second", type: "text", text: second }])
    const [segment] = segments(value)
    const slice = String.prototype.slice
    let longestSecondSlice = 0
    String.prototype.slice = function (start?: number, end?: number) {
      const result = slice.call(this, start, end)
      if (String(this) === second) longestSecondSlice = Math.max(longestSecondSlice, result.length)
      return result
    }
    try {
      assert.equal(timelineSegmentTooltip(segment, value, key => key), "a".repeat(219) + "…")
    } finally {
      String.prototype.slice = slice
    }
    assert.equal(longestSecondSlice, 0, "the separator exhausts the excerpt budget")
  })

  it("updates the target when a provisional part is replaced at the same cardinality", () => {
    const provisional = record([{ id: "message-text-native-0", type: "text", text: "hello" }])
    const authoritative = record([{ id: "message-text-0", type: "text", text: "hello" }])

    assert.equal(segments(provisional)[0].id, segments(authoritative)[0].id)
    assert.deepEqual(segments(authoritative)[0].partIds, ["message-text-0"])
  })

  it("retains meaningful visibility, icon and compaction information", () => {
    assert.deepEqual(segments(record([{ id: "text", type: "text", text: " \n" }])), [])
    assert.equal(segments(record([{ id: "tool", type: "tool", tool: "bash" }]))[0].toolName, "bash")
    assert.equal(segments(record([{ id: "compaction", type: "compaction", auto: true }]))[0].variant, "auto")
  })
})
