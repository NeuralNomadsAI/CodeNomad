import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import http from "node:http"
import Fastify from "fastify"
import { resolveConfigLocation } from "../../config/location"
import { EventBus } from "../../events/bus"
import { createLogger } from "../../logger"
import { SESSION_FAVORITES_OWNER, SettingsService } from "../../settings/service"
import { createHash } from "node:crypto"
import { canonicalWorktreeIdentity } from "../../workspaces/manager"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { SessionCleanupFence } from "../session-cleanup-fence"
import { registerSessionCleanupRoute } from "./session-cleanup"
import { registerSessionFavoritesRoutes } from "./session-favorites"

const root = "ses_root", child = "ses_child", other = "ses_other"
const wide = "/api/workspaces/wide", narrow = "/api/workspaces/narrow"
const page = (data: unknown[] = []) => ({ cursor: {}, data })
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(complete => { resolve = complete })
  return { promise, resolve }
}
const barrier = () => {
  const seen = deferred(), resume = deferred()
  return { wait: seen.promise, release: resume.resolve, async hold() { seen.resolve(); await resume.promise } }
}

async function fixture(t: import("node:test").TestContext, reconciliationDeadline?: () => AbortSignal) {
  const dir = await mkdtemp(path.join(tmpdir(), "codenomad-session-cleanup-"))
  const app = Fastify(), eventBus = new EventBus(), cfg = resolveConfigLocation(dir)
  const disconnected = deferred()
  app.addHook("onRequest", async (request, reply) => {
    if (request.headers["x-test-disconnect"] === "1") reply.raw.once("close", () => disconnected.resolve())
  })
  t.after(async () => { try { await app.close() } finally { await rm(dir, { recursive: true, force: true }) } })
  const settings = new SettingsService(cfg, eventBus, createLogger({ level: "silent" }))
  const paths = { wide: { path: "/scope" }, narrow: { path: "/scope/narrow" } }
  const make = (id: string, directory: string, parentID?: string) =>
    ({ id, parentID, projectID: "p", location: { directory }, time: { created: 1, updated: 1 } })
  const native = new Map([
    [root, make(root, "/scope")], [child, make(child, "/scope/narrow", root)], [other, make(other, "/scope")],
  ])
  const removed: string[] = []
  const controls = {
    get: async (id: string) => {
      const info = native.get(id)
      if (!info) throw { _tag: "SessionNotFoundError", sessionID: id, message: "not found" }
      return info
    },
    message: async (_id: string): Promise<unknown> => page(),
    inbox: async (): Promise<unknown[]> => [],
    forms: async (): Promise<unknown[]> => [],
    permissions: async (): Promise<unknown[]> => [],
    children: async (_id: string): Promise<unknown> => page(),
    active: async (): Promise<unknown> => ({}),
    beforeOwnership: async (_id: string) => {},
    remove: async (id: string, _signal?: AbortSignal) => { removed.push(id); native.delete(id) },
  }
  const connection = { assertCurrent() {}, client: {
    session: {
      get: ({ sessionID }: { sessionID: string }) => controls.get(sessionID),
      list: ({ parentID }: { parentID: string }) => controls.children(parentID),
      inbox: { list: () => controls.inbox() },
      form: { list: () => controls.forms() },
      active: () => controls.active(),
      remove: ({ sessionID }: { sessionID: string }, options?: { signal: AbortSignal }) => controls.remove(sessionID, options?.signal),
    },
    message: { list: ({ sessionID }: { sessionID: string }) => controls.message(sessionID) },
    permission: { request: { list: async ({ location }: { location: { directory: string } }) => ({ location, data: await controls.permissions() }) } },
  } }
  const workspaceManager = {
    get: (id: keyof typeof paths) => paths[id],
    getExistingSharedServiceConnection: () => connection,
    getSharedServiceConnection: async () => connection,
    ownsLocation: async (id: keyof typeof paths, location: { directory: string }) => {
      await controls.beforeOwnership(id)
      return location.directory === paths[id].path || location.directory.startsWith(`${paths[id].path}/`)
    },
    getWorktreeIdentityForPath: async () => "/scope",
  } as any
  const cleanup = new SessionCleanupFence()
  const isProtected = registerSessionFavoritesRoutes(app, { settings, workspaceManager, eventBus, cleanup, reconciliationDeadline })
  registerSessionCleanupRoute(app, { workspaceManager, isProtected, cleanup, worktreeDeletionFence: new WorktreeDeletionFence() })
  const save = (id: string, base = wide, favorite = true) =>
    app.inject({ method: "PUT", url: `${base}/session-favorites/${id}`, payload: { favorite } })
  const get = (base = wide, reconcile = false) =>
    app.inject({ url: `${base}/session-favorites${reconcile ? "?reconcile=1" : ""}` })
  const clean = (id: string) => app.inject({ method: "POST", url: `${wide}/session-cleanup/${id}` }).then(response => response.json().deleted)
  return { app, disconnected, controls, native, removed, cfg, eventBus, cleanup, clean, get, save, settings }
}

