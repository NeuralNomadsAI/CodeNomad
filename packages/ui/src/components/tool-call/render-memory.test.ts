import assert from "node:assert/strict"
import test from "node:test"

import {
  buildToolSpeechText,
  formatUnknownForRender,
  limitToolTitleForRender,
  shouldRenderDiffAsPlainText,
  TOOL_OUTPUT_RENDER_CHARACTER_LIMIT,
  TOOL_SPEECH_CHARACTER_LIMIT,
  TOOL_TITLE_RENDER_CHARACTER_LIMIT,
} from "./utils.ts"
import { getRenderTextWindow } from "../../lib/render-text-window.ts"
import { largeOutput, measureRetainedBytes } from "../../lib/heap-retention.test-fixture.ts"
import { collectChildTaskSteps } from "./renderers/task-summary.ts"
import { getApplyPatchRenderData } from "./renderers/apply-patch-data.ts"

test("bounds representative tool output, title, and diff rendering", () => {
  const tail = "COPY_TAIL"
  const output = `${"x".repeat(20_000)}${tail}`
  // Formatting keeps the native text; rendering bounds it with an in-place reveal.
  assert.equal(formatUnknownForRender(output)?.text, output)
  const rendered = getRenderTextWindow(output, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)
  assert.equal(rendered.text.length, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)
  assert.equal(rendered.text.includes(tail), false)
  assert.equal(rendered.hidden, output.length - TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)
  assert.equal(getRenderTextWindow(output, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT, 1).text, output)
  assert.equal(limitToolTitleForRender("x".repeat(20_000)).length, TOOL_TITLE_RENDER_CHARACTER_LIMIT)
  assert.equal(shouldRenderDiffAsPlainText("x".repeat(TOOL_OUTPUT_RENDER_CHARACTER_LIMIT + 1)), true)
  assert.equal(shouldRenderDiffAsPlainText("x".repeat(TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)), false)
})

test("tool speech keeps its own bound without the retired copy-only suffix", () => {
  const speech = buildToolSpeechText({ title: "Read", state: { status: "completed", input: {}, output: "y".repeat(30_000), metadata: {}, title: "", time: { start: 0, end: 1 } } as any, t: key => key })
  assert.equal(speech.length, TOOL_SPEECH_CHARACTER_LIMIT)
  assert.doesNotMatch(speech, /truncated|copy/i)
  const short = buildToolSpeechText({ title: "Shell", state: { status: "error", input: { command: "ls" }, error: "  boom  ", metadata: {}, time: { start: 0, end: 1 } } as any, t: key => key })
  assert.equal(short, 'Shell\n\ntoolCall.io.input:\n{\n  "command": "ls"\n}\n\ntoolCall.error.label boom')
})

test("tool speech of large outputs retains no copy of them", () => {
  const state = (index: number) => ({ status: "completed", input: { filePath: `/log-${index}` }, output: largeOutput(`speech-${index}`, 1_400_000),
    metadata: {}, title: "", time: { start: 0, end: 1 } }) as any
  // Control: the former join-then-slice keeps each whole join alive through its slice.
  const joined = measureRetainedBytes(() => Array.from({ length: 10 }, (_, index) =>
    ["Read", `Output:\n${state(index).output}`].join("\n\n").slice(0, TOOL_SPEECH_CHARACTER_LIMIT)))
  const speech = measureRetainedBytes(() => Array.from({ length: 10 }, (_, index) => buildToolSpeechText({ title: "Read", state: state(index), t: key => key })))
  console.info("tool-speech-retention", { joinThenSlice: joined.bytes, speech: speech.bytes })
  assert.ok(joined.bytes > 10_000_000, `control: a slice of a whole join retains it (${joined.bytes} bytes)`)
  assert.ok(speech.bytes < 1_000_000, `speech texts retain only their bounded sections (${speech.bytes} bytes)`)
  assert.ok(speech.value.every(text => text.length <= TOOL_SPEECH_CHARACTER_LIMIT))
})

test("apply_patch renders whole per-file diffs within the shared budget and reports only omitted files", () => {
  const first = `@@ -1 +1 @@\n${"+a\n".repeat(4000)}`
  const second = `@@ -1 +1 @@\n+b\n`
  const cut = getApplyPatchRenderData([{ diff: first }, { diff: second }], 20, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)
  assert.equal(cut.rendered.length, 1, "the budget is spent on the first file")
  assert.equal(cut.rendered[0].diffText, first, "the rendered file keeps its whole diff for an in-place reveal")
  assert.equal(cut.rendered[0].renderLimit, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)
  assert.equal(cut.truncated, true, "the omitted second file still reports truncation")

  const fits = getApplyPatchRenderData([{ diff: `\n\n${second}` }, { diff: second }], 20, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)
  assert.deepEqual(fits.rendered.map(file => file.diffText), [second, second], "leading whitespace is skipped")
  assert.equal(fits.rendered[1].renderLimit, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT - second.length)
  assert.equal(fits.truncated, false)
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
