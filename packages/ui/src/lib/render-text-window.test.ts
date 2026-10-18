import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  getRenderTextWindow,
  joinedTextSource,
  MARKDOWN_TEXT_RENDER_CHARACTER_LIMIT,
  TEXT_REVEAL_CHARACTER_STEP,
  TOOL_OUTPUT_RENDER_CHARACTER_LIMIT,
} from "./render-text-window.ts"
import { largeOutput, measureRetainedBytes } from "./heap-retention.test-fixture.ts"

describe("getRenderTextWindow", () => {
  it("renders text within the bound whole", () => {
    const text = "x".repeat(TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)
    assert.deepEqual(getRenderTextWindow(text, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT), { text, hidden: 0, revealsAll: true, nextReveal: 0 })
    assert.deepEqual(getRenderTextWindow("", TOOL_OUTPUT_RENDER_CHARACTER_LIMIT), { text: "", hidden: 0, revealsAll: true, nextReveal: 0 })
  })

  it("keeps prose much longer than tool output", () => {
    // A subagent report of 10 865 characters used to be cut at 10 000.
    const report = "word ".repeat(2173)
    assert.equal(getRenderTextWindow(report, MARKDOWN_TEXT_RENDER_CHARACTER_LIMIT).hidden, 0)
    assert.ok(getRenderTextWindow(report, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT).hidden > 0)
  })

  it("ends on a nearby line break and counts every hidden character", () => {
    const lines = Array.from({ length: 2000 }, (_, index) => `line ${String(index).padStart(4, "0")}`).join("\n")
    const window = getRenderTextWindow(lines, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)
    assert.ok(window.text.endsWith("\n"))
    assert.ok(window.text.length <= TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)
    assert.ok(window.text.length > TOOL_OUTPUT_RENDER_CHARACTER_LIMIT * 0.9)
    assert.equal(window.text + lines.slice(window.text.length), lines)
    assert.equal(window.hidden, lines.length - window.text.length)
    assert.equal(window.revealsAll, true)
  })

  it("cuts a single long line at the budget without splitting a surrogate pair", () => {
    const text = `${"a".repeat(TOOL_OUTPUT_RENDER_CHARACTER_LIMIT - 1)}😀tail`
    const window = getRenderTextWindow(text, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)
    assert.equal(window.text, "a".repeat(TOOL_OUTPUT_RENDER_CHARACTER_LIMIT - 1))
    assert.equal(window.hidden, text.length - window.text.length)
  })

  it("reveals very large text in bounded steps, then all of it", () => {
    const text = "z".repeat(TOOL_OUTPUT_RENDER_CHARACTER_LIMIT + TEXT_REVEAL_CHARACTER_STEP * 2 + 5)
    const initial = getRenderTextWindow(text, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)
    assert.equal(initial.revealsAll, false)
    const first = getRenderTextWindow(text, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT, 1)
    assert.equal(first.text.length, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT + TEXT_REVEAL_CHARACTER_STEP)
    assert.equal(first.revealsAll, false)
    const second = getRenderTextWindow(text, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT, 2)
    assert.equal(second.hidden, 5)
    assert.equal(second.revealsAll, true)
    assert.equal(second.nextReveal, 5)
    assert.equal(getRenderTextWindow(text, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT, 3).text, text)
  })

  it("announces exactly what the next step reveals, including its line-break cut", () => {
    const lines = Array.from({ length: 70_000 }, (_, index) => `step line ${String(index).padStart(6, "0")}`).join("\n")
    for (let steps = 0; steps < 3; steps++) {
      const current = getRenderTextWindow(lines, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT, steps)
      const next = getRenderTextWindow(lines, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT, steps + 1)
      assert.equal(current.revealsAll, false)
      assert.equal(current.nextReveal, next.text.length - current.text.length)
      assert.notEqual(current.nextReveal, TEXT_REVEAL_CHARACTER_STEP, "line-break cuts make the step uneven")
    }
  })
})

describe("joinedTextSource", () => {
  const parts = ["$ ", "npm test", "\n", largeOutput("joined", 300_000)]

  it("windows exactly like the joined string", () => {
    const joined = parts.join("")
    for (const steps of [0, 1, 2]) {
      assert.deepEqual(getRenderTextWindow(joinedTextSource(parts), TOOL_OUTPUT_RENDER_CHARACTER_LIMIT, steps),
        getRenderTextWindow(joined, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT, steps))
    }
    const short = ["$ ", "ls", "\n", "a\nb"]
    assert.deepEqual(getRenderTextWindow(joinedTextSource(short), TOOL_OUTPUT_RENDER_CHARACTER_LIMIT),
      getRenderTextWindow(short.join(""), TOOL_OUTPUT_RENDER_CHARACTER_LIMIT))
    assert.equal(joinedTextSource(parts).slice(0, 5), "$ npm")
    assert.equal(joinedTextSource(parts).slice(8, 14), joined.slice(8, 14), "a slice may span parts")
  })

  it("keeps no joined copy of large outputs alive through a window", () => {
    // The outputs stay alive (like native tool state); only copies made for display count.
    const outputs = Array.from({ length: 10 }, (_, index) => largeOutput(`retained-${index}`, 1_400_000))
    const command = (index: number) => ["$ ", `cat log-${index}`, "\n", outputs[index]]
    const joinedWindows = measureRetainedBytes(() => outputs.map((_, index) => getRenderTextWindow(command(index).join(""), TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)))
    const sourceWindows = measureRetainedBytes(() => outputs.map((_, index) => getRenderTextWindow(joinedTextSource(command(index)), TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)))
    console.info("joined-window-retention", { joinedWindows: joinedWindows.bytes, sourceWindows: sourceWindows.bytes })
    assert.ok(joinedWindows.bytes > 10_000_000, `control: a window sliced from a full join retains it (${joinedWindows.bytes} bytes)`)
    assert.ok(sourceWindows.bytes < 1_000_000, `windows of a joined source retain only their prefix (${sourceWindows.bytes} bytes)`)
    assert.deepEqual(sourceWindows.value.map((window) => window.hidden), joinedWindows.value.map((window) => window.hidden))
  })
})
