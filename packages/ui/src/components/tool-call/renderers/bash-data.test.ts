import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { ToolState } from "../../../types/tool-state"
import { interruptedShellOutput, shellOutput } from "./bash-data"

const notice = "[full output saved to /tmp/out.txt]\n\nCommand interrupted by the user (shell ID: sh_1)."
const interrupted = (error: string, metadata: Record<string, unknown> = { interrupted: true, truncated: false, shellID: "sh_1", notice }) =>
  ({ status: "error", input: { command: "npm test" }, error, metadata, time: { start: 1, end: 2 } }) as unknown as ToolState

describe("shell output", () => {
  it("splits an interrupted call into its output so far and the notice", () => {
    const state = interrupted(`line 1\nline 2\n\n${notice}`)
    assert.deepEqual(interruptedShellOutput(state), { output: "line 1\nline 2", notice })
    assert.equal(shellOutput(state), "line 1\nline 2")
  })

  it("keeps a notice-only interruption without inventing output", () => {
    const only = "[no output; output file: /tmp/out.txt]\n\nCommand interrupted by the user (shell ID: sh_1)."
    const state = interrupted(only, { interrupted: true, notice: only })
    assert.deepEqual(interruptedShellOutput(state), { output: "", notice: only })
    assert.equal(shellOutput(state), undefined)
  })

  it("leaves other failures, mismatched notices and older runtimes unchanged", () => {
    assert.equal(interruptedShellOutput(interrupted("boom", { interrupted: true, notice })), undefined)
    assert.equal(interruptedShellOutput(interrupted(`x\n\n${notice}`, { notice })), undefined)
    const legacy = { status: "error", input: {}, error: "Aborted", metadata: { output: "partial" }, time: { start: 1, end: 2 } } as unknown as ToolState
    assert.equal(interruptedShellOutput(legacy), undefined)
    assert.equal(shellOutput(legacy), "partial")
    assert.equal(shellOutput({ status: "completed", input: {}, output: "done", metadata: {}, title: "", time: { start: 1, end: 2 } } as unknown as ToolState), "done")
    assert.equal(shellOutput({ status: "pending", input: {} } as unknown as ToolState), undefined)
  })
})
