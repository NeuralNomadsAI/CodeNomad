import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { ToolState } from "../../types/tool-state"
import { patchRenderer } from "./renderers/patch"
import { getApplyPatchFileChange, getApplyPatchFileCopyText } from "./renderers/apply-patch-data"
import type { ToolRendererContext } from "./types"
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
    } satisfies ToolState
    it("does not reduce the patch to its first file", () => {
      assert.equal(extractDiffPayload("patch", toolState), null)
    })

    const copyFiles = (files: { file: string; patch: string; status: string }[]) => {
      const state: ToolState = { ...toolState, metadata: { files } }
      const context: Pick<ToolRendererContext, "toolState" | "toolName" | "instanceId" | "sessionId"> = {
        toolState: () => state,
        toolName: () => "patch",
        instanceId: "fixture",
        sessionId: "fixture",
      }
      return patchRenderer.getOutputChrome!(context as ToolRendererContext)?.getCopyText?.()
    }

    it("copies the operation of hunk-less additions and deletions", () => {
      const added = "--- new.txt\n+++ new.txt\n"
      const deleted = "--- old.txt\n+++ old.txt\n"
      assert.equal(copyFiles([
        { file: "new.txt", patch: added, status: "added" },
        { file: "old.txt", patch: deleted, status: "deleted" },
      ]), `A new.txt\n${added}\nD old.txt\n${deleted}`)
    })

    it("copies the rename source and destination and keeps same-basename paths distinct", () => {
      assert.equal(copyFiles([
        { file: "right/shared.ts", patch, status: "modified" },
        { file: "left/shared.ts", patch: otherPatch.replaceAll("src/other.ts", "left/shared.ts"), status: "modified" },
      ]), `R src/example.ts → right/shared.ts\n${patch}\nM left/shared.ts\n${otherPatch.replaceAll("src/other.ts", "left/shared.ts")}`)
    })

    it("keeps a sibling edit modified when the native paths use different spellings", () => {
      const patch = "--- D:\\Repo\\sibling\\shared.txt\n+++ D:\\Repo\\sibling\\shared.txt\n@@ -1,1 +1,1 @@\n-before\n+after\n"
      const file = { file: "../sibling/shared.txt", patch, status: "modified" }
      assert.deepEqual(getApplyPatchFileChange(file, "d:\\repo\\pkg"), { status: "modified", path: "../sibling/shared.txt" })
      assert.equal(getApplyPatchFileCopyText(file, "d:\\repo\\pkg\\."), `M ../sibling/shared.txt\n${patch}`)
      assert.deepEqual(getApplyPatchFileChange({ ...file, status: undefined }, "D:\\repo\\pkg"), { status: undefined, path: "../sibling/shared.txt" })
    })

    it("ignores case differences in UNC paths but preserves explicit case-only renames", () => {
      const file = { file: "src/Foo.ts", patch: "--- \\\\Host\\Share\\Repo\\src\\foo.ts\n", status: "modified" }
      const directory = "//host/share/repo"
      assert.deepEqual(getApplyPatchFileChange(file, directory), { status: "modified", path: "src/Foo.ts" })
      assert.deepEqual(getApplyPatchFileChange({ ...file, status: "renamed" }, directory), { status: "renamed", path: "src/foo.ts → src/Foo.ts" })
    })
  })
})
