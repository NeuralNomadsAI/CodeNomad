import assert from "node:assert/strict"
import { test } from "node:test"
import { serverApi } from "../lib/api-client"
import { storage } from "../lib/storage"
import { serverEvents } from "../lib/server-events"
import { ensureInstanceConfigLoaded, getInstanceConfig, clearInstanceConfig } from "./instance-config"
import { sdkManager } from "../lib/sdk-manager"
import { addInstance, removeInstance, updateInstance } from "./instances"
import { setProviders, setSessions } from "./session-state"
import { updateSessionModel } from "./session-actions"

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
for (const rotation of [false, true]) test(`shared preference snapshots retain the newer server write (rotation=${rotation})`, async () => {
  const id = `preference-ack-${rotation}`
  const original = { readInstanceData: serverApi.readInstanceData, writeInstanceData: serverApi.writeInstanceData, patchStateOwner: serverApi.patchStateOwner }
  const gate = deferred(), entered = deferred()
  let persisted: any = { messageHistory: [], agentModelSelections: {} }
  let writes = 0
  serverApi.readInstanceData = async () => structuredClone(persisted)
  serverApi.writeInstanceData = async (_id, data) => {
    writes++
    persisted = structuredClone(data)
    if (data.agentModelSelections.build?.modelId === "old") { entered.resolve(); await gate.promise }
  }
  serverApi.patchStateOwner = async (_owner, data) => data as any
  const client: any = { session: { switchModel: async () => {} } }
  ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
  addInstance({ id, folder: "/same/", client, status: "ready", proxyPath: "", port: 0, pid: 0,
    binding: { serverId: "A", directory: "/same/" }, capabilities: { generation: 1 } as any })
  const row = (sessionId: string) => ({ id: sessionId, instanceId: id, title: sessionId, agent: "build", model: { providerId: "p", modelId: "initial" }, parentId: null, status: "idle", location: { directory: "/same/" }, time: { created: 1, updated: 1 } })
  setSessions(new Map([[id, new Map([["one", row("one")], ["two", row("two")]])]]) as any)
  setProviders(new Map([[id, [{ id: "p", name: "p", models: ["initial", "old", "new"].map(id => ({ id, name: id, providerId: "p" })) }]]]))
  try {
    await ensureInstanceConfigLoaded(id)
    const old = updateSessionModel(id, "one", { providerId: "p", modelId: "old" })
    const finished = rotation ? assert.rejects(old, /superseded/i) : old
    await entered.promise
    if (rotation) updateInstance(id, { capabilities: { generation: 2 } as any })
    await updateSessionModel(id, "two", { providerId: "p", modelId: "new" })
    assert.equal(getInstanceConfig(id).agentModelSelections.build.modelId, "new")
    gate.resolve(); await finished
    assert.equal(persisted.agentModelSelections.build.modelId, "new", "the server has already committed the newer write")
    assert.equal(getInstanceConfig(id).agentModelSelections.build.modelId, "new", "the subscription must not publish the old ACK")
    assert.equal((await storage.loadInstanceData(id)).agentModelSelections.build.modelId, "new", "a new subscriber must receive the accepted cache")
    ;(serverEvents as any).dispatch({ type: "instance.dataChanged", instanceId: id,
      data: { ...persisted, agentModelSelections: { build: { providerId: "p", modelId: "incoming-authority" } } } })
    assert.equal(getInstanceConfig(id).agentModelSelections.build.modelId, "incoming-authority", "a valid independent snapshot must remain publishable")
    assert.equal(writes, 2, "no write is replayed")
  } finally {
    gate.resolve(); Object.assign(serverApi, original)
    clearInstanceConfig(id); removeInstance(id, { authoritative: false }); sdkManager.destroyClientsForInstance(id)
    setSessions(new Map()); setProviders(new Map())
  }
})

