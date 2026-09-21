import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { ToolState } from "../../types/tool-state"
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

  it("extracts a single-file OpenCode 2.x patch", () => {
    const state = { ...v2State, input: {} } as unknown as ToolState
    assert.equal(extractDiffPayload("patch", state)?.diffText, patch)
  })

  it("does not reduce a multi-file OpenCode 2.x patch to its first file", () => {
    const otherPatch = patch.split("src/example.ts").join("src/other.ts")
    const state = {
      status: "completed",
      input: {},
      metadata: {
        files: [
          { file: "src/example.ts", patch, additions: 1, deletions: 1, status: "modified" },
          { file: "src/other.ts", patch: otherPatch, additions: 1, deletions: 1, status: "modified" },
        ],
      },
      output: "Applied patch to 2 files",
    } as unknown as ToolState
    assert.equal(extractDiffPayload("patch", state), null)
  })
})
