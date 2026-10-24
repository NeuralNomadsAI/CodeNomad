import assert from "node:assert/strict"
import { test } from "node:test"
import { sdkManager } from "../lib/sdk-manager"
import { serverApi } from "../lib/api-client"
import { addInstance, removeInstance } from "./instances"
import { createSession, fetchAgents } from "./session-api"
import { agents, sessions, setProviders, setSessions } from "./session-state"
import { messageStoreBus } from "./message-v2/bus"

test("new sessions use the native default agent and its model, while explicit choices still win (#1005)", async () => {
  const instanceId = "native-default-agent"
  const nativeAgent = (id: string, mode = "primary", hidden = false) => ({
    id, name: id, mode, hidden, model: { providerID: "fixture", id: `${id}-model` },
  })
  // The host puts its resolved default first, not in alphabetical order.
  let listed = [nativeAgent("orchestrator"), nativeAgent("build"), nativeAgent("plan"),
    nativeAgent("aaa-child", "subagent"), nativeAgent("aaa-hidden", "primary", true)]
  const created: any[] = []
  const client = {
    agent: {
      list: async () => ({ data: listed }),
      get: async () => { throw new Error("All built-ins were already listed") },
    },
    session: {
      create: async (input: any) => {
        created.push(input)
        return { ...input, id: `new-${created.length}`, projectID: "project", title: "New",
          time: { created: 1, updated: 1 }, cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
      },
      active: async () => ({}),
    },
  } as any
  const originalRead = serverApi.fetchConfigOwner
  const originalWrite = serverApi.patchConfigOwner
  serverApi.fetchConfigOwner = async () => ({} as any)
  serverApi.patchConfigOwner = async (_owner, value) => value as any
  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  setProviders(previous => new Map(previous).set(instanceId, [{ id: "fixture", name: "Fixture",
    models: listed.map(agent => ({ id: agent.model.id, providerId: "fixture", name: agent.model.id })) }]))
  try {
    assert.equal(await fetchAgents(instanceId), true)
    assert.deepEqual(agents().get(instanceId)?.map(agent => agent.id), listed.map(agent => agent.id))
    for (const [explicit, expected] of [[undefined, "orchestrator"], ["build", "build"]] as const) {
      const result = await createSession(instanceId, explicit)
      assert.equal(result.agent, expected)
      assert.deepEqual(result.model, { providerId: "fixture", modelId: `${expected}-model` })
      assert.deepEqual(created.at(-1), { agent: expected, model: { providerID: "fixture", id: `${expected}-model` },
        location: { directory: "/work" } })
      // Isolate subsequent creations from the unrelated automatic blank cleanup.
      setSessions(previous => new Map(previous).set(instanceId, new Map()))
    }
    listed = [listed[2], listed[0], listed[1], ...listed.slice(3)]
    await fetchAgents(instanceId, { directory: "/work" }, true)
    const refreshed = await createSession(instanceId)
    assert.equal(refreshed.agent, "plan", "a refreshed host default replaces the old default")
    assert.equal(refreshed.model.modelId, "plan-model")
  } finally {
    serverApi.fetchConfigOwner = originalRead
    serverApi.patchConfigOwner = originalWrite
    messageStoreBus.unregisterInstance(instanceId)
    setSessions(previous => { const next = new Map(previous); next.delete(instanceId); return next })
    removeInstance(instanceId, { authoritative: false })
    sdkManager.destroyClientsForInstance(instanceId)
  }
})
