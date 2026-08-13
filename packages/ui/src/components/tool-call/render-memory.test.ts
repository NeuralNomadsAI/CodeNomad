import assert from "node:assert/strict"
import test from "node:test"
import { buildDiagnosticView } from "./diagnostics.ts"
import { getLegacyTaskSummary, getTaskOutputCopyText, getTruncatedTaskStepTitleCopyText, isTaskScanTruncated, isTaskStepListTruncated, resolveTaskStepTruncation, stringifyChildTaskSteps, stringifyLegacyTaskSummary, TASK_STEP_RENDER_LIMIT } from "./renderers/task-summary.ts"
import { extractTodosFromState, getRenderedTodos, getTodoCopyText, getTodoTitleKind, hasTodoCopyText, TODO_ITEM_RENDER_LIMIT } from "./renderers/todo-data.ts"
import { extractDiffPayload, formatToolInputForCopy, formatToolInputForRender, formatUnknownForCopy, formatUnknownForRender, limitToolOutputForRender, limitToolTitleForRender, shouldRenderDiffAsPlainText, shouldRenderDiffPayloadAsPlainText, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT, TOOL_TITLE_RENDER_CHARACTER_LIMIT } from "./utils.ts"

test("large tool output is bounded for rendering and complete for lazy copy", () => {
  const full = `HEAD${"x".repeat(20_000)}COPY_TAIL`
  const rendered = limitToolOutputForRender(full)
  assert.equal(rendered.length, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)
  assert.equal(rendered.includes("COPY_TAIL"), false)
  assert.equal(formatUnknownForRender({ full })?.text.includes("COPY_TAIL"), false)
  assert.equal(formatUnknownForCopy({ full })?.text.includes("COPY_TAIL"), true)
})

