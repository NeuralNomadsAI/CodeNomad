import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { getIdleSinceForStatusTransition } from "../types/session.ts"
import { IDLE_STATUS_VISIBILITY_MS, shouldShowIdleStatus } from "./session-status.ts"
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

describe("idle status visibility", () => {
  it("shows idle briefly after transitioning from active work", () => {
    const idleSince = getIdleSinceForStatusTransition("working", "idle", null, 1_000)

    assert.equal(idleSince, 1_000)
    assert.equal(shouldShowIdleStatus({ status: "idle", idleSince }, 1_000), true)
    assert.equal(shouldShowIdleStatus({ status: "idle", idleSince }, 1_000 + IDLE_STATUS_VISIBILITY_MS - 1), true)
    assert.equal(shouldShowIdleStatus({ status: "idle", idleSince }, 1_000 + IDLE_STATUS_VISIBILITY_MS), false)
  })

  it("does not show idle for sessions that started idle", () => {
    const idleSince = getIdleSinceForStatusTransition(undefined, "idle", null, 1_000)

    assert.equal(idleSince, null)
    assert.equal(shouldShowIdleStatus({ status: "idle", idleSince }, 1_000), false)
  })

  it("clears idle visibility when work resumes", () => {
    const idleSince = getIdleSinceForStatusTransition("idle", "working", 1_000, 2_000)

    assert.equal(idleSince, null)
    assert.equal(shouldShowIdleStatus({ status: "working", idleSince }, 2_000), false)
  })
})
