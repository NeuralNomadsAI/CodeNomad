import assert from "node:assert/strict"
import test from "node:test"
import { bashRenderer } from "./renderers/bash.tsx"
import { defaultRenderer } from "./renderers/default.tsx"
import { editRenderer } from "./renderers/edit.tsx"
import { patchRenderer } from "./renderers/patch.tsx"
import { readRenderer } from "./renderers/read.tsx"
import { skillRenderer } from "./renderers/skill.tsx"
import { webfetchRenderer } from "./renderers/webfetch.tsx"
import { writeRenderer } from "./renderers/write.tsx"
import { getApplyPatchCopyAccess, getApplyPatchCopyOutput, getApplyPatchCopyText, getApplyPatchFilesForRender, getApplyPatchPathLabel, getApplyPatchRenderData, hasApplyPatchCopyText } from "./renderers/apply-patch-data.ts"
import { getTaskOutputCopyText } from "./renderers/task-summary.ts"
import { getTodoCopyText } from "./renderers/todo-data.ts"

const full = `${"x".repeat(10_000)}COPY_TAIL`
const base = { toolName: () => "tool", t: (key: string) => key } as any

const cases = [
  ["bash", bashRenderer, { status: "completed", input: { command: "echo" }, metadata: {}, output: full }],
  ["default", defaultRenderer, { status: "completed", input: {}, metadata: {}, output: full }],
  ["read", readRenderer, { status: "completed", input: { filePath: "file.ts" }, metadata: { preview: full }, output: "" }],
  ["write", writeRenderer, { status: "completed", input: { filePath: "file.ts", content: full }, metadata: {}, output: "" }],
  ["edit", editRenderer, { status: "completed", input: {}, metadata: {}, output: full }],
  ["patch", patchRenderer, { status: "completed", input: {}, metadata: {}, output: full }],
  ["webfetch", webfetchRenderer, { status: "completed", input: {}, metadata: {}, output: full }],
  ["skill", skillRenderer, { status: "completed", input: {}, metadata: {}, output: full }],
] as const

for (const [name, renderer, state] of cases) {
  test(`${name} resolves complete output only through lazy copy`, () => {
    const chrome = renderer.getOutputChrome?.({ ...base, toolName: () => name, toolState: () => state } as any)
    assert.equal(chrome?.copyText, undefined)
    assert.equal(chrome?.getCopyText?.()?.includes("COPY_TAIL"), true)
  })
}

for (const [name, renderer] of [["bash", bashRenderer], ["default", defaultRenderer], ["webfetch", webfetchRenderer], ["skill", skillRenderer]] as const) {
  test(`${name} hides copy chrome for known empty output`, () => {
    const state = { status: "completed", input: {}, metadata: {}, output: "" }
    assert.equal(renderer.getOutputChrome?.({ ...base, toolName: () => name, toolState: () => state } as any), undefined)
  })
}

test("apply_patch keeps the complete diff available for lazy copy", () => {
  assert.equal(getApplyPatchCopyText([{ diff: full }]).includes("COPY_TAIL"), true)
  assert.equal(hasApplyPatchCopyText([{ diff: full }]), true)
})

test("apply_patch joins aggregate output only when lazy copy resolves", () => {
  const originalJoin = Array.prototype.join
  let joins = 0
  Array.prototype.join = function (...args: Parameters<typeof originalJoin>) {
    joins += 1
    return originalJoin.apply(this, args)
  }
  try {
    const chrome = getApplyPatchCopyAccess([{ diff: "+one" }, { diff: "+two" }], "")
    assert.equal(joins, 0)
    assert.equal(chrome?.getCopyText?.(), "+one\n+two")
    assert.equal(joins, 1)
  } finally {
    Array.prototype.join = originalJoin
  }
})

test("empty apply_patch metadata falls back to completed output", () => {
  const output = "fallback output"
  assert.equal(getApplyPatchCopyOutput([{ diff: "" }], output), output)
})

