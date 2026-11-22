import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { ToolState } from "../../types/tool-state"
import { patchRenderer } from "./renderers/patch"
import type { ToolCallPart, ToolRendererContext } from "./types"
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

  describe("multi-file OpenCode 2.x patch", () => {
    const otherPatch = patch.replaceAll("src/example.ts", "src/other.ts").replace("needle", "secondNeedle")
    const toolState = {
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
    it("does not reduce the patch to its first file", () => {
      assert.equal(extractDiffPayload("patch", toolState), null)
    })

    it("copies and indexes all native file diffs", () => {
      const context = { toolState: () => toolState, toolName: () => "patch" } as ToolRendererContext
      assert.equal(patchRenderer.getOutputChrome!(context)?.getCopyText?.(), `${patch}\n${otherPatch}`)
      const values = patchRenderer.getSearchText!({ toolCall: {} as ToolCallPart, toolState, toolName: "patch" })
      for (const value of ["src/example.ts", "src/other.ts", patch, otherPatch]) assert.ok(values.includes(value))
    })
  })
})
