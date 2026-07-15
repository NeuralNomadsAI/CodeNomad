import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"

import type { Session } from "../types/session.ts"
import {
  beginSessionGenerationAdmission,
  getSessions,
  setSessions,
  setSessionStatus,
} from "./session-state.ts"

const instanceId = "generation-admission-instance"
const sessionId = "generation-admission-session"

function seedSession(state: Partial<Session> = {}): void {
  const session = {
    id: sessionId,
    instanceId,
    parentId: null,
    title: "Session",
    agent: "build",
    model: { providerId: "provider", modelId: "model" },
    version: "1",
    time: { created: 1, updated: 1 },
    status: "idle",
    idleSince: 10,
    runtimeStatusKnown: true,
    generationRecovery: "interrupted",
    ...state,
  } as Session
  setSessions(new Map([[instanceId, new Map([[sessionId, session]])]]))
}

afterEach(() => setSessions(new Map()))

describe("session generation admission", () => {
  it("does not overwrite a newer authoritative SSE status when admission completes", () => {
    seedSession()
    const admission = beginSessionGenerationAdmission(instanceId, sessionId)

    setSessionStatus(instanceId, sessionId, "working")
    admission.complete()

    const session = getSessions(instanceId)[0]
    assert.equal(session.status, "working")
    assert.equal(session.runtimeStatusKnown, true)
    assert.equal(session.generationRecovery, null)
    assert.equal(session.generationAdmissionToken, undefined)
  })

  it("ignores idle authority until an in-flight admission is acknowledged", () => {
    seedSession()
    const admission = beginSessionGenerationAdmission(instanceId, sessionId)

    setSessionStatus(instanceId, sessionId, "idle")
    const pending = getSessions(instanceId)[0]
    assert.equal(pending.runtimeStatusKnown, false)
    assert.equal(pending.generationRecovery, "pending")
    assert.equal(typeof pending.generationAdmissionToken, "number")

    admission.complete()
    assert.equal(getSessions(instanceId)[0].generationAdmissionToken, undefined)
    assert.equal(getSessions(instanceId)[0].generationRecovery, "pending")
  })

  it("rolls back only when no authoritative event superseded the failed admission", () => {
    seedSession()
    const admission = beginSessionGenerationAdmission(instanceId, sessionId)
    admission.rollback()

    const session = getSessions(instanceId)[0]
    assert.equal(session.runtimeStatusKnown, true)
    assert.equal(session.generationRecovery, "interrupted")
    assert.equal(session.idleSince, 10)
  })

  it("retains pending recovery when one of two overlapping admissions succeeds", () => {
    seedSession()
    const first = beginSessionGenerationAdmission(instanceId, sessionId)
    const second = beginSessionGenerationAdmission(instanceId, sessionId)

    first.complete()
    second.rollback()

    const session = getSessions(instanceId)[0]
    assert.equal(session.runtimeStatusKnown, false)
    assert.equal(session.generationRecovery, "pending")
    assert.equal(session.generationAdmissionToken, undefined)
  })
})
