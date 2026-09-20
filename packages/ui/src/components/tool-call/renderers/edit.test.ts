import assert from "node:assert/strict"
import { it } from "node:test"

import type { ToolRendererContext } from "../types"
import { extractDiffPayload } from "../utils"
import { editRenderer } from "./edit"

const patch = [
  "Index: src/example.ts",
  "===================================================================",
  "--- src/example.ts",
  "+++ src/example.ts",
  "@@ -1,1 +1,1 @@",
  "-const value = 1",
  "+const value = 2",
  "",
].join("\n")

const v2State = {
  status: "completed",
  input: { path: "src/example.ts", oldString: "const value = 1", newString: "const value = 2" },
  metadata: {
    files: [{ file: "src/example.ts", patch, additions: 1, deletions: 1, status: "modified" }],
  },
  output: "Edited src/example.ts (1 replacement)",
}

it("extracts the diff from V2 edit metadata.files", () => {
  const payload = extractDiffPayload("edit", v2State as never)
  assert.equal(payload?.diffText, patch)
  assert.equal(payload?.filePath, "src/example.ts")
})

it("still extracts the diff from V1 edit metadata.diff", () => {
  const payload = extractDiffPayload("edit", {
    status: "completed",
    input: { filePath: "src/example.ts" },
    metadata: { diff: patch },
    output: "",
  } as never)
  assert.equal(payload?.diffText, patch)
  assert.equal(payload?.filePath, "src/example.ts")
})

it("renders the V2 edit diff and titles by input.path", () => {
  let rendered: unknown
  const context = {
    toolState: () => v2State,
    toolName: () => "edit",
    renderDiff: (payload: unknown) => {
      rendered = payload
      return "diff"
    },
    renderMarkdown: ({ content }: { content: string }) => content,
  } as unknown as ToolRendererContext

  assert.match(String(editRenderer.getTitle?.(context)), /example\.ts$/)
  assert.equal(editRenderer.getOutputChrome?.(context)?.copyText, patch)
  assert.equal(editRenderer.renderBody(context), "diff")
  assert.deepEqual(rendered, { diffText: patch, filePath: "src/example.ts" })
})
