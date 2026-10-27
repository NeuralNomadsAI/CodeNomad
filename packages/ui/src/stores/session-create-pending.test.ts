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

test("session creation stays visibly pending across a stalled network, coalesces identical intents and never sticks", async () => {
  const instanceId = "create-pending"
  // A stalled network: each create request only settles when the test releases it.
  let seq = 0
  const gates: Array<(fail: boolean) => void> = []
  const requests: string[] = []
  const sessionInfo = () => ({ id: `new-${++seq}`, projectID: "project", title: "New",
    location: { directory: "/work" }, time: { created: 1, updated: 1 }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
  const client = {
    session: {
      create: (input: any) => {
        requests.push(`${input.agent ?? ""}`)
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
  try {
    const first = createSession(instanceId)
    // Pending covers the whole flow, including the catalog/config reads before the POST.
    assert.equal(isCreatingSession(instanceId), true)

    // A second identical entry while the first is still in flight (hotkey during a
    // hanging button press) reuses the same creation instead of stacking requests.
    const second = createSession(instanceId)
    await until(() => requests.length > 0)
    assert.equal(isCreatingSession(instanceId), true)

    gates[0](false)
    const [a, b] = await Promise.all([first, second])
    assert.equal(requests.length, 1, "identical new-session entries share one create request")
    assert.equal(a.id, b.id)
    assert.equal(isCreatingSession(instanceId), false)
  } finally {
    messageStoreBus.unregisterInstance(instanceId)
    setSessions(previous => { const next = new Map(previous); next.delete(instanceId); return next })
    removeInstance(instanceId, { authoritative: false })
    sdkManager.destroyClientsForInstance(instanceId)
  }
})

test("distinct creation intents stay separate requests and the pending state covers both", async () => {
  const instanceId = "create-intents"
  let seq = 0
  const gates: Array<(fail: boolean) => void> = []
  const requests: string[] = []
  const sessionInfo = () => ({ id: `new-${++seq}`, projectID: "project", title: "New",
    location: { directory: "/work" }, time: { created: 1, updated: 1 }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
  const client = {
    session: {
      create: (input: any) => {
        requests.push(`${input.agent ?? ""}`)
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
  try {
    const build = createSession(instanceId, "build")
    const plan = createSession(instanceId, "plan")
    await until(() => requests.length === 2)
    assert.deepEqual(requests, ["build", "plan"], "distinct intents send their own requests")

    // The pending state spans every in-flight creation of the instance.
    assert.equal(isCreatingSession(instanceId), true)
    gates[0](false)
    const buildSession = await build
    assert.equal(isCreatingSession(instanceId), true, "pending while the other intent is still in flight")
    gates[1](false)
    const planSession = await plan
    assert.notEqual(buildSession.id, planSession.id)
    assert.equal(isCreatingSession(instanceId), false)

    // A rejected request clears the pending state and surfaces to the caller.
    const failing = createSession(instanceId, "build")
    await until(() => requests.length === 3)
    gates[2](true)
    await assert.rejects(failing, /network stalled/)
    assert.equal(isCreatingSession(instanceId), false)
  } finally {
    messageStoreBus.unregisterInstance(instanceId)
    setSessions(previous => { const next = new Map(previous); next.delete(instanceId); return next })
    removeInstance(instanceId, { authoritative: false })
    sdkManager.destroyClientsForInstance(instanceId)
  }
})
