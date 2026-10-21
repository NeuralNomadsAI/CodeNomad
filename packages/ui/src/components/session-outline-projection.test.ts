import assert from "node:assert/strict"
import { test } from "node:test"

import type { OutlineEntry } from "../../../server/src/opencode/session-pruning/navigation-contract"
import { createSessionOutlineProjection } from "./session-outline-projection"
import type { TimelineSegment } from "./message-timeline"

const t = (key: string) => key
const entry = (toolName = "shell"): OutlineEntry => ({
  id: "message", seq: 1, type: "assistant", tools: 1, reasoning: 0, toolName,
})
const resident = (toolName: string, messageId = "message"): TimelineSegment[] => [{
  id: `${messageId}:assistant:0`, messageId, type: "assistant", label: "assistant", tooltip: "done", partIds: [`${messageId}-text-0`], totalChars: 4,
}, {
  id: `${messageId}:tool:0`, messageId, type: "tool", label: "tool", tooltip: toolName,
  toolName, toolPartIds: [`${messageId}-part`], totalChars: 10,
}]
const user = (id: string, seq: number): OutlineEntry => ({ id, seq, type: "user", tools: 0, reasoning: 0 })
const step = (id: string, seq: number, layout?: string, tools = layout?.replace(/[^X]/g, "").length ?? 1): OutlineEntry => ({
  id, seq, type: "assistant", tools, reasoning: layout?.includes("R") ? 1 : 0, text: layout?.includes("T") ? 1 : 0,
  ...(tools ? { toolName: "read" } : {}), ...(layout === undefined ? {} : { layout }),
})

test("outline tool markers retain a representative icon name without loading message bodies", () => {
  const project = createSessionOutlineProjection()
  const indexed = project([entry("shell")], [], [], t)
  assert.equal(indexed.find(segment => segment.type === "tool")?.toolName, "shell")

  const hydrated = project([entry("shell")], resident("read"), ["message"], t)
  assert.equal(hydrated.find(segment => segment.type === "tool")?.toolName, "read")

  const updated = project([entry("grep")], [], [], t)
  assert.equal(updated.find(segment => segment.type === "tool")?.toolName, "grep",
    "marker identity caching must not retain an obsolete icon")
})

test("indexed messages get the markers the transcript shows for them, in part order", () => {
  const project = createSessionOutlineProjection()
  const ids = (entries: OutlineEntry[]) => project(entries, [], [], t).map(segment => segment.id)
  assert.deepEqual(ids([step("answer", 1, "RTXX")]), ["answer:reasoning:0", "answer:assistant:0", "answer:tool:0", "answer:tool:1"],
    "each tool keeps its own marker, after the reply that announced it")
  assert.deepEqual(ids([step("late", 1, "XTRX")]), ["late:tool:0", "late:assistant:0", "late:reasoning:0", "late:tool:1"])
  assert.deepEqual(ids([step("tools-only", 1, "X")]), ["tools-only:tool:0"], "a tool-only step has no reply marker")
  assert.equal(ids([step("long", 1, "X".repeat(64), 70)]).length, 70, "tools beyond the bounded layout follow it")
  // Older plugin copies report counts only: thinking, then text (kept when unknown), then tools.
  assert.deepEqual(ids([{ id: "older", seq: 1, type: "assistant", tools: 2, reasoning: 1, toolName: "read" }]),
    ["older:reasoning:0", "older:assistant:0", "older:tool:0", "older:tool:1"])
  assert.deepEqual(ids([{ id: "counted", seq: 1, type: "assistant", tools: 1, reasoning: 0, text: 0, toolName: "read" }]), ["counted:tool:0"])
  assert.deepEqual(ids([user("prompt", 1), { id: "compact", seq: 2, type: "compaction", tools: 0, reasoning: 0 },
    { id: "context", seq: 3, type: "system", tools: 0, reasoning: 0 }]), ["prompt:user:0", "compact:compaction:0", "context:system:0"])
  // The transcript renders no row for these native records.
  assert.deepEqual(ids(["shell", "synthetic", "idle", "agent-switched"].map((type, seq) => ({ id: type, seq, type: type as OutlineEntry["type"], tools: 0, reasoning: 0 }))), [])
})

