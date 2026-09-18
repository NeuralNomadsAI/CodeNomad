import assert from "node:assert/strict"
import { it } from "node:test"
import { sdkManager } from "../lib/sdk-manager"
import { addInstance, removeInstance } from "./instances"
import { fetchSessions } from "./session-api"
import { applyOpenCodeDataEvent, destroyOpenCodeData } from "./opencode-data"
import { getSessionListIds, loading, sessions, setSessions } from "./session-state"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function page(id: string) {
  return { data: [{ id, title: id, projectID: "project", location: { directory: "/repo" },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 } }], cursor: {} }
}

function fixture(id: string) {
  const first = deferred<ReturnType<typeof page>>()
  let reads = 0
  const client: any = { session: {
    active: async () => ({}),
    list: async () => ++reads === 1 ? first.promise : page("current"),
  } }
  ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
  addInstance({ id, folder: "/repo", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  return {
    first, reads: () => reads,
    connect: () => applyOpenCodeDataEvent(id, "/repo", { id: "connected", type: "server.connected", created: 1, data: {} } as any),
    cleanup: () => {
      destroyOpenCodeData(id)
      setSessions(previous => { const next = new Map(previous); next.delete(id); return next })
      removeInstance(id, { authoritative: false })
      sdkManager.destroyClientsForInstance(id)
    },
  }
}

it("settles startup with current sessions when the initial stream connection supersedes its HTTP read", async () => {
  const id = "startup-stream-race"
  const f = fixture(id)
  try {
    const startup = fetchSessions(id)
    f.connect()
    f.first.resolve(page("obsolete"))
    await startup
    assert.deepEqual(getSessionListIds(id), ["current"])
    assert.equal(sessions().get(id)?.has("obsolete") ?? false, false)
    assert.equal(loading().fetchingSessions.get(id) ?? false, false)
    assert.equal(f.reads(), 2)
  } finally { f.cleanup() }
})

it("does not restart a superseded startup read when a newer list request already owns recovery", async () => {
  const id = "startup-newer-read"
  const f = fixture(id)
  try {
    const startup = fetchSessions(id)
    f.connect()
    await fetchSessions(id)
    f.first.resolve(page("obsolete"))
    await startup
    assert.deepEqual(getSessionListIds(id), ["current"])
    assert.equal(f.reads(), 2)
  } finally { f.cleanup() }
})

it("leaves strict foreground recovery in charge of a superseded request", async () => {
  const id = "startup-strict-recovery"
  const f = fixture(id)
  try {
    const request = fetchSessions(id, { strictStatus: true })
    const rejected = assert.rejects(request, /superseded/)
    f.connect()
    f.first.resolve(page("obsolete"))
    await rejected
    assert.equal(f.reads(), 1)
    assert.equal(sessions().get(id)?.has("obsolete") ?? false, false)
    assert.equal(loading().fetchingSessions.get(id) ?? false, false)
  } finally { f.cleanup() }
})

it("does not revive an aborted startup read after the stream connects", async () => {
  const id = "startup-aborted-read"
  const f = fixture(id)
  const controller = new AbortController()
  try {
    const request = fetchSessions(id, { signal: controller.signal })
    f.connect()
    controller.abort()
    f.first.resolve(page("obsolete"))
    await request
    assert.equal(f.reads(), 1)
    assert.equal(sessions().get(id)?.has("obsolete") ?? false, false)
    assert.equal(loading().fetchingSessions.get(id) ?? false, false)
  } finally { f.cleanup() }
})