test("a favorite in a narrower workspace protects the session and its private foreign ancestor", async t => {
  const f = await fixture(t)
  assert.equal((await f.save(root, narrow)).statusCode, 403)
  const response = await f.save(child, narrow)
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json().records, { [child]: [] })
  assert.deepEqual((await f.get()).json().records, {})
  f.controls.message = async () => assert.fail("protected IDs never reach message inspection")
  assert.equal(await f.clean(child), false)
  assert.equal(await f.clean(root), false)
  assert.deepEqual(f.removed, [])
})

test("a foreign cleanup cannot reserve a session during initial ownership, and changed placement is refused", async t => {
  const f = await fixture(t)
  const validation = barrier()
  f.controls.beforeOwnership = async id => { if (id === "narrow") await validation.hold() }
  const attempt = f.app.inject({ method: "POST", url: `${narrow}/session-cleanup/${root}` }).then(response => response.json())
  try {
    await validation.wait
    const release = f.cleanup.enterMutation(root)
    assert.ok(release, "the owner remains free to mutate during a foreign probe")
    release()
  } finally { validation.release() }
  assert.deepEqual(await attempt, { deleted: false })
  let reads = 0
  const get = f.controls.get
  f.controls.get = async id => {
    const record = await get(id)
    return ++reads > 1 ? { ...record, location: { directory: "/outside" } } : record
  }
  assert.equal(await f.clean(root), false)
  assert.deepEqual(f.removed, [])
})

test("cleanup excludes pin and addressed writes while its final proof is outstanding", async t => {
  const f = await fixture(t)
  const proof = barrier()
  f.controls.message = async () => { await proof.hold(); return page() }
  const deleting = f.clean(root)
  try {
    await proof.wait
    assert.equal((await f.save(root)).statusCode, 409)
    assert.equal((await f.save(child, narrow)).statusCode, 409)
    assert.equal(f.cleanup.enterMutation(root), undefined)
    assert.equal(await f.clean(root), false)
  } finally { proof.release() }
  assert.equal(await deleting, true)
  assert.deepEqual(f.removed, [root])
  assert.equal((await f.save(root)).statusCode, 404)
})

test("an admitted writer or a message that arrives during ancillary reads prevents deletion", async t => {
  const f = await fixture(t)
  const release = f.cleanup.enterMutation(root)!
  assert.equal(await f.clean(root), false)
  release()
  const inbox = barrier()
  f.controls.inbox = async () => { await inbox.hold(); return [] }
  const deleting = f.clean(root)
  await inbox.wait
  f.controls.message = async () => page([{ id: "accepted" }])
  inbox.release()
  assert.equal(await deleting, false)
  assert.deepEqual(f.removed, [])
})

test("a pin keeps cleanup out across the final native target read", async t => {
  const f = await fixture(t)
  const verifying = barrier(), get = f.controls.get
  let targetReads = 0
  f.controls.get = async id => {
    const result = await get(id)
    if (id === child && ++targetReads === 2) await verifying.hold()
    return result
  }
  const pin = f.save(child, narrow)
  try {
    await verifying.wait
    assert.equal(await f.clean(root), false)
    assert.equal(await f.clean(child), false)
  } finally { verifying.release() }
  assert.equal((await pin).statusCode, 200)
  assert.equal(await f.clean(root), false)
})

test("malformed authority, a partial empty page, active work and queued input fail closed", async t => {
  const f = await fixture(t)
  f.controls.active = async () => ({ [root]: { type: "busy" } })
  assert.equal(await f.clean(root), false)
  f.controls.active = async () => ({})
  f.controls.inbox = async () => [{ id: "queued" }]
  assert.equal(await f.clean(root), false)
  f.controls.inbox = async () => []
  f.controls.forms = async () => [{ id: "pending-form" }]
  assert.equal(await f.clean(root), false)
  f.controls.forms = async () => []
  f.controls.permissions = async () => [{ sessionID: root }]
  assert.equal(await f.clean(root), false)
  f.controls.permissions = async () => []
  f.controls.message = async () => ({ data: [], cursor: { next: "another page" } })
  assert.equal(await f.clean(root), false)
  f.controls.message = async () => page()
  await writeFile(f.cfg.stateYamlPath, "sessionFavorites: [")
  assert.equal(await f.clean(root), false)
  assert.deepEqual(f.removed, [])
})

