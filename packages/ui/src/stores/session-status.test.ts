import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { getIdleSinceForStatusTransition } from "../types/session.ts"
import { clearSessionIdleFade, getSessionIdleFadeClass, IDLE_STATUS_VISIBILITY_MS, markSessionIdleFadeStarted, shouldShowIdleStatus } from "./session-status.ts"
import { setSessions } from "./session-state.ts"
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
    assert.equal(shouldShowIdleStatus({ status: "idle", idleSince, parentId: null }), true)
    assert.equal(shouldShowIdleStatus({ status: "idle", idleSince, parentId: null }), true)
  })

  it("keeps subagent idle visible until the parent or child session is seen", () => {
    const idleSince = getIdleSinceForStatusTransition("working", "idle", null, 1_000)

    assert.equal(shouldShowIdleStatus({ status: "idle", idleSince, parentId: "parent" }, 2_000, true), true)
    assert.equal(shouldShowIdleStatus({ status: "idle", idleSince, parentId: "parent" }, 10_000, true), true)
  })

  it("ages out subagent idle markers unless keep-unseen is enabled", () => {
    const idleSince = getIdleSinceForStatusTransition("working", "idle", null, 1_000)

    assert.equal(shouldShowIdleStatus({ status: "idle", idleSince, parentId: "parent" }, 2_000, false), true)
    assert.equal(shouldShowIdleStatus({ status: "idle", idleSince, parentId: "parent" }, 7_000, false), false)
  })

  it("does not show idle for sessions that started idle", () => {
    const idleSince = getIdleSinceForStatusTransition(undefined, "idle", null, 1_000)

    assert.equal(idleSince, null)
    assert.equal(shouldShowIdleStatus({ status: "idle", idleSince, parentId: null }), false)
  })

  it("clears idle visibility when work resumes", () => {
    const idleSince = getIdleSinceForStatusTransition("idle", "working", 1_000, 2_000)

    assert.equal(idleSince, null)
    assert.equal(shouldShowIdleStatus({ status: "working", idleSince, parentId: null }), false)
  })

  it("clears idle fade state for a specific idle transition", () => {
    const instanceId = "instance"
    const sessionId = "session"
    const idleSince = 1_000

    setSessions(
      new Map([
        [
          instanceId,
          new Map([
            [
              sessionId,
              {
                id: sessionId,
                status: "idle",
                idleSince,
                parentId: null,
              } as any,
            ],
          ]),
        ],
      ]),
    )

    markSessionIdleFadeStarted(instanceId, sessionId)
    assert.equal(getSessionIdleFadeClass(instanceId, sessionId), "session-status-fading")

    clearSessionIdleFade(instanceId, sessionId, idleSince)
    assert.equal(getSessionIdleFadeClass(instanceId, sessionId), "")

    setSessions(new Map())
  })
})
