import assert from "node:assert/strict"
import { test } from "node:test"
import { serverApi } from "../lib/api-client"
import { clearInstanceConfig } from "./instance-config"
import { sdkManager } from "../lib/sdk-manager"
import { addInstance, removeInstance } from "./instances"
import { setProviders, setSessions, setAgents } from "./session-state"
import { updateSessionModel } from "./session-actions"
import { createSession } from "./session-api"

for (const retire of [false, true]) test(`a new session joining a cold preference load retains its stored model (retire=${retire})`, async () => {
  const id = `cold-owner-permanent-${retire}`, original = { readInstanceData: serverApi.readInstanceData, writeInstanceData: serverApi.writeInstanceData, patchStateOwner: serverApi.patchStateOwner }
  let release!: () => void, started!: () => void
  const gate = new Promise<void>(done => { release = done }), entered = new Promise<void>(done => { started = done })
  let persisted: any = { messageHistory: ["retained history"], agentModelSelections: { build: { providerId: "p", modelId: "preferred" } } }
  let reads = 0, writes = 0, switches = 0
  const creates: any[] = []
  serverApi.readInstanceData = async () => { reads++; if (reads === 1) { started(); await gate }; return structuredClone(persisted) }
  serverApi.writeInstanceData = async (_id, value) => { writes++; persisted = structuredClone(value) }
  serverApi.patchStateOwner = async (_owner, value) => value as any
  const client: any = { session: {
    switchModel: async () => { switches++ }, list: async () => ({ data: [], cursor: {} }),
    create: async (value: any) => { creates.push(value); return { id: "created", agent: "build", model: value.model, location: { directory: "/same/" }, time: { created: 2, updated: 2 } } },
  } }
  ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
  addInstance({ id, folder: "/same/", client, status: "ready", proxyPath: "", port: 0, pid: 0,
    binding: { serverId: `cold-server-permanent-${retire}`, directory: "/same/" }, capabilities: { generation: 1 } as any })
  const row = { id: "one", instanceId: id, title: "one", agent: "build", model: { providerId: "p", modelId: "initial" }, parentId: null, status: "idle", location: { directory: "/same/" }, time: { created: 1, updated: 1 } }
  setSessions(new Map([[id, new Map([["one", row]])]]) as any)
  setAgents(new Map([[id, [{ id: "build", name: "build", mode: "primary", description: "" }]]]) as any)
  setProviders(new Map([[id, [{ id: "p", name: "p", models: ["initial", "preferred", "old-choice"].map(id => ({ id, name: id, providerId: "p" })) }]]]))
  try {
    const old = updateSessionModel(id, "one", { providerId: "p", modelId: "old-choice" })
    const finished = retire ? assert.rejects(old, /superseded/i) : old
    await entered
    const creation = createSession(id, "build")
    if (retire) setSessions(previous => new Map(previous).set(id, new Map()))
    release()
    const created = await creation
    await finished
    console.log("COLD_OWNER", JSON.stringify({ retire, reads, writes, creates, selected: created.model, persisted }))
    assert.equal(creates.length, 1)
    assert.equal(creates[0].model.id, "preferred", "the surviving instance must use the stored default, not a fallback from the retired load")
    assert.equal(persisted.agentModelSelections.build.modelId, "preferred")
    assert.equal(created.model.modelId, "preferred")
    assert.deepEqual(persisted.messageHistory, ["retained history"])
    assert.equal(reads, retire ? 2 : 1)
    assert.equal(writes, retire ? 1 : 2)
    assert.equal(switches, 1, "the retired action's native write is never replayed")
  } finally {
    release(); Object.assign(serverApi, original)
    clearInstanceConfig(id); removeInstance(id, { authoritative: false }); sdkManager.destroyClientsForInstance(id)
    setSessions(new Map()); setProviders(new Map()); setAgents(new Map())
  }
})
