import assert from "node:assert/strict"
import test from "node:test"
import { limitToolOutputForRender, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT } from "./utils.ts"

test("tool output rendering keeps bounded head and tail content", () => {
  const text = `HEAD${"x".repeat(20_000)}TAIL`
  const rendered = limitToolOutputForRender(text)
  assert.ok(rendered.length < text.length)
  assert.ok(rendered.length < TOOL_OUTPUT_RENDER_CHARACTER_LIMIT + 100)
  assert.ok(rendered.startsWith("HEAD"))
  assert.ok(rendered.endsWith("TAIL"))
})