test("apply_patch retains diagnostic-only files in render data", () => {
  assert.deepEqual(getApplyPatchFilesForRender([{ filePath: "empty.ts", diff: "" }], ["empty.ts"]).files, [{ filePath: "empty.ts", diff: "" }])
  assert.deepEqual(getApplyPatchFilesForRender([], ["diagnostic-only.ts"]).files, [{ filePath: "diagnostic-only.ts" }])
  assert.deepEqual(getApplyPatchFilesForRender([{ filePath: "C:\\repo\\src\\same.ts", diff: "" }], ["src/same.ts"]).files, [{ filePath: "C:\\repo\\src\\same.ts", diff: "" }])
})

test("apply_patch preserves lazy copy access when a diff exceeds the scan limit", () => {
  const fallback = "visible fallback"
  const files = [{ diff: " ".repeat(10_001) }]
  assert.equal(hasApplyPatchCopyText(files), true)
  assert.equal(getApplyPatchCopyAccess(files, fallback)?.getCopyText?.(), fallback)
  const rendered = getApplyPatchRenderData(getApplyPatchFilesForRender(files, []).files, 20, 100)
  assert.equal(rendered.rendered[0]?.diffText, "")
  assert.equal(rendered.truncated, true)
})

test("apply_patch does not scan through unbounded leading whitespace", () => {
  const whitespace = " ".repeat(20_000)
  assert.equal(getApplyPatchCopyAccess([{ diff: whitespace }, { diff: "+later" }], "fallback")?.getCopyText?.(), "+later")
  assert.equal(getApplyPatchCopyAccess([{ diff: whitespace }], "fallback")?.getCopyText?.(), "fallback")
  assert.equal(getApplyPatchFilesForRender([{ diff: `${whitespace}+visible` }], []).files.length, 1)
  const rendered = getApplyPatchRenderData([{ diff: `${whitespace}+visible` }], 20, 100)
  assert.equal(rendered.rendered[0]?.diffText, "")
  assert.equal(rendered.truncated, true)
  assert.equal(getApplyPatchCopyAccess([{ diff: `${whitespace}+visible` }], "")?.getCopyText?.()?.endsWith("+visible"), true)
})

test("apply_patch keeps files beyond the collection scan limit available to lazy copy", () => {
  const files = Array.from({ length: 10_001 }, (_, index) => ({ diff: index === 10_000 ? "+COPY_TAIL" : "" }))
  const access = getApplyPatchCopyAccess(files, "")
  assert.equal(access?.hasCopyText, true)
  assert.equal(access?.getCopyText?.(), "+COPY_TAIL")
})

test("task and todo keep complete output available for lazy copy", () => {
  assert.equal(getTaskOutputCopyText({ status: "completed", output: full })?.includes("COPY_TAIL"), true)
  assert.equal(getTodoCopyText({ status: "completed", input: {}, output: "", metadata: { todos: [{ content: full, status: "pending" }] } } as any).includes("COPY_TAIL"), true)
})

test("apply_patch signals per-file and outer truncation without losing copy payloads", () => {
  const perFile = getApplyPatchRenderData([{ diff: full }], 20, 10_000)
  assert.equal(perFile.truncated, true)
  assert.equal(perFile.rendered[0]?.diffText.includes("COPY_TAIL"), false)
  assert.equal(getApplyPatchCopyText(perFile.rendered.map(({ file }) => file)).includes("COPY_TAIL"), true)

  const files = Array.from({ length: 21 }, (_, index) => ({ diff: `diff-${index}` }))
  const outer = getApplyPatchRenderData(files, 20, Number.POSITIVE_INFINITY)
  assert.equal(outer.rendered.length, 20)
  assert.equal(outer.truncated, true)
  assert.equal(getApplyPatchCopyText(files).includes("diff-20"), true)
})

test("apply_patch selection stops after the rendered file limit", () => {
  const files = Array.from({ length: 20 }, (_, index) => ({ filePath: `file-${index}`, diff: `+${index}` })) as any[]
  Object.defineProperty(files, 20, { get: () => { throw new Error("unbounded file scan") } })
  files.length = 21
  const selected = getApplyPatchFilesForRender(files, [])
  assert.equal(selected.files.length, 20)
  assert.equal(selected.truncated, true)
})

test("apply_patch path labels are bounded from the path tail", () => {
  const label = getApplyPatchPathLabel(`C:\\repo\\${"x".repeat(20_000)}.ts`)
  assert.equal(label.length, 384)
  assert.equal(label.endsWith(".ts"), true)
})
