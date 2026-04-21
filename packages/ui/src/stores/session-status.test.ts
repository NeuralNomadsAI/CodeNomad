import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { shouldSessionHoldWakeLock } from "./wake-lock-eligibility.ts"

describe("shouldSessionHoldWakeLock", () => {
  it("holds wake lock only for qualifying active work", () => {
    assert.equal(shouldSessionHoldWakeLock({ status: "working", pendingPermission: false, pendingQuestion: false }), true)
    assert.equal(
      shouldSessionHoldWakeLock({ status: "compacting", pendingPermission: false, pendingQuestion: false }),
      true,
    )
    assert.equal(shouldSessionHoldWakeLock({ status: "idle", pendingPermission: false, pendingQuestion: false }), false)
  })

  it("does not hold wake lock while waiting for permission or input", () => {
    assert.equal(shouldSessionHoldWakeLock({ status: "working", pendingPermission: true, pendingQuestion: false }), false)
    assert.equal(shouldSessionHoldWakeLock({ status: "working", pendingPermission: false, pendingQuestion: true }), false)
  })
})
