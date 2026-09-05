import assert from "node:assert/strict"
import test from "node:test"

import { bashRenderer } from "./renderers/bash.tsx"

test("resolves complete tool output only through lazy copy", () => {
  const full = `${"x".repeat(10_000)}COPY_TAIL`
  const chrome = bashRenderer.getOutputChrome?.({
    toolName: () => "bash",
    t: (key: string) => key,
    toolState: () => ({ status: "completed", input: { command: "echo" }, metadata: {}, output: full }),
  } as any)

  assert.equal(chrome?.copyText, undefined)
  assert.equal(chrome?.getCopyText?.()?.endsWith(full), true)
})
