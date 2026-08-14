import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { addFormToQueue, clearFormQueue, getFormQueue, removeFormFromQueue, replaceFormQueue } from "./forms.ts"
import { activeInterruption, addPendingForm, removePendingForm } from "./instances.ts"
import { sessions, setSessions } from "./session-state.ts"

const form = {
  id: "form-1",
  sessionID: "session-1",
  title: "Release details",
  fields: [{ key: "channel", type: "string", required: true }],
} as any

describe("V2 form queue", () => {
  it("restores pending requests and reconciles created, replied, and cancelled forms", () => {
    const instanceId = "forms"
    try {
      replaceFormQueue(instanceId, [form])
      assert.deepEqual(getFormQueue(instanceId), [form])

      const second = { ...form, id: "form-2" }
      addFormToQueue(instanceId, second)
      assert.deepEqual(getFormQueue(instanceId).map((item) => item.id), ["form-1", "form-2"])

      removeFormFromQueue(instanceId, form.id)
      assert.deepEqual(getFormQueue(instanceId).map((item) => item.id), ["form-2"])
      removeFormFromQueue(instanceId, second.id)
      assert.equal(getFormQueue(instanceId).length, 0)
    } finally {
      clearFormQueue(instanceId)
    }
  })
})

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