test("resident messages keep their exact markers at their native position", () => {
  const project = createSessionOutlineProjection()
  const entries = [user("a", 1), step("b", 2, "TX"), user("c", 3), step("d", 4, "TX"), user("e", 5)]
  const order = (markers: TimelineSegment[], residentIds: string[]) => project(entries, markers, residentIds, t).map(segment => segment.id)
  assert.deepEqual(order([...resident("read", "b"), { id: "c:user:0", messageId: "c", type: "user", label: "user", tooltip: "", totalChars: 0 }], ["b", "c"]),
    ["a:user:0", "b:assistant:0", "b:tool:0", "c:user:0", "d:assistant:0", "d:tool:0", "e:user:0"], "a historical window sits between indexed history")
  assert.deepEqual(order([...resident("read", "d"), { id: "f:user:0", messageId: "f", type: "user", label: "user", tooltip: "", totalChars: 0 }], ["c", "d", "e", "f"]),
    ["a:user:0", "b:assistant:0", "b:tool:0", "d:assistant:0", "d:tool:0", "f:user:0"],
    "resident messages the transcript hides lose their indexed markers; messages newer than the index follow their predecessors")
})

test("unchanged resident marker identities skip full-history projection and publication", () => {
  const project = createSessionOutlineProjection()
  let reads = 0
  const entries = Array.from({ length: 10_000 }, (_, index): OutlineEntry => ({
    id: index === 9999 ? "message" : `history-${index}`, seq: index, tools: 0, reasoning: 0,
    get type() { reads++; return "assistant" as const },
  }))
  const markers = resident("read"), residentIds = ["message"]
  const initial = project(entries, markers, residentIds, t)
  reads = 0
  for (let token = 0; token < 128; token++) {
    assert.equal(project(entries, [...markers], residentIds, t), initial, "equivalent resident arrays must not invalidate the rail")
  }
  assert.equal(reads, 0, "unchanged markers must not inspect historical entries per token")
  const changed = markers.map(segment => segment.type === "assistant" ? { ...segment, tooltip: "new streamed prefix", totalChars: 128 } : segment)
  const updated = project(entries, changed, residentIds, t)
  assert.notEqual(updated, initial)
  assert.equal(updated.find(segment => segment.id === "message:assistant:0")?.tooltip, "new streamed prefix")
  assert.equal(updated[0], initial[0], "changed streaming markers preserve historical identity")
})

test("translation changes, authoritative outline replacements and resident removal invalidate cached projection", () => {
  const project = createSessionOutlineProjection()
  let locale = "en"
  const translate = (key: string) => `${locale}:${key}`
  const entries = [entry("shell"), user("later", 2)], markers = resident("read"), residentIds = ["message"]
  const initial = project(entries, markers, residentIds, translate)
  locale = "fr"
  const translated = project(entries, markers, residentIds, translate)
  assert.notEqual(translated, initial, "the same translator identity must still observe locale changes")
  assert.equal(translated.find(segment => segment.messageId === "later")?.label, "fr:messageTimeline.segment.user.label")
  const evicted = project(entries, [], [], translate)
  assert.equal(evicted.find(segment => segment.type === "tool")?.toolName, "shell")
  assert.ok(evicted.every(segment => segment.label.startsWith("fr:")))
  const replaced = project([entry("grep")], [], [], translate)
  assert.equal(replaced.find(segment => segment.type === "tool")?.toolName, "grep")
  assert.deepEqual(project([], [], [], translate), [])
  assert.equal(project(entries, markers, residentIds, translate).find(segment => segment.type === "tool")?.toolName, "read")
})
