import assert from "node:assert/strict"
import test from "node:test"

import {
  limitToolOutputForRender,
  limitToolTitleForRender,
  shouldRenderDiffAsPlainText,
  TOOL_OUTPUT_RENDER_CHARACTER_LIMIT,
  TOOL_TITLE_RENDER_CHARACTER_LIMIT,
} from "./utils.ts"
import { collectChildTaskSteps } from "./renderers/task-summary.ts"

test("bounds representative tool output, title, and diff rendering", () => {
  const tail = "COPY_TAIL"
  const rendered = limitToolOutputForRender(`${"x".repeat(20_000)}${tail}`)
  assert.equal(rendered.length, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)
  assert.equal(rendered.includes(tail), false)
  assert.equal(limitToolTitleForRender("x".repeat(20_000)).length, TOOL_TITLE_RENDER_CHARACTER_LIMIT)
  assert.equal(shouldRenderDiffAsPlainText("x".repeat(TOOL_OUTPUT_RENDER_CHARACTER_LIMIT + 1)), true)
})

test("collects complete child task steps across message windows", () => {
  const messages = new Map([
    ["first", { partIds: ["tool-1", "text"], parts: { "tool-1": { data: { id: "tool-1", type: "tool" } }, text: { data: { id: "text", type: "text" } } } }],
    ["second", { partIds: ["tool-2"], parts: { "tool-2": { data: { id: "tool-2", type: "tool" } } } }],
  ])

  assert.deepEqual(collectChildTaskSteps(["first", "second"], (id) => messages.get(id)), [
    { id: "tool-1", type: "tool" },
    { id: "tool-2", type: "tool" },
  ])
})
