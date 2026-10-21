import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildTimelineSegments, foldTimelineSegments, parseTimelineSegmentId, timelineRunStart, type TimelineSegment } from "./message-timeline-projection.ts"
import { isRecordPartDisplayed, revealHiddenRecordParts } from "../stores/message-v2/record-display-cache.ts"
import type { MessageRecord } from "../stores/message-v2/types.ts"

const t = (key: string) => key
type Part = Record<string, unknown> & { type: string }
const text = (): Part => ({ type: "text", text: "words" })
const thinking = (): Part => ({ type: "reasoning", text: "thought" })
const system = (): Part => ({ type: "system", text: "context" })
const tool = (name: string): Part => ({ type: "tool", tool: name, state: { status: "completed" } })

let instances = 0
function record(id: string, parts: Part[], role: "user" | "assistant" = "assistant"): MessageRecord {
  const partId = (index: number) => `${id}-${index}`
  return { id, sessionId: "s", role, status: "complete", createdAt: 1, updatedAt: 1, revision: 1,
    partIds: parts.map((_, index) => partId(index)),
    parts: Object.fromEntries(parts.map((part, index) => [partId(index), { id: partId(index), revision: 0, data: { id: partId(index), ...part } }])),
  } as unknown as MessageRecord
}
const segmentsOf = (records: MessageRecord[], instanceId = `fold-${++instances}`) => records.flatMap(value => buildTimelineSegments(instanceId, value, t))
const ids = (segments: readonly TimelineSegment[]) => segments.map(segment => segment.id)

interface Visibility { tools: ReadonlySet<string>; thinking: boolean; system: boolean }
const hiddenBy = (visibility: Visibility) => (segment: TimelineSegment) => segment.type === "tool" ? visibility.tools.has(segment.toolName ?? "")
  : segment.type === "reasoning" ? !visibility.thinking : segment.type === "system" && !visibility.system

/**
 * The transcript's rows, read off the native parts: a hidden tool leaves the
 * sequence, so the text or thinking around it continues its row; hidden
 * thinking and system context still end the row before them.
 */
function transcriptRows(parts: Part[], visibility: Visibility): string[] {
  const rows: string[] = []
  let previous = ""
  for (const part of parts) {
    const kind = part.type === "text" ? "assistant" : part.type
    if (kind === "tool" && visibility.tools.has(String(part.tool))) continue
    const shown = kind === "reasoning" ? visibility.thinking : kind === "system" ? visibility.system : true
    if (shown && (kind === "tool" || kind === "system" || kind !== previous)) rows.push(kind)
    previous = kind
  }
  return rows
}

