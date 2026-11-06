import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { backendEvents, type ServerEvents } from "../lib/server-events"
import { serverApi } from "../lib/api-client"
import { sdkManager } from "../lib/sdk-manager"
import { sseManager } from "../lib/sse-manager"
import { addInstance, addPendingForm, addPermissionToQueue, ensureYoloStateSynced, getPermissionQueue,
  reconcilePendingRequestLiveness, removeInstance, sendFormCancel, sendFormReply, sendPermissionResponse,
  syncPendingRequests, togglePermissionAutoAcceptForSession } from "./instances"
import { getFormQueue } from "./forms"
import { isPermissionAutoAcceptEnabled, setPermissionAutoAcceptEnabled } from "./permission-auto-accept"
import { hydrateRestoredSessionChain, loadLatestMessageWindow } from "./session-api"
import { sessions, setSessions } from "./session-state"
import { getPendingWorktreeSlug, reloadWorktrees, setWorktreeSlugForParentSession } from "./worktrees"
import { createClientSession } from "../types/session"
import { registerLocalBackendFixture } from "../../tests/contracts/local-backend-fixture"

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function fixture(t: TestContext, name: string) {
  const backendId = `runtime_${name}`, id = `${backendId}~workspace`, directory = "/repo"
  registerLocalBackendFixture(t, backendId)
  const source: Pick<ServerEvents, "on" | "onOpen" | "onDispose" | "onTransportStatus"> = {
    on: () => () => {}, onOpen: () => () => {}, onDispose: () => () => {}, onTransportStatus: () => () => {},
  }
  let detach = backendEvents.attach(backendId, source)
  const client = { session: {} } as any
  ;(sdkManager as any).clients.set(`${id}:/workspaces/workspace/instance`, client)
  addInstance({ id, backendId, folder: directory, port: 0, pid: 0, proxyPath: "", status: "ready", client })
  t.after(() => { detach(); removeInstance(id, { authoritative: false }); sdkManager.destroyClientsForInstance(id)
    setSessions(previous => { const next = new Map(previous); next.delete(id); return next }) })
  return { id, client, directory, replace() { detach(); detach = backendEvents.attach(backendId, source) } }
}
function seedSession(id: string, sessionId = "root", status: "idle" | "working" = "idle") {
  const session = createClientSession({ id: sessionId, title: sessionId, location: { directory: "/repo" },
    time: { created: 1, updated: 1 } } as any, id, "", undefined, status)
  setSessions(previous => new Map(previous).set(id, new Map([[sessionId, session]])))
}

test("late Yolo reads, toggle acknowledgements and toggle failures cannot publish on a replacement attachment", async t => {
  const h = fixture(t, "yolo"), old = deferred<any>()
  const get = serverApi.getYoloState, toggle = serverApi.toggleYolo
  t.after(() => { serverApi.getYoloState = get; serverApi.toggleYolo = toggle })
  let reads = 0
  serverApi.getYoloState = async () => ++reads === 1 ? old.promise : { enabled: false } as any
  ensureYoloStateSynced(h.id, "root")
  h.replace()
  ensureYoloStateSynced(h.id, "root")
  await tick()
  old.resolve({ enabled: true }); await tick()
  assert.equal(reads, 2)
  assert.equal(isPermissionAutoAcceptEnabled(h.id, "root"), false)
  for (const fail of [false, true]) {
    const response = deferred<any>()
    setPermissionAutoAcceptEnabled(h.id, "root", false)
    serverApi.toggleYolo = () => response.promise
    togglePermissionAutoAcceptForSession(h.id, "root")
    h.replace()
    setPermissionAutoAcceptEnabled(h.id, "root", fail)
    if (fail) response.reject(new Error("late failure"))
    else response.resolve({ enabled: true })
    await tick()
    assert.equal(isPermissionAutoAcceptEnabled(h.id, "root"), fail)
  }
})

