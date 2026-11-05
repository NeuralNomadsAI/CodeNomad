import assert from "node:assert/strict"
import { it } from "node:test"
import { sdkManager } from "../lib/sdk-manager"
import { sseManager } from "../lib/sse-manager"
import { addInstance, removeInstance } from "./instances"
import { destroyOpenCodeData } from "./opencode-data"
import { messageStoreBus } from "./message-v2/bus"
import { fetchSessions, hydrateRestoredSessionChain, loadMessages, loadMoreSessions, refreshSessionRuntimeStatus, searchSessions } from "./session-api"
import { handleNativeSessionEvent, handleSessionUpdate } from "./session-events"
import { getSessionMessagesLoadError, sessions, setSessions, withSession } from "./session-state"

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const row = (title: string, archived = 1): any => ({ id: "s", title, agent: "build", parentID: null,
  model: { providerID: "p", id: "m" }, projectID: "project", location: { directory: "/Work/" },
  time: { created: 1, updated: 1, archived }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
function fixture(id: string, serverId = "A") {
  const client: any = { session: { active: async () => ({}),
    list: async () => ({ data: [], cursor: { next: "tail" } }), get: async () => row("Initial") } }
  ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
  addInstance({ id, folder: "/Work/", binding: { serverId, directory: "/Work/" }, capabilities: { generation: 1 } as any,
    port: 0, pid: 0, proxyPath: "", status: "ready", client })
  const previousHandler = sseManager.onNativeSessionEvent
  const previousUpdate = sseManager.onSessionUpdate
  sseManager.onNativeSessionEvent = handleNativeSessionEvent
  sseManager.onSessionUpdate = handleSessionUpdate
  return { id, client, deliver(type: string, data: Record<string, unknown> = {}) {
    ;(sseManager as any).handleEvent(id, { id: type, type, created: 2,
      location: { directory: "/Work/" }, data: { sessionID: "s", ...data } })
  }, cleanup() {
    sseManager.onNativeSessionEvent = previousHandler
    sseManager.onSessionUpdate = previousUpdate
    removeInstance(id, { authoritative: false }); sdkManager.destroyClientsForInstance(id); destroyOpenCodeData(id)
    messageStoreBus.unregisterInstance(id)
    setSessions(previous => { const next = new Map(previous); next.delete(id); return next })
  } }
}

for (const path of ["inventory", "continuation", "search", "ancestry"] as const) {
  for (const resident of [false, true]) for (const first of ["page", "lookup"] as const) {
    it(`${path}: current metadata repairs an earlier read (${resident ? "resident" : "cold"}, ${first} publishes first)`, async () => {
      const f = fixture(`metadata-merge-${path}-${resident}-${first}`)
      const page = deferred<any>(), metadata = deferred<any>(), listStarted = deferred<void>(), getStarted = deferred<void>()
      let older: Promise<void> | undefined
      try {
        if (path === "continuation") await fetchSessions(f.id)
        if (resident) setSessions(previous => new Map(previous).set(f.id, new Map([["s", {
          ...row("Captured"), instanceId: f.id, parentId: null, model: { providerId: "p", modelId: "m" },
          status: "idle", retry: null, runtimeStatusKnown: true,
        } as any]])))
        f.client.session.list = () => { listStarted.resolve(); return page.promise }
        let gets = 0
        f.client.session.get = () => {
          if (path === "ancestry" && ++gets === 1) { listStarted.resolve(); return page.promise }
          getStarted.resolve(); return metadata.promise
        }
        older = path === "inventory" ? fetchSessions(f.id)
          : path === "continuation" ? loadMoreSessions(f.id)
          : path === "search" ? searchSessions(f.id, "title") : hydrateRestoredSessionChain(f.id, ["s"])
        await listStarted.promise
        f.deliver(resident ? "session.forked" : "session.renamed", { title: "Renamed" })
        await getStarted.promise
        const completePage = () => page.resolve(path === "ancestry" ? row("Old title") : { data: [row("Old title")], cursor: {} })
        if (first === "page") {
          completePage(); await older
          assert.equal(sessions().get(f.id)?.get("s")?.title, "Old title")
        }
        metadata.resolve(row("Renamed", 2)); await tick()
        assert.equal(sessions().get(f.id)?.get("s")?.title, "Renamed")
        assert.equal(sessions().get(f.id)?.get("s")?.time.archived, 2)
        completePage(); await older
        assert.equal(sessions().get(f.id)?.get("s")?.title, "Renamed", "late older metadata cannot undo the current lookup")
        assert.equal(sessions().get(f.id)?.get("s")?.time.archived, 2)
      } finally {
        page.resolve(path === "ancestry" ? row("Old title") : { data: [], cursor: {} }); metadata.resolve(row("Renamed"))
        await older?.catch(() => {}); f.cleanup()
      }
    })
  }
}

for (const change of ["rename", "archive", "location", "working", "liveness"] as const) for (const resident of [false, true]) {
  it(`current metadata preserves a genuinely newer ${change} after inventory hydration (${resident ? "resident" : "cold"})`, async () => {
    const f = fixture(`metadata-newer-${change}-${resident}`), page = deferred<any>(), metadata = deferred<any>()
    const listStarted = deferred<void>(), getStarted = deferred<void>()
    let inventory: Promise<void> | undefined
    if (resident) setSessions(previous => new Map(previous).set(f.id, new Map([["s", {
      ...row("Captured"), instanceId: f.id, parentId: null, model: { providerId: "p", modelId: "m" }, status: "idle", retry: null,
    } as any]])))
    f.client.session.list = () => { listStarted.resolve(); return page.promise }
    f.client.session.get = () => { getStarted.resolve(); return metadata.promise }
    try {
      inventory = fetchSessions(f.id); await listStarted.promise
      f.deliver(resident ? "session.forked" : "session.renamed", { title: "Lookup title" })
      await getStarted.promise
      page.resolve({ data: [row("Old title")], cursor: {} }); await inventory
      if (change === "rename") f.deliver("session.renamed", { title: "Newer title" })
      if (change === "archive") withSession(f.id, "s", session => { session.time = { ...session.time, archived: 3 } })
      if (change === "location") f.deliver("session.moved", { projectID: "project", location: { directory: "/Else/" } })
      if (change === "working") f.deliver("session.execution.started")
      if (change === "liveness") await refreshSessionRuntimeStatus(f.id)
      metadata.resolve(row("Lookup title", 2)); await tick()
      const current = sessions().get(f.id)?.get("s")
      assert.equal(current?.title, change === "rename" ? "Newer title" : "Lookup title")
      assert.equal(current?.time.archived, change === "archive" ? 3 : 2)
      assert.equal(current?.location.directory, change === "location" ? "/Else/" : "/Work/")
      assert.equal(current?.status, change === "working" ? "working" : "idle")
    } finally {
      page.resolve({ data: [], cursor: {} }); metadata.resolve(row("Lookup title"))
      await inventory?.catch(() => {}); f.cleanup()
    }
  })
}

it("local cold metadata repairs an older inventory snapshot without weakening native rename authority", async () => {
  const f = fixture("metadata-merge-local", "local-shared"), page = deferred<any>(), metadata = deferred<any>()
  const listStarted = deferred<void>(), getStarted = deferred<void>()
  let inventory: Promise<void> | undefined
  f.client.session.list = () => { listStarted.resolve(); return page.promise }
  f.client.session.get = () => { getStarted.resolve(); return metadata.promise }
  try {
    inventory = fetchSessions(f.id); await listStarted.promise
    f.deliver("session.renamed", { title: "Renamed" }); await getStarted.promise
    page.resolve({ data: [row("Old title")], cursor: {} }); await inventory
    metadata.resolve(row("Renamed")); await tick()
    assert.equal(sessions().get(f.id)?.get("s")?.title, "Renamed")
    f.deliver("session.renamed", { title: "Newest" })
    assert.equal(sessions().get(f.id)?.get("s")?.title, "Newest")
  } finally {
    page.resolve({ data: [], cursor: {} }); metadata.resolve(row("Renamed"))
    await inventory?.catch(() => {}); f.cleanup()
  }
})

it("a new native row keeps metadata authority over a pending cold lookup", async () => {
  const f = fixture("metadata-native-created"), metadata = deferred<any>(), started = deferred<void>()
  f.client.session.get = () => { started.resolve(); return metadata.promise }
  try {
    f.deliver("session.renamed", { title: "Lookup title" }); await started.promise
    f.deliver("session.created", { title: "New native row", location: { directory: "/Work/" } })
    metadata.resolve(row("Lookup title")); await tick()
    assert.equal(sessions().get(f.id)?.get("s")?.title, "New native row")
  } finally { metadata.resolve(row("Lookup title")); f.cleanup() }
})

for (const change of ["none", "rename", "archive", "location", "working", "liveness"] as const) {
  it(`latest transcript projection retains HTTP provenance and newer ${change} authority`, { timeout: 3000 }, async () => {
    const f = fixture(`metadata-transcript-${change}`), page = deferred<any>(), metadata = deferred<any>()
    const listStarted = deferred<void>(), getStarted = deferred<void>()
    let inventory: Promise<void> | undefined
    f.client.session.list = () => { listStarted.resolve(); return page.promise }
    f.client.session.get = () => { getStarted.resolve(); return metadata.promise }
    f.client.message = { list: async () => ({ data: [{ id: "msg_1", type: "assistant", agent: "build",
      model: { providerID: "p", id: "m" }, time: { created: 1, completed: 2 },
      content: [{ type: "text", text: "ready" }] }], cursor: {} }) }
    try {
      inventory = fetchSessions(f.id); await listStarted.promise
      f.deliver("session.renamed", { title: "Renamed" }); await getStarted.promise
      page.resolve({ data: [row("Old title")], cursor: {} }); await inventory
      assert.equal(sessions().get(f.id)?.get("s")?.title, "Old title")
      if (change === "rename") f.deliver("session.renamed", { title: "Newer title" })
      if (change === "archive") withSession(f.id, "s", session => { session.time = { ...session.time, archived: 3 } })
      if (change === "working") f.deliver("session.execution.started")
      if (change === "liveness") await refreshSessionRuntimeStatus(f.id)
      assert.equal(await loadMessages(f.id, "s"), true)
      assert.equal(getSessionMessagesLoadError(f.id, "s"), undefined)
      assert.deepEqual(messageStoreBus.getOrCreate(f.id).getSessionMessageIds("s"), ["msg_1"])
      if (change === "location") f.deliver("session.moved", { projectID: "project", location: { directory: "/Else/" } })
      metadata.resolve(row("Renamed", 2)); await tick()
      const current = sessions().get(f.id)?.get("s")
      assert.equal(current?.title, change === "rename" ? "Newer title" : "Renamed")
      assert.equal(current?.time.archived, change === "archive" ? 3 : 2)
      assert.equal(current?.location.directory, change === "location" ? "/Else/" : "/Work/")
      assert.equal(current?.status, change === "working" ? "working" : "idle")
      assert.equal(current?.agent, "build")
      assert.deepEqual(current?.model, { providerId: "p", modelId: "m" })
    } finally {
      page.resolve({ data: [], cursor: {} }); metadata.resolve(row("Renamed"))
      await inventory?.catch(() => {}); f.cleanup()
    }
  })
}

it("native creation updating a resident HTTP row preserves provenance for untouched fields", async () => {
  const f = fixture("metadata-created-projection"), page = deferred<any>(), metadata = deferred<any>()
  const listStarted = deferred<void>(), getStarted = deferred<void>()
  let inventory: Promise<void> | undefined
  f.client.session.list = () => { listStarted.resolve(); return page.promise }
  f.client.session.get = () => { getStarted.resolve(); return metadata.promise }
  try {
    inventory = fetchSessions(f.id); await listStarted.promise
    f.deliver("session.renamed", { title: "Lookup title" }); await getStarted.promise
    page.resolve({ data: [row("Old title")], cursor: {} }); await inventory
    f.deliver("session.created", { title: "Native title", metadata: { native: true }, location: { directory: "/Work/" } })
    assert.equal(sessions().get(f.id)?.get("s")?.title, "Native title")
    metadata.resolve({ ...row("Lookup title", 3), cost: 2 }); await tick()
    const current = sessions().get(f.id)?.get("s")
    assert.equal(current?.title, "Native title")
    assert.deepEqual(current?.metadata, { native: true })
    assert.equal(current?.time.updated, 2)
    assert.equal(current?.time.archived, 1, "native time edits retain their field authority")
    assert.equal(current?.cost, 2, "untouched metadata still belongs to the earlier HTTP snapshot")
  } finally {
    page.resolve({ data: [], cursor: {} }); metadata.resolve(row("Lookup title"))
    await inventory?.catch(() => {}); f.cleanup()
  }
})
