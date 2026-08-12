import assert from "node:assert/strict"
import test from "node:test"
import { buildDiagnosticView } from "./diagnostics.ts"
import { isPermissionDiffTooLarge } from "./permission-constants.ts"
import { getLegacyTaskSummary, stringifyLegacyTaskSummary, TASK_STEP_RENDER_LIMIT } from "./renderers/task-summary.ts"
import { formatUnknownForCopy, formatUnknownForRender, limitToolOutputForRender, limitToolTitleForRender, shouldRenderDiffAsPlainText, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT, TOOL_TITLE_RENDER_CHARACTER_LIMIT } from "./utils.ts"

test("large tool output is bounded for rendering and complete for lazy copy", () => {
  const full = `HEAD${"x".repeat(20_000)}COPY_TAIL`
  const rendered = limitToolOutputForRender(full)
  assert.ok(rendered.length < TOOL_OUTPUT_RENDER_CHARACTER_LIMIT + 100)
  assert.equal(rendered.includes("COPY_TAIL"), false)
  assert.equal(formatUnknownForRender({ full })?.text.includes("COPY_TAIL"), false)
  assert.equal(formatUnknownForCopy({ full })?.text.includes("COPY_TAIL"), true)
})

test("tool titles and permission diffs share bounded policies", () => {
  assert.equal(limitToolTitleForRender("x".repeat(20_000)).length, TOOL_TITLE_RENDER_CHARACTER_LIMIT)
  assert.equal(isPermissionDiffTooLarge("x".repeat(TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)), false)
  assert.equal(isPermissionDiffTooLarge("x".repeat(TOOL_OUTPUT_RENDER_CHARACTER_LIMIT + 1)), true)
  assert.equal(shouldRenderDiffAsPlainText("x".repeat(TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)), false)
  assert.equal(shouldRenderDiffAsPlainText("x".repeat(TOOL_OUTPUT_RENDER_CHARACTER_LIMIT + 1)), true)
})

test("diagnostics retain severity while bounding rows and messages", () => {
  const diagnostics = {
    "src/file.ts": [
      ...Array.from({ length: 100 }, (_, index) => ({ message: `info ${index}`, severity: 3 })),
      { message: `${"x".repeat(2_000)}COPY_TAIL`, severity: 1 },
    ],
  }
  const view = buildDiagnosticView(diagnostics, ["src/file.ts"])
  assert.equal(view.entries.length, 100)
  assert.equal(view.entries[0]?.tone, "error")
  assert.equal(view.entries[0]?.message.length, 2_000)
  assert.equal(view.truncated, true)
  assert.equal(formatUnknownForCopy(view.diagnostics)?.text.includes("COPY_TAIL"), true)
})

test("legacy task summaries render 200 recent rows and copy all rows", () => {
  const summary = Array.from({ length: 250 }, (_, id) => ({ id }))
  const bounded = getLegacyTaskSummary(summary)
  assert.equal(bounded.renderedEntries.length, TASK_STEP_RENDER_LIMIT)
  assert.equal((bounded.renderedEntries[0] as { id: number }).id, 50)
  assert.equal(bounded.truncated, true)
  assert.equal(JSON.parse(stringifyLegacyTaskSummary(summary)).length, 250)
})