test("pending scans share their exact Promise on A and cannot publish or retry through B", async t => {
  const h = fixture(t, "pending"), response = deferred<any>()
  const original = serverApi.getPendingRequests
  t.after(() => { serverApi.getPendingRequests = original })
  let reads = 0
  const snapshot = (id: string) => ({ supported: true as const, directories: [{ directory: h.directory, status: "ok" as const,
    locations: [{ location: { directory: h.directory }, permissions: [{ id, sessionID: "root", action: "read", resources: [] }], forms: [] }] }] })
  serverApi.getPendingRequests = async () => ++reads === 1 ? response.promise : snapshot("fresh")
  const first = syncPendingRequests(h.id), shared = syncPendingRequests(h.id)
  assert.equal(first, shared, "cancellation ownership must preserve shared Promise identity")
  await tick()
  h.replace()
  await syncPendingRequests(h.id)
  response.resolve(snapshot("obsolete")); await first
  assert.equal(reads, 2)
  assert.deepEqual(getPermissionQueue(h.id).map(row => row.id), ["fresh"])
})

test("liveness refreshes do not join a revoked read or start its pending follow-up", async t => {
  const h = fixture(t, "liveness"), old = deferred<any>()
  seedSession(h.id, "running", "working")
  let activeReads = 0, pendingReads = 0
  h.client.session.active = () => ++activeReads === 1 ? old.promise : Promise.resolve({ running: {} })
  const original = serverApi.getPendingRequests
  t.after(() => { serverApi.getPendingRequests = original })
  serverApi.getPendingRequests = async () => { pendingReads++; return { supported: true, directories: [{ directory: h.directory,
    status: "ok", locations: [{ location: { directory: h.directory }, permissions: [], forms: [] }] }] } }
  const first = reconcilePendingRequestLiveness(h.id)
  assert.equal(first, reconcilePendingRequestLiveness(h.id))
  await tick()
  h.replace()
  await reconcilePendingRequestLiveness(h.id)
  old.resolve({ running: {} }); await first
  assert.equal(activeReads, 2)
  assert.equal(pendingReads, 1)
})

test("compaction resume microtasks retain admission and an obsolete active hold cannot defer B", async t => {
  const h = fixture(t, "compaction"), original = serverApi.getPendingRequests
  t.after(() => { serverApi.getPendingRequests = original })
  let reads = 0
  serverApi.getPendingRequests = async () => { reads++; return { supported: true, directories: [{ directory: h.directory,
    status: "ok", locations: [{ location: { directory: h.directory }, permissions: [], forms: [] }] }] } }
  const compact = (phase: "started" | "ended", seq: number) => sseManager["handleEvent"](h.id, {
    id: `compaction-${seq}`, created: seq, type: `session.compaction.${phase}`, location: { directory: h.directory },
    durable: { aggregateID: "unloaded", seq, version: 1 }, data: { sessionID: "unloaded", reason: "auto" },
  } as any)
  compact("started", 1)
  await syncPendingRequests(h.id)
  assert.equal(reads, 0)
  compact("ended", 2)
  h.replace()
  await tick()
  assert.equal(reads, 0, "old resume microtask cannot acquire B")
  compact("started", 3)
  await syncPendingRequests(h.id)
  h.replace()
  await syncPendingRequests(h.id)
  assert.equal(reads, 1, "an active compaction from A loses liveness authority")
})

test("a queued family move retains A while a fresh B move proceeds without waiting or replay", async t => {
  const h = fixture(t, "move"), old = deferred<void>(), fresh = deferred<void>()
  seedSession(h.id)
  const original = serverApi.fetchWorktrees
  t.after(() => { serverApi.fetchWorktrees = original })
  serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: ["root", "first", "queued", "fresh"].map(slug => ({
    slug, kind: "worktree" as const, directory: slug === "root" ? "/repo" : `/repo-${slug}`,
  })) })
  await reloadWorktrees(h.id)
  const moves: string[] = [], refreshes: string[] = []
  const options = { moveFamily: async (_id: string, _root: string, slug: string) => {
    moves.push(slug); await (slug === "first" ? old.promise : fresh.promise)
  }, refreshSessions: async () => { refreshes.push("refresh") } }
  const first = setWorktreeSlugForParentSession(h.id, "root", "first", options)
  await tick()
  const queued = setWorktreeSlugForParentSession(h.id, "root", "queued", options)
  await tick()
  h.replace()
  const current = setWorktreeSlugForParentSession(h.id, "root", "fresh", options)
  await tick()
  assert.deepEqual(moves, ["first", "fresh"])
  old.resolve(); await Promise.all([first, queued])
  assert.equal(getPendingWorktreeSlug(h.id, "root"), "fresh", "old finally cannot clear the replacement selector")
  assert.deepEqual(refreshes, [])
  fresh.resolve(); await current
  assert.deepEqual(refreshes, ["refresh"])
  assert.deepEqual(moves, ["first", "fresh"])
})