test("retiring an old instance-config load cannot publish or remove its replacement owner", async () => {
  const id = "retired-config-load"
  const original = serverApi.readInstanceData
  const old = deferred<any>(), fresh = deferred<any>()
  let reads = 0
  serverApi.readInstanceData = () => ++reads === 1 ? old.promise : fresh.promise
  const first = ensureInstanceConfigLoaded(id)
  try {
    clearInstanceConfig(id)
    const second = ensureInstanceConfigLoaded(id)
    old.resolve({ messageHistory: ["old"], agentModelSelections: {} })
    await first
    assert.deepEqual(getInstanceConfig(id).messageHistory, [])
    const third = ensureInstanceConfigLoaded(id)
    fresh.resolve({ messageHistory: ["fresh"], agentModelSelections: {} })
    await Promise.all([second, third])
    assert.equal(reads, 2)
    assert.deepEqual(getInstanceConfig(id).messageHistory, ["fresh"])
  } finally { old.resolve({}); fresh.resolve({}); serverApi.readInstanceData = original; clearInstanceConfig(id) }
})

for (const failed of [false, true]) test(`a surviving shared reader obtains its own snapshot or rejects before a default (failed=${failed})`, async () => {
  const id = `joined-config-reader-${failed}`, original = serverApi.readInstanceData
  const old = deferred<any>()
  let ownerCurrent = true, reads = 0
  serverApi.readInstanceData = async () => {
    if (++reads === 1) return old.promise
    if (failed && reads === 2) throw new Error("Qualified read unavailable")
    return { messageHistory: ["retained"], agentModelSelections: { build: { providerId: "p", modelId: "preferred" } } }
  }
  try {
    const owner = ensureInstanceConfigLoaded(id, () => ownerCurrent)
    const reader = ensureInstanceConfigLoaded(id)
    const settled = failed ? assert.rejects(reader, /Qualified read unavailable/) : reader
    ownerCurrent = false
    old.resolve({ messageHistory: ["retired"], agentModelSelections: {} })
    await Promise.all([owner, settled])
    assert.equal(reads, 2, "only a bounded replacement read, never a mutation replay")
    if (failed) {
      assert.deepEqual(getInstanceConfig(id).messageHistory, [])
      await ensureInstanceConfigLoaded(id)
      assert.equal(reads, 3, "a failure must not install an empty successful snapshot")
      assert.equal(getInstanceConfig(id).agentModelSelections.build.modelId, "preferred")
    } else {
      assert.equal(getInstanceConfig(id).agentModelSelections.build.modelId, "preferred")
      assert.deepEqual(getInstanceConfig(id).messageHistory, ["retained"])
    }
  } finally { old.resolve({}); serverApi.readInstanceData = original; clearInstanceConfig(id) }
})

test("a shared reader bounds replacement joins and leaves the current load owned", async () => {
  const id = "bounded-config-joins", original = serverApi.readInstanceData
  const gates: Array<ReturnType<typeof deferred<any>>> = []
  serverApi.readInstanceData = () => { const gate = deferred<any>(); gates.push(gate); return gate.promise }
  const owners = [ensureInstanceConfigLoaded(id)]
  const reader = ensureInstanceConfigLoaded(id)
  const rejected = assert.rejects(reader, (error: any) => error.code === "session_action_superseded")
  try {
    for (let index = 0; index < 3; index++) {
      clearInstanceConfig(id)
      owners.push(ensureInstanceConfigLoaded(id))
      gates[index].resolve({ messageHistory: ["retired"], agentModelSelections: {} })
      await owners[index]
      await new Promise<void>(done => setImmediate(done))
    }
    await rejected
    assert.equal(gates.length, 4, "the joining reader never starts an extra request")
    assert.deepEqual(getInstanceConfig(id).messageHistory, [])
    gates[3].resolve({ messageHistory: ["current"], agentModelSelections: {} })
    await owners[3]
    assert.deepEqual(getInstanceConfig(id).messageHistory, ["current"])
  } finally {
    for (const gate of gates) gate.resolve({})
    await Promise.allSettled(owners)
    serverApi.readInstanceData = original; clearInstanceConfig(id)
  }
})