describe("timeline markers follow the transcript's rows", () => {
  it("keeps one marker per content row when hidden thinking separates text around hidden tools", () => {
    const segments = segmentsOf([record("m", [text(), tool("bash"), thinking(), tool("read"), text()])])
    assert.deepEqual(ids(segments), ["m:assistant:0", "m:tool:0", "m:reasoning:0", "m:tool:1", "m:assistant:1"])
    const nothing = foldTimelineSegments(segments, hiddenBy({ tools: new Set(["bash", "read"]), thinking: false, system: false }))
    assert.deepEqual(ids(nothing.visible), ["m:assistant:0", "m:assistant:1"], "the hidden thinking still ends the first content row")
  })

  it("folds visible thinking around a hidden tool into its one group header", () => {
    const segments = segmentsOf([record("m", [thinking(), tool("fixture_alpha"), thinking(), text()])])
    const folded = foldTimelineSegments(segments, hiddenBy({ tools: new Set(["fixture_alpha"]), thinking: true, system: true }))
    assert.deepEqual(ids(folded.visible), ["m:reasoning:0", "m:assistant:0"])
    assert.equal(folded.representative.get("m:reasoning:1"), "m:reasoning:0", "the folded thinking is represented by its group's marker")
  })

  it("keeps a marker per tool, even when grouped tools span a hidden one, and never folds across messages", () => {
    const segments = segmentsOf([record("a", [tool("read"), tool("bash"), tool("read"), text()]), record("b", [text(), tool("bash"), text()])])
    const folded = foldTimelineSegments(segments, hiddenBy({ tools: new Set(["bash"]), thinking: true, system: true }))
    assert.deepEqual(ids(folded.visible), ["a:tool:0", "a:tool:2", "a:assistant:0", "b:assistant:0"])
    assert.equal(folded.representative.get("b:assistant:1"), "b:assistant:0")
  })

  it("matches the transcript's rows under every tool, thinking and system visibility", () => {
    const parts = [thinking(), text(), tool("fixture_alpha"), text(), tool("bash"), thinking(), tool("read"), thinking(), system(),
      text(), tool("read"), tool("bash"), tool("read"), thinking(), tool("fixture_alpha"), text(), system(), thinking()]
    const segments = segmentsOf([record("m", parts)])
    const names = ["fixture_alpha", "bash", "read"]
    let combinations = 0
    for (let mask = 0; mask < 1 << names.length; mask++) for (const thinkingShown of [false, true]) for (const systemShown of [false, true]) {
      const visibility = { tools: new Set(names.filter((_, index) => mask & (1 << index))), thinking: thinkingShown, system: systemShown }
      const folded = foldTimelineSegments(segments, hiddenBy(visibility))
      assert.deepEqual(folded.visible.map(segment => segment.type), transcriptRows(parts, visibility), JSON.stringify({ ...visibility, tools: [...visibility.tools] }))
      combinations++
    }
    assert.equal(combinations, 32)
  })
})

describe("timeline markers keep native ordinals across the omitted-parts window", () => {
  it("numbers displayed tools by their native position and reveals an omitted target", () => {
    const instanceId = `window-${++instances}`
    const value = record("m", [...Array.from({ length: 1001 }, () => tool("read")), text()])
    const loaded = buildTimelineSegments(instanceId, value, t)
    const tools = loaded.filter(segment => segment.type === "tool")
    assert.equal(tools.length, 999, "the display window omits two of the 1,001 tools")
    assert.ok(ids(loaded).includes("m:tool:1000"), "the last tool keeps its indexed marker identity")
    assert.ok(!ids(loaded).includes("m:tool:500") && !ids(loaded).includes("m:tool:501"))
    assert.equal(loaded.find(segment => segment.id === "m:tool:502")?.omittedBefore, true, "the omitted parts render before the next marker")
    assert.deepEqual(loaded.find(segment => segment.id === "m:tool:500"), undefined)
    // An indexed marker for omitted tool 500 targets native tool 500.
    const start = timelineRunStart(value, "m:tool:500", t)
    assert.equal(start, 500)
    assert.equal(isRecordPartDisplayed(instanceId, value, start!), false)
    revealHiddenRecordParts(instanceId, "m")
    assert.equal(isRecordPartDisplayed(instanceId, value, start!), true)
    const revealed = buildTimelineSegments(instanceId, value, t)
    assert.equal(revealed.find(segment => segment.id === "m:tool:500")?.toolPartIds?.[0], "m-500")
    assert.equal(revealed.find(segment => segment.id === "m:tool:1000")?.toolPartIds?.[0], "m-1000")
  })

  it("keeps a run split by the omitted parts as two markers, its tail continued", () => {
    const value = record("m", Array.from({ length: 1200 }, () => text()))
    const segments = segmentsOf([value])
    assert.deepEqual(ids(segments), ["m:assistant:0", "m:assistant:0:continued"])
    assert.equal(segments[1].omittedBefore, true)
    assert.deepEqual(ids(foldTimelineSegments(segments, () => false).visible), ids(segments), "no row spans the omitted parts")
    assert.deepEqual(parseTimelineSegmentId("m", "m:assistant:0:continued"), { type: "assistant", ordinal: 0, continued: true })
    assert.deepEqual(parseTimelineSegmentId("m", "m:tool:12"), { type: "tool", ordinal: 12, continued: false })
    assert.equal(parseTimelineSegmentId("m", "m:tool:x"), undefined)
    assert.equal(parseTimelineSegmentId("m", "other:tool:1"), undefined)
  })
})
