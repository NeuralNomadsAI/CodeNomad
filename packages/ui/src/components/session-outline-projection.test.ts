import assert from "node:assert/strict"
import { test } from "node:test"

import type { OutlineEntry } from "../../../server/src/opencode/session-pruning/navigation-contract"
import { createSessionOutlineProjection } from "./session-outline-projection"
import type { TimelineSegment } from "./message-timeline"

const t = (key: string) => key
const entry = (toolName = "shell"): OutlineEntry => ({
  id: "message", seq: 1, type: "assistant", tools: 1, reasoning: 0, toolName,
})
const resident = (toolName: string): TimelineSegment[] => [{
  id: "message:tool", messageId: "message", type: "tool", label: "tool", tooltip: toolName,
  toolName, toolPartIds: ["part"], totalChars: 10,
}, {
  id: "message:assistant", messageId: "message", type: "assistant", label: "assistant", tooltip: "done", totalChars: 4,
}]

test("outline tool groups retain a representative icon name without loading message bodies", () => {
  const project = createSessionOutlineProjection()
  const indexed = project([entry("shell")], [], t)
  assert.equal(indexed.find(segment => segment.type === "tool")?.toolName, "shell")

  const hydrated = project([entry("shell")], resident("read"), t)
  assert.equal(hydrated.find(segment => segment.type === "tool")?.toolName, "read")

  const updated = project([entry("grep")], [], t)
  assert.equal(updated.find(segment => segment.type === "tool")?.toolName, "grep",
    "marker identity caching must not retain an obsolete icon")
})

test("unchanged resident marker identities skip full-history projection and publication", () => {
  const project = createSessionOutlineProjection()
  let reads = 0
  const entries = Array.from({ length: 10_000 }, (_, index): OutlineEntry => ({
    id: index === 9999 ? "message" : `history-${index}`, seq: index, tools: 0, reasoning: 0,
    get type() { reads++; return "assistant" as const },
  }))
  const markers = resident("read")
  const initial = project(entries, markers, t)
  reads = 0
  for (let token = 0; token < 128; token++) {
    assert.equal(project(entries, [...markers], t), initial, "equivalent resident arrays must not invalidate the rail")
  }
  assert.equal(reads, 0, "unchanged markers must not inspect historical entries per token")
  const changed = markers.map(segment => segment.type === "assistant" ? { ...segment, tooltip: "new streamed prefix", totalChars: 128 } : segment)
  const updated = project(entries, changed, t)
  assert.notEqual(updated, initial)
  assert.equal(updated.find(segment => segment.id === "message:outline")?.tooltip, "new streamed prefix")
  assert.equal(updated[0], initial[0], "changed streaming markers preserve historical identity")
})

test("translation changes, authoritative outline replacements and resident removal invalidate cached projection", () => {
  const project = createSessionOutlineProjection()
  let locale = "en"
  const translate = (key: string) => `${locale}:${key}`
  const entries = [entry("shell")], markers = resident("read")
  const initial = project(entries, markers, translate)
  locale = "fr"
  const translated = project(entries, markers, translate)
  assert.notEqual(translated, initial, "the same translator identity must still observe locale changes")
  assert.ok(translated.every(segment => segment.label.startsWith("fr:")))
  const evicted = project(entries, [], translate)
  assert.equal(evicted.find(segment => segment.type === "tool")?.toolName, "shell")
  const replaced = project([entry("grep")], [], translate)
  assert.equal(replaced.find(segment => segment.type === "tool")?.toolName, "grep")
  assert.deepEqual(project([], [], translate), [])
  assert.equal(project(entries, markers, translate).find(segment => segment.type === "tool")?.toolName, "read")
})
