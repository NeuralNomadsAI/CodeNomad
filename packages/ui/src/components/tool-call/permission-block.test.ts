import assert from "node:assert/strict"
import test from "node:test"
import { getPermissionDiffPayload, isPermissionApprovalBlocked } from "./permission-block.tsx"

test("requires full access before approving a truncated permission diff", () => {
  const payload = { diffText: "x".repeat(10_001) }
  assert.equal(isPermissionApprovalBlocked(payload, false), true)
  assert.equal(isPermissionApprovalBlocked(payload, true), false)
  assert.equal(isPermissionApprovalBlocked({ diffText: "small" }, false), false)
  assert.deepEqual(getPermissionDiffPayload({ metadata: { diff: payload.diffText, path: "/file" } } as any), { diffText: payload.diffText, filePath: "/file" })
})
