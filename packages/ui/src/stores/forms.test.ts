import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { activeInterruption, addPendingForm, removePendingForm } from "./instances.ts"
import { sessions, setSessions } from "./session-state.ts"

const form = {
  id: "form-1",
  sessionID: "session-1",
  title: "Release details",
  fields: [{ key: "channel", type: "string", required: true }],
} as any

describe("form interruption lifecycle", () => {
  it("marks created or restored forms as pending until reply or cancellation", () => {
    const instanceId = "form-lifecycle"
    const sessionId = "session-1"
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[
      sessionId,
      { id: sessionId, status: "working", pendingForm: false } as any,
    ]])))

    try {
      addPendingForm(instanceId, form)
      assert.equal(sessions().get(instanceId)?.get(sessionId)?.pendingForm, true)
      assert.deepEqual(activeInterruption().get(instanceId), { kind: "form", id: form.id })

      removePendingForm(instanceId, form.id)
      assert.equal(sessions().get(instanceId)?.get(sessionId)?.pendingForm, false)
      assert.equal(activeInterruption().get(instanceId), null)
    } finally {
      removePendingForm(instanceId, form.id)
      setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
    }
  })
})
