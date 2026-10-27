import assert from "node:assert/strict"
import { test } from "node:test"
import { sdkManager } from "../lib/sdk-manager"
import { addInstance, removeInstance } from "./instances"
import { createSession, isCreatingSession } from "./session-api"
import { startNewSession } from "./session-actions"
import { activeParentSessionId, setProviders, setSessions } from "./session-state"
import { messageStoreBus } from "./message-v2/bus"

const until = async (predicate: () => boolean) => {
  while (!predicate()) await new Promise(resolve => setTimeout(resolve, 5))
}

function setup(instanceId: string) {
  let seq = 0
  const gates: Array<(fail: boolean) => void> = []
  const requests: string[] = []
  const sessionInfo = () => ({ id: `new-${++seq}`, projectID: "project", title: "New",
    location: { directory: "/work" }, time: { created: 1, updated: 1 }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
  const client = {
    session: {
      // A stalled network: each create request only settles when the test releases it.
      create: (input: any) => {
        requests.push(`${input.agent ?? ""}/${input.model?.id ?? ""}`)
        return new Promise((resolve, reject) => {
          gates.push(fail => (fail ? reject(new Error("network stalled")) : resolve(sessionInfo())))
        })
      },
      get: async () => sessionInfo(),
      list: async () => ({ data: [], cursor: {} }),
      active: async () => ({}),
    },
    message: { list: async () => ({ data: [], cursor: {} }) },
  } as any
  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  setProviders(previous => new Map(previous).set(instanceId, [{ id: "fixture", name: "Fixture",
    models: [{ id: "fixture", providerId: "fixture", name: "Fixture" }] }]))
  return { gates, requests }
}

function teardown(instanceId: string) {
  messageStoreBus.unregisterInstance(instanceId)
  setSessions(previous => { const next = new Map(previous); next.delete(instanceId); return next })
  removeInstance(instanceId, { authoritative: false })
  sdkManager.destroyClientsForInstance(instanceId)
}

test("session creation stays visibly pending across a stalled network and never sticks", async () => {
  const instanceId = "create-pending"
  const { gates, requests } = setup(instanceId)
  try {
    const creating = createSession(instanceId)
    // Pending covers the whole flow, including the catalog/config reads before the POST.
    assert.equal(isCreatingSession(instanceId), true)
    await until(() => requests.length > 0)
    assert.equal(isCreatingSession(instanceId), true)

    gates[0](false)
    assert.equal((await creating).id, "new-1")
    assert.equal(isCreatingSession(instanceId), false)

    // A rejected request clears the pending state and surfaces to the caller.
    const failing = createSession(instanceId)
    await until(() => requests.length > 1)
    gates[1](true)
    await assert.rejects(failing, /network stalled/)
    assert.equal(isCreatingSession(instanceId), false)
  } finally {
    teardown(instanceId)
  }
})

test("every createSession call sends its own request, whatever its intent", async () => {
  const instanceId = "create-per-call"
  const { gates, requests } = setup(instanceId)
  try {
    // Distinct model intents (sidebar vs draft composer, say) never merge…
    const first = createSession(instanceId, "build")
    const second = createSession(instanceId, "build")
    await until(() => requests.length === 2)
    assert.equal(isCreatingSession(instanceId), true)
    gates[0](false)
    gates[1](false)
    const [a, b] = await Promise.all([first, second])
    assert.notEqual(a.id, b.id, "each call creates its own session")
    assert.equal(isCreatingSession(instanceId), false)
  } finally {
    teardown(instanceId)
  }
})

test("repeated new-session entries share one creation and activate it once settled", async () => {
  const instanceId = "create-reentry"
  const { gates, requests } = setup(instanceId)
  try {
    const first = startNewSession(instanceId)
    // A second entry (hotkey while the button is already busy) is ignored:
    // it joins the pending creation instead of stacking another request.
    const second = startNewSession(instanceId)
    await until(() => requests.length > 0)
    assert.equal(isCreatingSession(instanceId), true)

    gates[0](false)
    const [a, b] = await Promise.all([first, second])
    assert.equal(requests.length, 1, "repeated UI entries share one create request")
    assert.equal(a?.id, b?.id)
    assert.equal(activeParentSessionId().get(instanceId), a?.id)
    assert.equal(isCreatingSession(instanceId), false)

    // After the entry settles, the next entry starts a fresh creation.
    const retry = startNewSession(instanceId)
    await until(() => requests.length === 2)
    gates[1](false)
    assert.equal((await retry)?.id, "new-2")
  } finally {
    teardown(instanceId)
  }
})
