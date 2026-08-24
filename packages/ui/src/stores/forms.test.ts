import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  activeInterruption,
  addInstance,
  addPendingForm,
  removeInstance,
  removePendingForm,
  sendFormCancel,
  sendFormReply,
  syncPendingRequests,
} from "./instances.ts"
import { formRequestOptions, getFormQueue } from "./forms.ts"
import { getRootClient } from "./opencode-client.ts"
import { sdkManager } from "../lib/sdk-manager.ts"
import { sessions, setSessions } from "./session-state.ts"
import { hasSettledForm, markFormSettled } from "./form-settlements.ts"

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

  it("keeps global form locations for response routing while session forms stay unchanged", () => {
    const instanceId = "global-form-location"
    const globalForm = {
      ...form,
      id: "global-form",
      sessionID: "global",
      location: { directory: "/worktree", workspaceID: "workspace-1" },
    }

    try {
      addPendingForm(instanceId, globalForm)
      assert.deepEqual(getFormQueue(instanceId)[0]?.location, globalForm.location)
      assert.deepEqual(formRequestOptions(globalForm), {
        headers: {
          "x-opencode-directory": "%2Fworktree",
          "x-opencode-workspace": "workspace-1",
        },
      })
      assert.equal(formRequestOptions(form), undefined)
    } finally {
      removePendingForm(instanceId, globalForm.id)
    }
  })

  it("percent-encodes Unicode and percent signs in global form directories", () => {
    assert.deepEqual(formRequestOptions({
      ...form,
      sessionID: "global",
      location: { directory: "/工作/100% ready" },
    }), {
      headers: {
        "x-opencode-directory": "%2F%E5%B7%A5%E4%BD%9C%2F100%25%20ready",
      },
    })
  })

  it("sends global replies and cancellations with their location request options", async () => {
    const instanceId = "global-form-response-location"
    const globalForm = {
      ...form,
      id: "global-response-form",
      sessionID: "global",
      location: { directory: "/worktree", workspaceID: "workspace-1" },
    }
    const calls: unknown[][] = []
    const client = getRootClient(instanceId)
    ;(client.form as any).reply = async (...args: unknown[]) => { calls.push(args) }
    ;(client.form as any).cancel = async (...args: unknown[]) => { calls.push(args) }

    try {
      addPendingForm(instanceId, globalForm)
      await sendFormReply(instanceId, globalForm.id, { channel: "stable" })
      addPendingForm(instanceId, globalForm)
      await sendFormCancel(instanceId, globalForm.id)

      assert.deepEqual(calls, [
        [
          { sessionID: "global", formID: globalForm.id, answer: { channel: "stable" } },
          formRequestOptions(globalForm),
        ],
        [
          { sessionID: "global", formID: globalForm.id },
          formRequestOptions(globalForm),
        ],
      ])
    } finally {
      removePendingForm(instanceId, globalForm.id)
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })

  it("attaches list response locations only to global forms", async () => {
    const instanceId = "global-form-list-location"
    const location = { directory: "/worktree", workspaceID: "workspace-1" }
    const client = {
      permission: { request: { list: async () => ({ location, data: [] }) } },
      form: { request: { list: async () => ({
        location,
        data: [
          { ...form, id: "global-list-form", sessionID: "global" },
          { ...form, id: "session-list-form" },
        ],
      }) } },
    }
    addInstance({ id: instanceId, folder: "/worktree", status: "ready", client } as any)

    try {
      await syncPendingRequests(instanceId)
      assert.deepEqual(getFormQueue(instanceId).map((entry) => [entry.id, entry.location]), [
        ["global-list-form", location],
        ["session-list-form", undefined],
      ])
    } finally {
      removeInstance(instanceId)
    }
  })

  it("removes a stale form after its session disappears", async () => {
    const instanceId = "deleted-form-session"
    const location = { directory: "/worktree" }
    const client = {
      permission: { request: { list: async () => ({ location, data: [] }) } },
      form: { request: { list: async () => ({ location, data: [] }) } },
    }
    addInstance({ id: instanceId, folder: "/worktree", status: "ready", client } as any)

    try {
      addPendingForm(instanceId, form, location.directory)
      await syncPendingRequests(instanceId)
      assert.deepEqual(getFormQueue(instanceId), [])
    } finally {
      removeInstance(instanceId)
    }
  })

  it("preserves form settlement tombstones when one location scan fails", async () => {
    const instanceId = "partial-form-scan"
    const worktreeLocation = { directory: "/worktree" }
    const client = {
      permission: { request: { list: async ({ location }: { location: unknown }) => ({ location, data: [] }) } },
      form: { request: { list: async ({ location }: { location: { directory?: string } }) => {
        if (location.directory === "/workspace") throw new Error("root unavailable")
        return { location: worktreeLocation, data: [] }
      } } },
    }
    addInstance({ id: instanceId, folder: "/workspace", status: "ready", client } as any)
    setSessions((previous) => new Map(previous).set(instanceId, new Map([["session", {
      id: "session", location: worktreeLocation,
    } as any]])))
    markFormSettled(instanceId, "answered")

    try {
      await assert.rejects(syncPendingRequests(instanceId))
      assert.equal(hasSettledForm(instanceId, "answered"), true)
    } finally {
      setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
      removeInstance(instanceId)
    }
  })
})
