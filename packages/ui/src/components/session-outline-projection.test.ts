import assert from "node:assert/strict"
import { test } from "node:test"

import { outlineLayoutEntrySchema, type OutlineEntry } from "../../../server/src/opencode/session-pruning/navigation-contract"
import { displayLayout } from "../../../server/src/opencode/session-pruning/outline-layout"
import { normalizeSessionMessage } from "../stores/message-v2/normalizers"
import type { MessageRecord } from "../stores/message-v2/types"
import { buildTimelineSegments, foldTimelineSegments, type TimelineSegment } from "./message-timeline-projection"
import { createSessionOutlineProjection } from "./session-outline-projection"

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
  // Older plugin copies report counts only: thinking, then text (kept when unknown), then tools.
  assert.deepEqual(ids([{ id: "older", seq: 1, type: "assistant", tools: 2, reasoning: 1, toolName: "read" }]),
    ["older:reasoning:0", "older:assistant:0", "older:tool:0", "older:tool:1"])
  assert.deepEqual(ids([{ id: "counted", seq: 1, type: "assistant", tools: 1, reasoning: 0, text: 0, toolName: "read" }]), ["counted:tool:0"])
  assert.deepEqual(ids([user("prompt", 1), { id: "compact", seq: 2, type: "compaction", tools: 0, reasoning: 0 },
    { id: "context", seq: 3, type: "system", tools: 0, reasoning: 0 }]), ["prompt:user:0", "compact:compaction:0", "context:system:0"])
  // The transcript renders no row for these native records.
  assert.deepEqual(ids(["shell", "synthetic", "idle", "agent-switched"].map((type, seq) => ({ id: type, seq, type: type as OutlineEntry["type"], tools: 0, reasoning: 0 }))), [])
})

// Native steps, from the plugin's real outline reader to the markers its loaded
// transcript shows (`buildTimelineSegments` over the client's normalized parts).
let tools = 0, instances = 0
const text = (value = "words") => ({ type: "text", text: value })
const blank = () => ({ type: "text", text: " \n" })
const thinking = () => ({ type: "reasoning", text: "thought" })
const tool = (name = "read") => ({ type: "tool", id: `tool-${++tools}`, name, time: { created: 1 }, state: { status: "completed", input: {}, content: [] } })
const repeat = (count: number, part: () => Record<string, unknown>) => Array.from({ length: count }, part)
const steps: Record<string, { content: Array<Record<string, unknown>>; error?: object }> = {
  interleaved: { content: Array.from({ length: 20 }, () => [text(), tool(), text(), thinking(), tool(), thinking()]).flat() },
  toolsThenText: { content: [...repeat(600, tool), ...repeat(600, text)] },
  continuedText: { content: repeat(1200, text) },
  headRunThroughTail: { content: [...repeat(450, tool), ...repeat(700, text)] },
  toolsThenReply: { content: [...repeat(1001, tool), text()] },
  omittedAlternation: { content: Array.from({ length: 400 }, () => [thinking(), text(), tool()]).flat() },
  blanksAroundOmitted: { content: [...repeat(499, tool), thinking(), ...repeat(300, blank), thinking(), ...repeat(400, tool), blank(), thinking()] },
  failedTools: { content: repeat(1000, tool), error: { type: "unknown", message: "failed" } },
}
// The plugin's layout from the kinds its SQL projects per native part (its
// reader is covered against SQLite in `navigation.test.ts`).
function loadedAndIndexed(name: string, step: { content: Array<Record<string, unknown>>; error?: object }) {
  const message = { id: `msg_${name}`, type: "assistant", agent: "build", model: { providerID: "p", id: "m" }, time: { created: 1, completed: 2 }, ...step }
  const kinds = step.content.flatMap((part, index) => {
    const visible = typeof part.text === "string" && part.text.trim().length > 0
    const kind = part.type === "tool" ? "X" : part.type === "reasoning" && visible ? "R" : part.type === "text" && visible ? "T" : ""
    return kind ? [`${index}${kind}`] : []
  }).join(",")
  const errorRow = step.error && !step.content.some(part => part.type === "text") ? 1 : 0
  const toolCount = step.content.filter(part => part.type === "tool").length
  const entry: OutlineEntry = { id: message.id, seq: 0, type: "assistant", tools: toolCount, reasoning: 0, text: 0,
    ...(toolCount ? { toolName: "read" } : {}), ...displayLayout(kinds, step.content.length + errorRow) }
  assert.equal(outlineLayoutEntrySchema.safeParse(entry).success, true, `${name} satisfies the outline contract`)
  const parts = normalizeSessionMessage("s", message as any).message.parts
  const record = { id: message.id, sessionId: "s", role: "assistant", status: "complete", createdAt: 1, updatedAt: 1, revision: 1,
    partIds: parts.map(part => part.id!), parts: Object.fromEntries(parts.map(part => [part.id!, { id: part.id!, revision: 0, data: part }])) } as unknown as MessageRecord
  return { entry, indexed: createSessionOutlineProjection()([entry], [], [], t), loaded: buildTimelineSegments(`outline-${++instances}`, record, t) }
}

test("indexed markers are the markers their loaded step shows, around omitted parts too, under every visibility", async () => {
  const shape = (segments: TimelineSegment[]) => segments.map(segment => `${segment.id}${segment.omittedBefore ? "|after-omitted" : ""}`)
  for (const [name, step] of Object.entries(steps)) {
    const { entry, indexed, loaded } = await loadedAndIndexed(name, step)
    assert.ok((entry.layout?.length ?? 0) <= 1001, `${name}: the layout stays within the display window`)
    assert.deepEqual(shape(indexed), shape(loaded), name)
    for (const hiddenTools of [false, true]) for (const hiddenThinking of [false, true]) {
      const hidden = (segment: TimelineSegment) => (hiddenTools && segment.type === "tool") || (hiddenThinking && segment.type === "reasoning")
      assert.deepEqual(foldTimelineSegments(indexed, hidden).visible.map(segment => segment.id),
        foldTimelineSegments(loaded, hidden).visible.map(segment => segment.id), `${name} ${hiddenTools} ${hiddenThinking}`)
    }
  }
  // With Nothing, each pair of replies around a hidden tool shares one row.
  const { indexed } = await loadedAndIndexed("interleaved", steps.interleaved)
  assert.equal(foldTimelineSegments(indexed, segment => segment.type !== "assistant").visible.length, 20)
  const { entry: split } = await loadedAndIndexed("toolsThenText", steps.toolsThenText)
  assert.deepEqual(split.omitted, { reasoning: 0, text: 1, continues: true }, "the reply after the omitted parts starts among them")
  for (const name of ["continuedText", "headRunThroughTail"]) {
    const { indexed: continued } = await loadedAndIndexed(name, steps[name])
    assert.ok(continued.some(segment => segment.id === `msg_${name}:assistant:0:continued` && segment.omittedBefore), `${name} continues its run after the omitted parts`)
  }
  const { entry: failed } = await loadedAndIndexed("failedTools", steps.failedTools)
  assert.ok(failed.layout?.includes("-"), "the error row the transcript adds can push a step past the display limit")
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