test("tool titles and diffs share bounded policies", () => {
  assert.equal(limitToolTitleForRender("x".repeat(20_000)).length, TOOL_TITLE_RENDER_CHARACTER_LIMIT)
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

test("task step truncation starts after the exact 200-item limit", () => {
  assert.equal(isTaskStepListTruncated(TASK_STEP_RENDER_LIMIT), false)
  assert.equal(isTaskStepListTruncated(TASK_STEP_RENDER_LIMIT + 1), true)
  assert.equal(getLegacyTaskSummary(Array.from({ length: TASK_STEP_RENDER_LIMIT })).truncated, false)
})

test("task truncation combines scan caps and ignores legacy state when child steps render", () => {
  assert.equal(isTaskScanTruncated(false, true, false), true)
  assert.equal(isTaskScanTruncated(true, false, false), true)
  assert.equal(resolveTaskStepTruncation(true, false, true), false)
  assert.equal(resolveTaskStepTruncation(false, false, true), true)
  assert.equal(resolveTaskStepTruncation(false, true, false), true)
})

test("expanded input renders bounded JSON but copies the complete display format", () => {
  const input = `${"x".repeat(20_000)}COPY_TAIL`
  const rendered = formatToolInputForRender(input)
  const copied = formatToolInputForCopy(input)
  assert.equal(rendered?.language, "json")
  assert.equal(rendered?.text.length, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)
  assert.equal(rendered?.text.includes("COPY_TAIL"), false)
  assert.equal(copied?.text, JSON.stringify(input, null, 2))
  assert.equal(copied?.text.includes("COPY_TAIL"), true)
})

test("a long legacy task title exposes its full copy below the step limit", () => {
  const title = `${"x".repeat(TOOL_TITLE_RENDER_CHARACTER_LIMIT)}COPY_TAIL`
  assert.equal(getLegacyTaskSummary([{ title }]).truncated, false)
  assert.equal(getTruncatedTaskStepTitleCopyText(title), title)
  assert.equal(getTruncatedTaskStepTitleCopyText("short"), null)
})

test("oversized structured input is not serialized until copy", () => {
  let serialized = 0
  const input = { body: "x".repeat(20_000), toJSON: () => { serialized += 1; return { body: "copied" } } }

  const rendered = formatToolInputForRender(input)
  assert.equal(serialized, 0)
  assert.equal(rendered?.language, "json")
  assert.ok((rendered?.text.length ?? Infinity) < TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)
  assert.equal(typeof JSON.parse(rendered?.text ?? ""), "string")

  assert.equal(formatToolInputForCopy(input)?.text, JSON.stringify({ body: "copied" }, null, 2))
  assert.equal(serialized, 1)
})

test("aggregate diffs use copy text length as the truncation fallback", () => {
  assert.equal(shouldRenderDiffPayloadAsPlainText({ diffText: "visible", copyText: "x".repeat(TOOL_OUTPUT_RENDER_CHARACTER_LIMIT + 1) }), true)
  assert.equal(shouldRenderDiffPayloadAsPlainText({ diffText: "visible", copyText: "visible plus omitted" }), false)
  assert.equal(shouldRenderDiffPayloadAsPlainText({ diffText: "visible", copyText: "visible" }), false)
})

test("todo title uses the full list while rendering is bounded and copy remains complete", () => {
  const tail = "COPY_TAIL"
  const state = {
    status: "completed",
    input: {},
    metadata: {
      todos: [
        { id: "1", content: "x".repeat(TOOL_OUTPUT_RENDER_CHARACTER_LIMIT), status: "completed" },
        { id: "2", content: tail, status: "pending" },
      ],
    },
    output: "",
  } as any

  assert.equal(getTodoTitleKind(state), "updating")
  const rendered = getRenderedTodos(JSON.parse(getTodoCopyText(state)))
  assert.equal(rendered.truncated, true)
  assert.equal(rendered.items.some((todo) => todo.content.includes(tail)), false)
  assert.equal(getTodoCopyText(state).includes(tail), true)
})

test("todo rendering stops normalizing after its visible character budget", () => {
  const todos = [{ content: "x".repeat(TOOL_OUTPUT_RENDER_CHARACTER_LIMIT), status: "pending" }] as any[]
  Object.defineProperty(todos, 1, { get: () => { throw new Error("unbounded todo scan") } })
  todos.length = 2
  const state = { status: "completed", input: {}, metadata: { todos }, output: "" } as any
  assert.equal(getRenderedTodos(extractTodosFromState(state)).truncated, true)
})

test("todo leading whitespace does not consume the visible content budget", () => {
  const state = {
    status: "completed",
    input: {},
    metadata: { todos: [{ content: `${" ".repeat(5_000)}meaningful todo`, status: "pending" }] },
    output: "",
  } as any
  const rendered = getRenderedTodos(extractTodosFromState(state))
  assert.equal(rendered.items[0]?.content, "meaningful todo")
})

test("todo leading whitespace retains truncation and lazy full copy", () => {
  const content = `${" ".repeat(200_000)}meaningful todo`
  const state = { status: "completed", input: {}, metadata: { todos: [{ content, status: "pending" }] }, output: "" } as any
  const rendered = getRenderedTodos(extractTodosFromState(state))
  assert.equal(rendered.items.length, 0)
  assert.equal(rendered.truncated, true)
  assert.equal(hasTodoCopyText(state), true)
  assert.equal(getTodoCopyText(state).includes(content), true)

  const many = Array.from({ length: TODO_ITEM_RENDER_LIMIT + 1 }, (_, index) => ({ content: String(index), status: "pending" }))
  assert.equal(getRenderedTodos(extractTodosFromState({ ...state, metadata: { todos: many } })).truncated, true)
})

test("oversized diff eligibility accepts a bounded hunk prefix", () => {
  const diff = `@@ -1 +1 @@\n-${"x".repeat(20_000)}\n+y`
  const state = { status: "completed", input: {}, metadata: { diff }, output: "" } as any
  assert.equal(extractDiffPayload("edit", state)?.diffText, diff)
})

test("task output copy retains content omitted from rendering", () => {
  assert.equal(getTaskOutputCopyText({ output: `x${"y".repeat(20_000)}COPY_TAIL` })?.includes("COPY_TAIL"), true)
})

test("child task step copy includes steps omitted from rendering", () => {
  const partIds = Array.from({ length: TASK_STEP_RENDER_LIMIT + 1 }, (_, index) => `part-${index}`)
  const message = { partIds, parts: Object.fromEntries(partIds.map((id) => [id, { data: { id, type: "tool" } }])) }
  assert.equal(JSON.parse(stringifyChildTaskSteps(["message"], () => message)).length, TASK_STEP_RENDER_LIMIT + 1)
})
