import assert from "node:assert/strict"
import test from "node:test"
import { formatUnknownForCopy, limitToolOutputForRender, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT } from "./utils.ts"

test("tool output rendering keeps a bounded prefix without exposing fenced tail content", () => {
  const text = `HEAD${"x".repeat(20_000)}TAIL`
  const rendered = limitToolOutputForRender(text)
  assert.ok(rendered.length < text.length)
  assert.ok(rendered.length < TOOL_OUTPUT_RENDER_CHARACTER_LIMIT + 100)
  assert.ok(rendered.startsWith("HEAD"))
  assert.equal(rendered.includes("TAIL"), false)
})

test("tool output truncation cannot expose HTML from the tail of a fenced block", () => {
  const rendered = limitToolOutputForRender(`\`\`\`text\n${"x".repeat(20_000)}\n\`\`\`\n<img onerror=alert(1)>`)
  assert.equal(rendered.includes("<img"), false)
})

test("oversized structured output remains available for an explicit copy", () => {
  const value = { output: "x".repeat(20_000) }
  assert.equal(formatUnknownForCopy(value)?.text, JSON.stringify(value, null, 2))
})

test("explicit copy fails safely for pathologically nested arrays", () => {
  let value: unknown = "leaf"
  for (let depth = 0; depth < 20_000; depth += 1) value = [value]
  assert.doesNotThrow(() => formatUnknownForCopy(value))
})
