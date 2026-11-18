import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
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

async function fixture(t: import("node:test").TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "codenomad-session-cleanup-"))
  const app = Fastify(), eventBus = new EventBus(), cfg = resolveConfigLocation(dir)
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
    remove: async (id: string) => { removed.push(id); native.delete(id) },
  }
  const connection = { assertCurrent() {}, client: {
    session: {
      get: ({ sessionID }: { sessionID: string }) => controls.get(sessionID),
      list: ({ parentID }: { parentID: string }) => controls.children(parentID),
      inbox: { list: () => controls.inbox() },
      form: { list: () => controls.forms() },
      active: () => controls.active(),
      remove: ({ sessionID }: { sessionID: string }) => controls.remove(sessionID),
    },
    message: { list: ({ sessionID }: { sessionID: string }) => controls.message(sessionID) },
    permission: { request: { list: async ({ location }: { location: { directory: string } }) => ({ location, data: await controls.permissions() }) } },
    rpc: () => ({ scheduleCarrierRead: async () => ({ owned: false }) }),
  } }
  const workspaceManager = {
    get: (id: keyof typeof paths) => paths[id],
    getExistingSharedServiceConnection: () => connection,
    getSharedServiceConnection: async () => connection,
    ownsLocation: async (id: keyof typeof paths, location: { directory: string }) =>
      location.directory === paths[id].path || location.directory.startsWith(`${paths[id].path}/`),
    getWorktreeIdentityForPath: async () => "/scope",
  } as any
  const cleanup = new SessionCleanupFence()
  const isProtected = registerSessionFavoritesRoutes(app, { settings, workspaceManager, eventBus, cleanup })
  registerSessionCleanupRoute(app, { workspaceManager, isProtected, cleanup, worktreeDeletionFence: new WorktreeDeletionFence() })
  const save = (id: string, base = wide, favorite = true) =>
    app.inject({ method: "PUT", url: `${base}/session-favorites/${id}`, payload: { favorite } })
  const get = (base = wide, reconcile = false) =>
    app.inject({ url: `${base}/session-favorites${reconcile ? "?reconcile=1" : ""}` })
  const clean = (id: string) => app.inject({ method: "POST", url: `${wide}/session-cleanup/${id}` }).then(response => response.json().deleted)
  return { controls, native, removed, cfg, eventBus, cleanup, clean, get, save, settings }
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
