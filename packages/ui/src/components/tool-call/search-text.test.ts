import assert from "node:assert/strict"
import test from "node:test"
import { getTaskToolSearchText } from "./search-text.ts"

test("task search keeps visible output ahead of an oversized prompt", () => {
  const values = getTaskToolSearchText({
    toolCall: { type: "tool", id: "tool", tool: "task", state: {} } as any,
    toolName: "task",
    toolState: { status: "completed", input: { prompt: "x".repeat(20_000) }, output: "UNIQUE_RESULT" } as any,
  })
  assert.equal(values.join("\n").includes("UNIQUE_RESULT"), true)
})
