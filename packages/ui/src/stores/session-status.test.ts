import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { getIdleSinceForStatusTransition } from "../types/session.ts"
import { clearSessionIdleFade, idleFadeClassForSession, IDLE_STATUS_VISIBILITY_MS, markSessionIdleFadeStarted, shouldShowIdleStatus, shouldShowSessionStatusForRow } from "./session-status.ts"
import { sessions, setSessions } from "./session-state.ts"
import { shouldAppHoldWakeLock, shouldSessionHoldWakeLock } from "./wake-lock-eligibility.ts"

describe("shouldAppHoldWakeLock", () => {
  it("keeps local application windows awake for the preference or eligible session work", () => {
    assert.equal(shouldAppHoldWakeLock(false, false, "local"), false)
    assert.equal(shouldAppHoldWakeLock(false, true, "local"), true)
    assert.equal(shouldAppHoldWakeLock(true, false, "local"), true)
    assert.equal(shouldAppHoldWakeLock(true, true, "local"), true)
  })

  for (const context of ["remote", "preferences"] as const) {
    it(`ignores the preference in ${context} windows and preserves session-based holds`, () => {
      assert.equal(shouldAppHoldWakeLock(false, false, context), false)
      assert.equal(shouldAppHoldWakeLock(false, true, context), true)
      assert.equal(shouldAppHoldWakeLock(true, false, context), false)
      assert.equal(shouldAppHoldWakeLock(true, true, context), true)
    })
  }
})

describe("shouldSessionHoldWakeLock", () => {
  it("holds wake lock only for qualifying active work", () => {
    assert.equal(shouldSessionHoldWakeLock({ status: "working", pendingPermission: false, pendingForm: false }), true)
    assert.equal(
      shouldSessionHoldWakeLock({ status: "compacting", pendingPermission: false, pendingForm: false }),
      true,
    )
    assert.equal(shouldSessionHoldWakeLock({ status: "idle", pendingPermission: false, pendingForm: false }), false)
  })

  it("does not hold wake lock while waiting for permission or input", () => {
    assert.equal(shouldSessionHoldWakeLock({ status: "working", pendingPermission: true, pendingForm: false }), false)
    assert.equal(shouldSessionHoldWakeLock({ status: "working", pendingPermission: false, pendingForm: true }), false)
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
    const fadeClass = () => idleFadeClassForSession(instanceId, sessions().get(instanceId)?.get(sessionId) ?? null)

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
    assert.equal(fadeClass(), "session-status-fading")

    setSessions(
      new Map([
        [instanceId, new Map([[sessionId, { id: sessionId, status: "idle", idleSince: null, parentId: null } as any]])],
      ]),
    )
    assert.equal(fadeClass(), "session-status-fading")

    setSessions(
      new Map([
        [instanceId, new Map([[sessionId, { id: sessionId, status: "idle", idleSince: 2_000, parentId: null } as any]])],
      ]),
    )
    assert.equal(fadeClass(), "")

    clearSessionIdleFade(instanceId, sessionId, idleSince)
    assert.equal(fadeClass(), "")

    setSessions(new Map())
  })

  it("keeps a default-mode subagent visible while its parent-triggered fade runs", () => {
    const instanceId = "instance"
    const sessionId = "subsession"
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
                parentId: "parent",
              } as any,
            ],
          ]),
        ],
      ]),
    )

    const row = sessions().get(instanceId)!.get(sessionId)!
    assert.equal(shouldShowSessionStatusForRow(instanceId, row, 7_000, false), false)

    markSessionIdleFadeStarted(instanceId, sessionId)
    assert.equal(shouldShowSessionStatusForRow(instanceId, row, 7_000, false), true)

    clearSessionIdleFade(instanceId, sessionId, idleSince)
    setSessions(new Map())
  })
})
