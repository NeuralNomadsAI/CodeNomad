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

it("renders the OpenCode 2.x edit diff and titles by input.path", () => {
  let rendered: unknown
  const context = {
    toolState: () => ({
      status: "completed",
      input: { path: "src/example.ts", oldString: "const value = 1", newString: "const value = 2" },
      metadata: { files: [{ file: "src/example.ts", patch, additions: 1, deletions: 1, status: "modified" }] },
      output: "Edited src/example.ts (1 replacement)",
    }),
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
