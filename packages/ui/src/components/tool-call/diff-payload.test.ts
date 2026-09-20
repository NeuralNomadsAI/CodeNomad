import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { ToolState } from "../../types/tool-state"
import { getDiffToolSearchText } from "./search-text"
import type { ToolSearchTextContext } from "./types"
import { extractDiffPayload } from "./utils"

const patch = [
  "Index: src/example.ts",
  "===================================================================",
  "--- src/example.ts",
  "+++ src/example.ts",
  "@@ -1,1 +1,1 @@",
  "-const value = 1",
  "+const value = needle",
  "",
].join("\n")

const v1State = {
  status: "completed",
  input: { filePath: "src/example.ts", oldString: "const value = 1", newString: "const value = needle" },
  metadata: { diff: patch },
  output: "Edited src/example.ts",
} as unknown as ToolState

const v2State = {
  status: "completed",
  input: { path: "src/example.ts", oldString: "const value = 1", newString: "const value = needle" },
  metadata: {
    files: [{ file: "src/example.ts", patch, additions: 1, deletions: 1, status: "modified" }],
  },
  output: "Edited src/example.ts (1 replacement)",
} as unknown as ToolState

function searchContext(toolState: ToolState): ToolSearchTextContext {
  return { toolCall: { id: "part-1", type: "tool", tool: "edit" } as unknown as ToolSearchTextContext["toolCall"], toolState, toolName: "edit" }
}

function countOccurrences(values: string[], needle: string): number {
  return values.join("\n").split(needle).length - 1
}

describe("edit tool diff payload", () => {
  it("extracts the diff from V1 metadata.diff", () => {
    const payload = extractDiffPayload("edit", v1State)
    assert.equal(payload?.diffText, patch)
    assert.equal(payload?.filePath, "src/example.ts")
  })

  it("extracts the diff from OpenCode 2.x metadata.files", () => {
    const payload = extractDiffPayload("edit", v2State)
    assert.equal(payload?.diffText, patch)
    assert.equal(payload?.filePath, "src/example.ts")
  })

  it("falls back to the FileDiff file name when the input has no path", () => {
    const state = { ...v2State, input: {} } as unknown as ToolState
    assert.equal(extractDiffPayload("edit", state)?.filePath, "src/example.ts")
  })

  it("indexes each diff line once for search in both formats", () => {
    // `needle` appears once in the patch (the + line) and once in input.newString.
    // The input strings are not indexed, so exactly one hit is expected.
    assert.equal(countOccurrences(getDiffToolSearchText(searchContext(v1State)), "needle"), 1)
    assert.equal(countOccurrences(getDiffToolSearchText(searchContext(v2State)), "needle"), 1)
  })
})
