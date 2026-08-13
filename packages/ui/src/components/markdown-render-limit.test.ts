import assert from "node:assert/strict"
import test from "node:test"
import { getMarkdownTextForRender } from "./markdown.tsx"
import { TOOL_OUTPUT_RENDER_CHARACTER_LIMIT } from "./tool-call/utils.ts"

test("ordinary markdown is bounded before parsing or escaping", () => {
  const rendered = getMarkdownTextForRender(`${"<".repeat(20_000)}COPY_TAIL`)
  assert.equal(rendered.length, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)
  assert.equal(rendered.includes("COPY_TAIL"), false)
  assert.equal(rendered.includes("Output truncated for rendering"), true)
})

test("truncated markdown retains the full original outside the parse input", () => {
  const source = `${"x".repeat(20_000)}COPY_TAIL`
  assert.equal(getMarkdownTextForRender(source).includes("COPY_TAIL"), false)
  assert.equal(source.includes("COPY_TAIL"), true)
})
