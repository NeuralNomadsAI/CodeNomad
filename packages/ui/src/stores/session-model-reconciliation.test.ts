import assert from "node:assert/strict"
import { after, afterEach, before, it } from "node:test"
import { serverApi } from "../lib/api-client.ts"
import { sdkManager } from "../lib/sdk-manager.ts"
import { addInstance, removeInstance, updateInstance } from "./instances.ts"
import { sendMessage, updateSessionModel } from "./session-actions.ts"
import { handleNativeSessionEvent } from "./session-events.ts"
import { fetchSessions } from "./session-api.ts"
import { serializeSessionAction } from "./session-action-queue.ts"
import { reconcileSessionModel } from "./session-model-reconciliation.ts"
import { sessions, setSessions, setProviders, withSession } from "./session-state.ts"
import type { Session } from "../types/session.ts"

const instanceId = "model-reconciliation", sessionId = "session"
const storage = { fetchConfigOwner: serverApi.fetchConfigOwner, fetchStateOwner: serverApi.fetchStateOwner, patchStateOwner: serverApi.patchStateOwner }
before(() => {
  serverApi.fetchConfigOwner = async () => ({}) as any
  serverApi.fetchStateOwner = async () => ({}) as any
  serverApi.patchStateOwner = async (_owner, patch) => patch as any
})
after(() => Object.assign(serverApi, storage))
afterEach(() => {
  setSessions(new Map())
  setProviders(new Map())
  removeInstance(instanceId, { authoritative: false })
  sdkManager.destroyClientsForInstance(instanceId)
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function seed() {
  let nativeModel = "base", sequence = 0
  const events: any[] = [], calls: string[] = []
  const event = (model: string) => ({ id: `event-${++sequence}`, type: "session.model.selected", created: sequence,
    durable: { aggregateID: sessionId, seq: sequence, version: 1 },
    data: { sessionID: sessionId, model: { providerID: "provider", id: model } } })
  const info = () => ({ id: sessionId, title: sessionId, agent: "build", parentID: null,
    model: { providerID: "provider", id: nativeModel }, location: { directory: "/work" }, time: { created: 1, updated: 1 } })
  const client = { session: {
    list: async (): Promise<any> => ({ data: [info()], cursor: {} }),
    active: async () => ({ [sessionId]: {} }),
    get: async (_input?: unknown, _options?: unknown): Promise<any> => info(),
    instructions: { entry: { put: async () => {}, remove: async () => {} } },
    switchAgent: async () => {},
    switchModel: async ({ model }: any) => {
      calls.push(`model:${model.id}`)
      if (nativeModel !== model.id) { nativeModel = model.id; events.push(event(model.id)) }
    },
    prompt: async (input: any) => { calls.push(`prompt:${nativeModel}`); return { id: input.id } },
  } }
  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client: client as any })
  setSessions(new Map([[instanceId, new Map([[sessionId, {
    id: sessionId, instanceId, parentId: null, title: sessionId, agent: "build",
    model: { providerId: "provider", modelId: "base" }, status: "working",
    location: { directory: "/work" }, time: { created: 1, updated: 1 },
  } as Session]])]]))
  setProviders(new Map([[instanceId, [{ id: "provider", name: "Provider", models:
    ["base", "old", "new"].map(id => ({ id, name: id, providerId: "provider" })) }]]]))
  return { client, calls, events, info, native: () => nativeModel,
    external: (model: string) => { nativeModel = model; handleNativeSessionEvent(instanceId, event(model) as any) },
    deliver: () => handleNativeSessionEvent(instanceId, events.shift()),
  }
}
const displayed = () => sessions().get(instanceId)?.get(sessionId)?.model.modelId
const select = (modelId: string) => updateSessionModel(instanceId, sessionId, { providerId: "provider", modelId })

