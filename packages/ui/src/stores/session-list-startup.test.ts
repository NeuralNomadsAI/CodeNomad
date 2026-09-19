import assert from "node:assert/strict"
import { it } from "node:test"
import { sdkManager } from "../lib/sdk-manager"
import { addInstance, removeInstance } from "./instances"
import { fetchSessions, hydrateRestoredSessionChain, refreshSessionRuntimeStatus } from "./session-api"
import { applyOpenCodeDataEvent, destroyOpenCodeData } from "./opencode-data"
import { beginSessionGenerationAdmission, getSessionListIds, loading, sessions, setSessions, setSessionStatus } from "./session-state"

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
    first, client, reads: () => reads,
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

it("retries direct saved-session hydration superseded by the first connection", async () => {
  const id = "restored-session-connect"
  const f = fixture(id)
  const response = deferred<any>()
  let calls = 0
  f.client.session.get = async () => ++calls === 1 ? response.promise : page("saved").data[0]
  try {
    const hydration = hydrateRestoredSessionChain(id, ["saved"])
    f.connect()
    response.resolve(page("obsolete").data[0])
    await hydration
    assert.equal(calls, 2)
    assert.equal(sessions().get(id)?.get("saved")?.title, "saved")
    f.client.session.get = async () => { throw new Error("Temporary proxy failure") }
    await assert.rejects(hydrateRestoredSessionChain(id, ["another"]), /Temporary proxy failure/)
  } finally { f.cleanup() }
})

it("publishes the directory page before a stalled runtime-status map settles", async () => {
  const id = "startup-slow-active"
  const listGate = deferred<any>()
  const activeGate = deferred<any>()
  const client: any = { session: {
    active: async () => activeGate.promise,
    list: async () => listGate.promise,
  } }
  ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
  addInstance({ id, folder: "/repo", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  try {
    const request = fetchSessions(id)
    listGate.resolve(page("root"))
    await new Promise<void>((resolve) => setImmediate(resolve))
    // The slow active map must not gate list publication.
    assert.deepEqual(getSessionListIds(id), ["root"])
    activeGate.resolve({ root: "running" })
    await request
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(sessions().get(id)?.get("root")?.status, "working")
  } finally {
    destroyOpenCodeData(id)
    setSessions((previous) => { const next = new Map(previous); next.delete(id); return next })
    removeInstance(id, { authoritative: false })
    sdkManager.destroyClientsForInstance(id)
  }
})

it("discards late list statuses after cancellation and preserves newer native status", async () => {
  const id = "late-list-runtime"
  const f = fixture(id)
  try {
    f.first.resolve(page("current"))
    await fetchSessions(id)
    const status = deferred<any>()
    f.client.session.active = () => status.promise
    const controller = new AbortController()
    await fetchSessions(id, { signal: controller.signal })
    setSessionStatus(id, "current", "working")
    controller.abort()
    status.resolve({})
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(sessions().get(id)?.get("current")?.status, "working")
    const nextStatus = deferred<any>()
    f.client.session.active = () => nextStatus.promise
    await fetchSessions(id)
    setSessionStatus(id, "current", "idle")
    nextStatus.resolve({ current: "running" })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(sessions().get(id)?.get("current")?.status, "idle")
  } finally { f.cleanup() }
})

it("reconciles liveness without rereading history and preserves newer SSE and admissions", async () => {
  const id = "runtime-only-reconciliation"
  const f = fixture(id)
  try {
    f.first.resolve(page("current"))
    await fetchSessions(id)
    const reads = f.reads()
    const status = deferred<any>()
    f.client.session.active = () => status.promise
    const request = refreshSessionRuntimeStatus(id)
    setSessionStatus(id, "current", "working")
    status.resolve({})
    await request
    assert.equal(sessions().get(id)?.get("current")?.status, "working")
    assert.equal(f.reads(), reads)
    const admission = beginSessionGenerationAdmission(id, "current")
    await refreshSessionRuntimeStatus(id)
    assert.notEqual(sessions().get(id)?.get("current")?.generationAdmissionToken, undefined)
    admission.rollback()
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
