import assert from "node:assert/strict"
import { test } from "node:test"
import { sdkManager } from "../lib/sdk-manager"
import { addInstance, removeInstance } from "./instances"
import { createSession, isCreatingSession } from "./session-api"
import { setProviders, setSessions } from "./session-state"
import { messageStoreBus } from "./message-v2/bus"

const until = async (predicate: () => boolean) => {
  while (!predicate()) await new Promise(resolve => setTimeout(resolve, 5))
}

test("session creation stays visibly pending across a stalled network, coalesces concurrent entries and never sticks", async () => {
  const instanceId = "create-pending"
  // A stalled network: the create request only settles when the test releases it.
  let release: ((fail: boolean) => void) | undefined
  const requests: Array<{ input: any; options: any }> = []
  const created = { id: "new-1", projectID: "project", title: "New", location: { directory: "/work" },
    time: { created: 1, updated: 1 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
  const client = {
    session: {
      create: (input: any, options: any) => {
        requests.push({ input, options })
        return new Promise((resolve, reject) => {
          release = fail => (fail ? reject(new Error("network stalled")) : resolve(created))
        })
      },
      get: async () => created,
      list: async () => ({ data: [], cursor: {} }),
      active: async () => ({}),
    },
    message: { list: async () => ({ data: [], cursor: {} }) },
  } as any
  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  setProviders(previous => new Map(previous).set(instanceId, [{ id: "fixture", name: "Fixture",
    models: [{ id: "fixture", providerId: "fixture", name: "Fixture" }] }]))
  try {
    const first = createSession(instanceId)
    // Pending covers the whole flow, including the catalog/config reads before the POST.
    assert.equal(isCreatingSession(instanceId), true)

    // A second entry while the first is still in flight (hotkey during a hanging
    // button press) reuses the same creation instead of stacking requests.
    const second = createSession(instanceId)
    await until(() => requests.length > 0)
    assert.equal(isCreatingSession(instanceId), true)

    release!(false)
    const [a, b] = await Promise.all([first, second])
    assert.equal(requests.length, 1, "concurrent new-session entries share one create request")
    assert.equal(a.id, b.id)
    assert.equal(isCreatingSession(instanceId), false)

    // The create request is time-bounded so a dead connection cannot hang the flag forever.
    assert.ok(requests[0]?.options?.signal instanceof AbortSignal, "session.create must carry an abort signal")

    // Failure clears the pending state and surfaces to the caller.
    const failing = createSession(instanceId)
    await until(() => requests.length > 1)
    release!(true)
    await assert.rejects(failing, /network stalled/)
    assert.equal(isCreatingSession(instanceId), false)
  } finally {
    messageStoreBus.unregisterInstance(instanceId)
    setSessions(previous => { const next = new Map(previous); next.delete(instanceId); return next })
    removeInstance(instanceId, { authoritative: false })
    sdkManager.destroyClientsForInstance(instanceId)
  }
})
