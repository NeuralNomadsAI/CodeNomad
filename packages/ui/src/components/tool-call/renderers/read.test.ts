import assert from "node:assert/strict"
import { it } from "node:test"

import type { ToolRendererContext } from "../types"
import { readRenderer } from "./read"

it("renders read output from the V2 tool state", () => {
  const context = {
    toolState: () => ({
      status: "completed",
      input: { path: "src/example.ts" },
      metadata: { preview: "stale preview" },
      output: "const value = 1",
    }),
    renderMarkdown: ({ content }: { content: string }) => content,
  } as unknown as ToolRendererContext

  assert.equal(readRenderer.getOutputChrome?.(context)?.copyText, "const value = 1")
  assert.match(String(readRenderer.renderBody(context)), /const value = 1/)
})