for (const listFirst of [true, false]) {
  it(`protects selection from a catalog captured during its write (list settles first: ${listFirst})`, async () => {
    const fixture = seed()
    const mutation = deferred<void>(), writeStarted = deferred<void>()
    const list = deferred<void>(), listStarted = deferred<void>()
    const get = deferred<void>(), getStarted = deferred<void>()
    const switchModel = fixture.client.session.switchModel
    fixture.client.session.switchModel = async input => {
      writeStarted.resolve()
      await mutation.promise
      await switchModel(input)
      if (fixture.events.length) fixture.deliver()
    }
    fixture.client.session.list = async () => {
      const snapshot = fixture.info()
      listStarted.resolve()
      await list.promise
      return { data: [snapshot], cursor: {} }
    }
    fixture.client.session.get = async () => {
      const snapshot = fixture.info()
      getStarted.resolve()
      await get.promise
      return snapshot
    }
    const selection = select("new")
    await writeStarted.promise
    const refreshing = fetchSessions(instanceId)
    await listStarted.promise
    if (listFirst) {
      list.resolve()
      await refreshing
      assert.equal(displayed(), "new", "Keep the optimistic choice while its write is pending")
    }
    mutation.resolve()
    await selection
    await getStarted.promise
    list.resolve()
    await refreshing
    assert.equal(displayed(), "new", "Stale catalog cannot overwrite the confirmed choice")
    get.resolve()
    await serializeSessionAction(instanceId, sessionId, async () => {})
    await sendMessage(instanceId, sessionId, "next")
    assert.equal(displayed(), "new")
    assert.equal(fixture.native(), "new")
    assert.equal(fixture.calls.at(-1), "prompt:new")
    assert.equal(sessions().get(instanceId)?.get(sessionId)?.modelSelectionPending, undefined)
  })
}

it("does not let delayed FIFO echoes overwrite a successful choice or the next prompt", async () => {
  const fixture = seed()
  await select("old")
  await select("new")
  fixture.deliver()
  assert.equal(displayed(), "new")
  await sendMessage(instanceId, sessionId, "next")
  while (fixture.events.length) fixture.deliver()
  await reconcileSessionModel(instanceId, sessionId)
  assert.deepEqual(fixture.calls, ["model:old", "model:new", "model:new", "prompt:new"])
  assert.equal(fixture.native(), "new")
  assert.equal(displayed(), "new")
  // A no-op switch has no echo. It must not leave a sticky local override that
  // ignores a later selection made in the TUI or another window.
  await select("new")
  fixture.external("old")
  await sendMessage(instanceId, sessionId, "external choice")
  assert.equal(fixture.calls.at(-1), "prompt:old")
  assert.equal(displayed(), "old")
})

it("coalesces event bursts into one trailing read without publishing stale snapshots", async () => {
  const fixture = seed(), held = deferred<any>(), started = deferred<void>()
  let reads = 0
  fixture.client.session.get = async () => {
    if (++reads === 1) { started.resolve(); return held.promise }
    return fixture.info()
  }
  const reading = reconcileSessionModel(instanceId, sessionId)
  await started.promise
  for (let i = 0; i < 20; i++) fixture.external(i % 2 ? "new" : "old")
  held.resolve({ model: { providerID: "provider", id: "base" } })
  await reading
  assert.equal(reads, 2)
  assert.equal(displayed(), "new")
})

it("keeps a later local selection ordered after a pending read", async () => {
  const fixture = seed(), held = deferred<any>(), started = deferred<void>()
  fixture.client.session.get = async () => { started.resolve(); return held.promise }
  const reading = reconcileSessionModel(instanceId, sessionId)
  await started.promise
  const selection = select("new")
  held.resolve({ model: { providerID: "provider", id: "old" } })
  await Promise.all([reading, selection])
  assert.equal(displayed(), "new")
  assert.equal(fixture.native(), "new")
})

it("retains selection on read failure and permits the next event to recover", async () => {
  const fixture = seed()
  await select("new")
  fixture.client.session.get = async () => { throw new Error("offline") }
  await reconcileSessionModel(instanceId, sessionId)
  assert.equal(displayed(), "new")
  fixture.client.session.get = async () => fixture.info()
  fixture.external("old")
  await reconcileSessionModel(instanceId, sessionId)
  assert.equal(displayed(), "old")
})

for (const supersede of ["client", "selection", "deletion"] as const) {
  it(`fences a pending response after ${supersede} changes`, async () => {
    const fixture = seed(), held = deferred<any>(), started = deferred<void>()
    fixture.client.session.get = async () => { started.resolve(); return held.promise }
    const reading = reconcileSessionModel(instanceId, sessionId)
    await started.promise
    if (supersede === "client") updateInstance(instanceId, { client: {} as any })
    if (supersede === "selection") withSession(instanceId, sessionId, session => { session.model = { providerId: "provider", modelId: "new" } })
    if (supersede === "deletion") setSessions(new Map())
    held.resolve({ model: { providerID: "provider", id: "old" } })
    await reading
    assert.equal(displayed(), supersede === "deletion" ? undefined : supersede === "selection" ? "new" : "base")
  })
}
