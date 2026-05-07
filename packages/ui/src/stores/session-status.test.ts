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
  it("keeps seen idle visible for the configured transient delay", () => {
    assert.equal(IDLE_STATUS_VISIBILITY_MS, 5_000)
  })

  it("shows idle after transitioning from active work until it is seen", () => {
    const idleSince = getIdleSinceForStatusTransition("working", "idle", null, 1_000)

    assert.equal(idleSince, 1_000)
    assert.equal(shouldShowIdleStatus({ status: "idle", idleSince, parentId: null }, 1_000), true)
    assert.equal(shouldShowIdleStatus({ status: "idle", idleSince, parentId: null }, 1_000 + IDLE_STATUS_VISIBILITY_MS), true)
  })

  it("auto-hides subagent idle after the transient delay by default", () => {
    const idleSince = getIdleSinceForStatusTransition("working", "idle", null, 1_000)

    assert.equal(shouldShowIdleStatus({ status: "idle", idleSince, parentId: "parent" }, 1_000), true)
    assert.equal(
      shouldShowIdleStatus({ status: "idle", idleSince, parentId: "parent" }, 1_000 + IDLE_STATUS_VISIBILITY_MS),
      false,
    )
  })

  it("can keep subagent idle visible until viewed", () => {
    const idleSince = getIdleSinceForStatusTransition("working", "idle", null, 1_000)

    assert.equal(
      shouldShowIdleStatus({ status: "idle", idleSince, parentId: "parent" }, 1_000 + IDLE_STATUS_VISIBILITY_MS, true),
      true,
    )
  })

  it("does not show idle for sessions that started idle", () => {
    const idleSince = getIdleSinceForStatusTransition(undefined, "idle", null, 1_000)

    assert.equal(idleSince, null)
    assert.equal(shouldShowIdleStatus({ status: "idle", idleSince, parentId: null }, 1_000), false)
  })

  it("clears idle visibility when work resumes", () => {
    const idleSince = getIdleSinceForStatusTransition("idle", "working", 1_000, 2_000)

    assert.equal(idleSince, null)
    assert.equal(shouldShowIdleStatus({ status: "working", idleSince, parentId: null }, 2_000), false)
  })
})