test("restored ancestry retries never reacquire a replacement attachment", async t => {
  const h = fixture(t, "restore"), response = deferred<any>()
  let reads = 0
  h.client.session.get = () => ++reads === 1 ? response.promise : Promise.resolve({ id: "restored", title: "Fresh",
    location: { directory: "/repo" }, time: { created: 1, updated: 1 } })
  const first = hydrateRestoredSessionChain(h.id, ["restored"])
  const rejected = assert.rejects(first, { name: "AbortError" })
  await tick()
  h.replace()
  response.resolve({ id: "restored", parentID: "obsolete-parent", title: "Obsolete", location: { directory: "/repo" }, time: { created: 1, updated: 1 } })
  await rejected
  assert.equal(reads, 1, "neither ancestry nor retry may acquire B")
  assert.equal(sessions().get(h.id)?.has("restored") ?? false, false)
  await hydrateRestoredSessionChain(h.id, ["restored"])
  assert.equal(reads, 2)
  assert.equal(sessions().get(h.id)?.get("restored")?.title, "Fresh")
})

test("shared transcript windows coalesce on A but a fresh B window never joins the revoked read", async t => {
  const h = fixture(t, "messages"), response = deferred<any>()
  seedSession(h.id)
  let reads = 0
  h.client.message = { list: () => ++reads === 1 ? response.promise : Promise.resolve({ data: [], cursor: {} }) }
  const first = loadLatestMessageWindow(h.id, "root")
  const shared = loadLatestMessageWindow(h.id, "root")
  await tick()
  assert.equal(reads, 1)
  h.replace()
  assert.equal(await loadLatestMessageWindow(h.id, "root"), true)
  response.resolve({ data: [], cursor: {} })
  assert.deepEqual(await Promise.all([first, shared]), [false, false])
  assert.equal(reads, 2)
})

for (const action of ["permission", "reply", "cancel"] as const) for (const fail of [false, true]) {
  test(`late ${action} ${fail ? "failure" : "acknowledgement"} neither settles B nor launches reconciliation`, async t => {
    const h = fixture(t, `${action}_${fail}`), response = deferred<void>()
    const original = serverApi.getPendingRequests
    t.after(() => { serverApi.getPendingRequests = original })
    let reads = 0, writes = 0
    serverApi.getPendingRequests = async () => { reads++; return { supported: true, directories: [] } }
    const send = () => { writes++; return response.promise }
    h.client.permission = { reply: send }
    h.client.session.form = { reply: send, cancel: send }
    addPermissionToQueue(h.id, { id: "permission", sessionID: "root", action: "read", resources: [] }, h.directory)
    addPendingForm(h.id, { id: "form", sessionID: "global", title: "Question", fields: [{ key: "answer", type: "string", title: "Answer" }], location: { directory: h.directory } })
    const pending = action === "permission" ? sendPermissionResponse(h.id, "root", "permission", "once")
      : action === "reply" ? sendFormReply(h.id, "form", {}) : sendFormCancel(h.id, "form")
    const settled = fail ? assert.rejects(pending, /late failure/) : pending
    h.replace()
    if (fail) response.reject(new Error("late failure")); else response.resolve()
    await settled; await tick()
    assert.equal(writes, 1)
    assert.equal(reads, 0)
    assert.equal(getPermissionQueue(h.id).length, 1)
    assert.equal(getFormQueue(h.id).length, 1)
  })
}
