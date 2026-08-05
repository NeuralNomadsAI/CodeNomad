import assert from "node:assert/strict"
import test from "node:test"

import { isPermissionDiffTooLarge } from "./permission-constants.ts"
import { TOOL_OUTPUT_RENDER_CHARACTER_LIMIT } from "./utils.ts"

test("permission approval requires full access only beyond the render limit", () => {
  assert.equal(isPermissionDiffTooLarge("x".repeat(TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)), false)
  assert.equal(isPermissionDiffTooLarge("x".repeat(TOOL_OUTPUT_RENDER_CHARACTER_LIMIT + 1)), true)
})