test("reconnect removes only exact confirmed absences; an unverified entry can still be unpinned", async t => {
  const f = await fixture(t)
  await f.save(root)
  await f.save(other)
  f.native.delete(root)
  const get = f.controls.get
  f.controls.get = async id => {
    if (id === other) throw new Error("transport failed")
    return get(id)
  }
  const changed = deferred()
  const off = f.eventBus.onEvent(event => { if (event.type === "storage.stateChanged") changed.resolve() })
  t.after(off)
  assert.deepEqual((await f.get(wide, true)).json().records, { [root]: [], [other]: [] })
  await changed.promise
  assert.deepEqual((await f.get()).json().records, { [other]: [] })
  assert.deepEqual((await f.save(other, wide, false)).json().records, {})
})

test("a full favorites quota reconciles deletions before admitting a new favorite", async t => {
  const f = await fixture(t)
  const key = createHash("sha256").update(canonicalWorktreeIdentity("/scope")).digest("hex")
  f.settings.mergePatchOwner("state", SESSION_FAVORITES_OWNER, {
    [key]: Object.fromEntries(Array.from({ length: 512 }, (_, index) => [`ses_missing_${index}`, []])),
  })
  assert.equal(Object.keys((await f.get()).json().records).length, 512)
  const saved = await f.save(other)
  assert.equal(saved.statusCode, 200)
  assert.deepEqual(saved.json().records, { [other]: [] })
})

test("a disconnected cleanup keeps the reservation until the native delete returns", { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  const base = await f.app.listen({ host: "127.0.0.1", port: 0 })
  const native = barrier(), remove = f.controls.remove, completed = deferred()
  let removerSignal: AbortSignal | undefined
  f.controls.remove = async (id, signal) => { removerSignal = signal; await native.hold(); await remove(id); completed.resolve() }
  const request = http.request(`${base}${wide}/session-cleanup/${root}`, { method: "POST", headers: { "x-test-disconnect": "1" } })
  request.on("error", () => {})
  request.end()
  try {
    await native.wait
    request.destroy()
    await f.disconnected.promise
    assert.equal((await f.save(root)).statusCode, 409)
    assert.deepEqual(f.removed, [])
    assert.ok(removerSignal)
    assert.equal(removerSignal.aborted, false)
  } finally { native.release() }
  await completed.promise
  assert.equal((await f.save(root)).statusCode, 404)
  assert.deepEqual(f.removed, [root])
})

test("cancelling cleanup during final preflight prevents native dispatch", { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  const base = await f.app.listen({ host: "127.0.0.1", port: 0 })
  const proof = barrier()
  f.controls.message = async () => { await proof.hold(); return page() }
  const request = http.request(`${base}${wide}/session-cleanup/${root}`, { method: "POST", headers: { "x-test-disconnect": "1" } })
  request.on("error", () => {})
  request.end()
  try {
    await proof.wait
    request.destroy()
    await f.disconnected.promise
  } finally { proof.release() }
  await f.app.close()
  assert.deepEqual(f.removed, [])
  assert.ok(f.native.has(root))
})

test("a lost native delete response blocks contradictory operations until exact absence", async t => {
  const f = await fixture(t)
  f.controls.remove = async () => { throw new Error("outcome unavailable") }
  const rejected = await f.app.inject({ method: "POST", url: `${wide}/session-cleanup/${root}` })
  assert.equal(rejected.statusCode, 503)
  assert.equal((await f.save(root)).statusCode, 409)
  assert.equal(await f.clean(root), false)
  assert.equal((await f.save(root)).statusCode, 409)
  f.native.delete(root)
  assert.equal(await f.clean(root), false)
  assert.equal(f.cleanup.hasUncertain(root), false)
})

test("quota reconciliation retains confirmed absences despite timeout and preserves re-added entries", { timeout: 10_000 }, async t => {
  const deadline = new AbortController()
  const f = await fixture(t, () => deadline.signal)
  const key = createHash("sha256").update(canonicalWorktreeIdentity("/scope")).digest("hex")
  const fillers = Array.from({ length: 510 }, (_, index) => `ses_slow_${index}`)
  f.settings.mergePatchOwner("state", SESSION_FAVORITES_OWNER, {
    [key]: Object.fromEntries([root, child, ...fillers].map(id => [id, []])),
  })
  const get = f.controls.get
  const held = barrier()
  f.controls.get = async id => {
    if (id === child || id === root) throw { _tag: "SessionNotFoundError", sessionID: id, message: "gone" }
    if (id.startsWith("ses_slow_")) { await held.hold(); throw new Error("unavailable") }
    return get(id)
  }
  const request = f.save(other)
  try {
    await held.wait
    assert.equal((await f.save(child, wide, false)).statusCode, 200)
    const scanning = f.controls.get
    f.controls.get = id => id === child || id === root ? get(id) : scanning(id)
    assert.equal((await f.save(child)).statusCode, 200)
    deadline.abort()
  } finally { held.release() }
  const response = await request
  assert.equal(response.statusCode, 200)
  const records = response.json().records
  assert.equal(Object.hasOwn(records, root), false)
  assert.deepEqual(Object.keys(records).sort(), [child, other, ...fillers].sort())
})
