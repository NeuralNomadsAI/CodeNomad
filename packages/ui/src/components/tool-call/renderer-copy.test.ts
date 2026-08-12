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
import { getApplyPatchCopyText } from "./renderers/apply-patch-data.ts"

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

test("apply_patch keeps the complete diff available for lazy copy", () => {
  assert.equal(getApplyPatchCopyText([{ diff: full }]).includes("COPY_TAIL"), true)
})
