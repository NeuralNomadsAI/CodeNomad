import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  getRenderTextWindow,
  MARKDOWN_TEXT_RENDER_CHARACTER_LIMIT,
  TEXT_REVEAL_CHARACTER_STEP,
  TOOL_OUTPUT_RENDER_CHARACTER_LIMIT,
} from "./render-text-window.ts"

describe("getRenderTextWindow", () => {
  it("renders text within the bound whole", () => {
    const text = "x".repeat(TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)
    assert.deepEqual(getRenderTextWindow(text, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT), { text, hidden: 0, revealsAll: true })
    assert.deepEqual(getRenderTextWindow("", TOOL_OUTPUT_RENDER_CHARACTER_LIMIT), { text: "", hidden: 0, revealsAll: true })
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
    assert.equal(getRenderTextWindow(text, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT, 3).text, text)
  })
})
