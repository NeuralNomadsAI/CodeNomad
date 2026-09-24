import assert from "node:assert/strict"
import { it } from "node:test"

import type { ToolRendererContext } from "../types"
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

function createContext(path: string) {
  let rendered: unknown
  const context = {
    toolState: () => ({
      status: "completed",
      input: { path, oldString: "const value = 1", newString: "const value = 2" },
      metadata: { files: [{ file: path, patch, additions: 1, deletions: 1, status: "modified" }] },
      output: `Edited ${path} (1 replacement)`,
    }),
    toolName: () => "edit",
    renderDiff: (payload: unknown) => {
      rendered = payload
      return "diff"
    },
    renderMarkdown: ({ content }: { content: string }) => content,
  } as unknown as ToolRendererContext
  return { context, rendered: () => rendered }
}

it("renders the OpenCode 2.x edit diff and titles by input.path", () => {
  const { context, rendered } = createContext("src/example.ts")

  assert.equal(editRenderer.getTitle?.(context), "Edit example.ts")
  assert.equal(editRenderer.getOutputChrome?.(context)?.copyText, patch)
  assert.equal(editRenderer.renderBody(context), "diff")
  assert.deepEqual(rendered(), { diffText: patch, filePath: "src/example.ts" })
})

it("titles by the file name for an absolute Windows path", () => {
  const { context } = createContext("C:\\repo\\src\\example.ts")
  assert.equal(editRenderer.getTitle?.(context), "Edit example.ts")
})
