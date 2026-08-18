import assert from "node:assert/strict"
import test from "node:test"

import {
  limitToolOutputForRender,
  limitToolTitleForRender,
  shouldRenderDiffAsPlainText,
  TOOL_OUTPUT_RENDER_CHARACTER_LIMIT,
  TOOL_TITLE_RENDER_CHARACTER_LIMIT,
} from "./utils.ts"

test("bounds representative tool output, title, and diff rendering", () => {
  const tail = "COPY_TAIL"
  const rendered = limitToolOutputForRender(`${"x".repeat(20_000)}${tail}`)
  assert.equal(rendered.length, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)
  assert.equal(rendered.includes(tail), false)
  assert.equal(limitToolTitleForRender("x".repeat(20_000)).length, TOOL_TITLE_RENDER_CHARACTER_LIMIT)
  assert.equal(shouldRenderDiffAsPlainText("x".repeat(TOOL_OUTPUT_RENDER_CHARACTER_LIMIT + 1)), true)
})
