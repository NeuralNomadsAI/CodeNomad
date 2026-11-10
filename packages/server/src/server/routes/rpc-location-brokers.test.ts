import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import Fastify from "fastify"
import { DesktopPluginLifecycle } from "../../opencode/desktop-plugin-lifecycle"
import { followPresence } from "../../opencode/desktop-plugin-presence"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { PanelExtensionStore } from "../../panel-extensions/store"
import { readPanelExtensionArchive } from "../../panel-extensions/archive"
import { fixtureArchive } from "../../panel-extensions/archive-fixture"
import { registerSessionPruningRoutes } from "./session-pruning"
import { registerImagesConversationRoute } from "./images-conversation"
import { registerPanelExtensionAssetRoutes } from "./panel-extension-assets"
import { registerPanelExtensionApi4Routes } from "./panel-extension-api4"
import { registerPendingRequestRoutes } from "./pending-requests"

const gate = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const slices = ["pruning", "history", "batch", "ranked", "navigation", "conversation", "assets", "api4", "pending"] as const
type Slice = typeof slices[number]

async function fixture(t: TestContext, options: { routeBudgetMs?: number; rankedContinuation?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rpc-brokers-"))
  const a = path.join(root, "A"), b = path.join(root, "B")
  await fs.mkdir(a); await fs.mkdir(b)
  const lifecycle = new DesktopPluginLifecycle("session-pruning", async () => Buffer.from("export {}"))
  const fence = new WorktreeDeletionFence(), app = Fastify(), store = new PanelExtensionStore(path.join(root, "extensions"))
  const packages = await Promise.all([2, 4].map(async apiVersion => {
    const pkg = await readPanelExtensionArchive(fixtureArchive("<p>x</p>", { id: `example.api${apiVersion}`, apiVersion,
      permissions: apiVersion === 2 ? ["session.context", "session.assets.read"] : ["session.context", "session.images.read", "images.conversation", "composer.prefill"] }))
    await store.install(pkg); await store.activate(pkg.manifest.id, pkg.digest, true)
    return pkg
  }))
  let base = { directory: b }, workspace: any = { id: "w", path: b }, currentConnection = true, owned = true, sessionDirectory = b
  let catalogueHook = async (_signal: AbortSignal) => {}, state = "active"
  const followers = new Map<string, () => Promise<void>>()
  const calls: Array<{ method: string; input: any; directory: string; signal: AbortSignal }> = []
  const catalogues: string[] = [], prepared: string[] = []
  const preparations: Promise<void>[] = []
  const client: any = {
    session: { get: async () => ({ id: "s", projectID: "p", location: { directory: sessionDirectory } }) },
    location: { get: async ({ location }: any) => location },
    plugin: { list: async ({ location }: any, { signal }: any) => {
      catalogues.push(location.directory)
      assert(signal instanceof AbortSignal)
      await catalogueHook(signal)
      if (!followers.has(location.directory) && state === "active") followers.set(location.directory,
        await followPresence(path.join(root, "data", "session-pruning", "presence"), async () => () => {}, undefined, undefined, location.directory))
      return { location, data: [{ id: "codenomad-session-pruning", state: { status: state } }] }
    } },
    rpc: Object.assign(() => ({ scheduleCarrierRead: async () => ({ owned: false }) }), { call: async ({ method, input, location }: any, { signal }: any) => {
      signal.throwIfAborted(); assert(currentConnection)
      assert(prepared.includes(location.directory), "useful RPC must follow successful targeted preparation")
      calls.push({ method, input, directory: location.directory, signal })
      const output = method === "preview" ? { status: "preview", revision: "a".repeat(64), liveMutation: false, parts: [] }
        : method === "prune" ? { status: "blocked", reason: "maintenance_required" }
        : method === "pruneBatch" ? { results: input.candidates.map((c: any) => ({ messageID: c.messageID, result: { status: "blocked", reason: "maintenance_required" } })) }
        : method === "history" ? { status: "page", scanned: 1, tools: 0, reasoning: 0, skipped: 0, hits: [], candidates: [], cursor: null,
          sessions: [{ sessionID: "s", directory: location.directory, scanned: 1, tools: 0, reasoning: 0, skipped: 0 }] }
        : method === "historyRanked" ? { version: 1, status: "ranked", scanned: 0, candidates: 0, judged: 0, skipped: 0, prefilterBypassed: 0,
          matchedSessions: 0, capped: false, caps: [], exclusions: [], hits: [], sessions: [], cursor: options.rankedContinuation ? "native-page" : null }
        : method === "outlineLayout" ? { status: "outline", entries: [], total: 0, cursor: null, checkpoints: [] }
        : method === "imagesConversation" ? { status: "found", sessionID: "s", created: true }
        : { status: "page", entries: [], cursor: null }
      return { output }
    } }),
  }
  const connection: any = { client, endpoint: { url: "http://native.invalid" }, assertCurrent() { if (!currentConnection) throw new Error("Replaced") },
    fetch: async (_url: URL, init: RequestInit) => {
      const signal = init.signal as AbortSignal
      signal.throwIfAborted()
      const input = JSON.parse(String(init.body)).input
      assert(prepared.includes(b))
      calls.push({ method: "snapshot", input, directory: b, signal })
      return Response.json({ output: { originDirectory: b, data: input.directories.map((directory: string) => ({ directory, status: "complete", locations: [] })) } })
    } }
  const installation = await lifecycle.prepare({ config: path.join(root, "config"), data: path.join(root, "data") }, connection.assertCurrent, connection)
  installation.commit(); await installation.release()
  const manager: any = {
    get: () => workspace, getServiceLocation: () => base, getSharedServiceConnection: async () => connection, getSharedServiceClient: async () => client,
    ownsLocation: async (_id: string, location: any) => owned && [a, b].includes(location.directory),
    getServiceDirectoryForPath: async (_id: string, directory: string) => owned && directory === b ? b : undefined,
    getWorktreeIdentityForPath: async (_id: string, directory: string) => directory,
    getHostPathForServicePath: async (_id: string, directory: string) => directory,
    getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix", getServiceWslDistro: () => undefined,
    getWorktrees: async () => ({ isGitRepo: false, worktrees: [] }),
    desktopPluginsReady: async (target: any) => {
      assert(target, "fixed brokers must use the targeted overload")
      assert.equal(target.connection, connection)
      assert(target.deadlineAt <= Date.now() + 30_000)
      const pending = lifecycle.ready(target)
      preparations.push(pending)
      await pending
      prepared.push(target.location.directory)
    },
  }
  const deps = { workspaceManager: manager, worktreeDeletionFence: fence, store, excludeDesignFolder: async () => "excluded" as const }
  registerSessionPruningRoutes(app, deps); registerImagesConversationRoute(app, deps); registerPanelExtensionAssetRoutes(app, deps)
  registerPanelExtensionApi4Routes(app, { ...deps, ...options, imageSettings: { read: async () => { throw new Error("Not requested") } } })
  registerPendingRequestRoutes(app, { ...deps, readGitCommonDirectory: async () => "fixture-common" })
  t.after(async () => {
    await Promise.allSettled(preparations)
    await app.close()
    for (const stop of followers.values()) await stop()
    await lifecycle.stop()
    await fs.rm(root, { recursive: true, force: true })
  })
  const send = (slice: Slice, extra: Record<string, unknown> = {}) => {
    const payload = { sessionID: "s" }, pkg = packages[slice === "assets" ? 0 : 1]!
    const url = slice === "pruning" ? "/api/workspaces/w/session-pruning/prune" : slice === "history" ? "/api/workspaces/w/session-history/query"
      : slice === "batch" ? "/api/workspaces/w/session-history/prune" : slice === "ranked" ? "/api/workspaces/w/session-history/ranked"
      : slice === "navigation" ? "/api/workspaces/w/session-history/outline" : slice === "conversation" ? "/api/workspaces/w/images-conversation"
      : slice === "pending" ? `/api/workspaces/w/pending-requests?directories=${encodeURIComponent(b)}`
      : `/api/panel-extensions/${pkg.manifest.id}/${slice === "assets" ? "assets" : "images"}`
    const body = slice === "pruning" ? { ...payload, messageID: "m", revision: "a".repeat(64), indexes: [0] }
      : slice === "batch" ? { ...payload, candidates: [{ messageID: "m", revision: "a".repeat(64), toolCount: 1, reasoningCount: 0 }] }
      : slice === "ranked" ? { version: 1, query: "needle" } : slice === "conversation" ? { directory: b, mode: "new", title: "Images" }
      : slice === "assets" || slice === "api4" ? { ...payload, instanceId: "w", digest: pkg.digest } : payload
    return app.inject(slice === "pending" ? { url } : { method: "POST", url, payload: { ...body, ...extra } }).then(response => response)
  }
  return { a, b, app, send, calls, catalogues, prepared, manager, fence, connection, store, packages,
    drain: () => Promise.allSettled(preparations),
    warm: () => manager.desktopPluginsReady({ connection, location: { directory: a }, signal: AbortSignal.timeout(5_000), deadlineAt: Date.now() + 5_000, assertCurrent() {} }),
    hook: (callback: typeof catalogueHook) => { catalogueHook = callback },
    foreign: () => { owned = false }, fail: () => { state = "failed" },
    replace: () => { currentConnection = false }, close: () => { workspace = undefined },
    aba: () => { base = { directory: a }; base = { directory: b } }, move: () => { sessionDirectory = a } }
}

for (const slice of slices) {
  test(`${slice}: hot A then first cold B business dispatch uses the captured target exactly once`, async t => {
    const f = await fixture(t)
    await f.warm()
    const response = await f.send(slice)
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(f.calls.length, 1, response.body)
    assert.equal(f.calls[0]!.directory, f.b)
    assert.deepEqual(f.catalogues, [f.a, f.b])
    assert.deepEqual(f.prepared, [f.a, f.b])
  })
  test(`${slice}: foreign authority never activates a Location or dispatches business IO`, async t => {
    const f = await fixture(t); f.foreign()
    assert.notEqual((await f.send(slice)).statusCode, 200)
    assert.deepEqual(f.catalogues, []); assert.deepEqual(f.calls, [])
  })
  test(`${slice}: replacement during real catalogue wait prevents new dispatch and publication`, async t => {
    const f = await fixture(t), entered = gate(), release = gate()
    f.hook(async () => { entered.resolve(); await release.promise })
    const pending = f.send(slice)
    try { await entered.promise; f.replace() }
    finally { release.resolve() }
    const response = await pending
    assert(!["page", "found", "outline", "ranked"].includes(response.json().status))
    assert.equal(f.calls.length, 0)
  })
}

for (const [slice, invalidation] of [["history", "aba"], ["navigation", "close"], ["pruning", "move"], ["batch", "move"], ["conversation", "aba"]] as const) {
  test(`${slice}: ${invalidation} during preparation invalidates the captured placement`, async t => {
    const f = await fixture(t), entered = gate(), release = gate()
    f.hook(async () => { entered.resolve(); await release.promise })
    const pending = f.send(slice)
    try { await entered.promise; f[invalidation]() } finally { release.resolve() }
    await pending
    assert.equal(f.calls.length, 0)
  })
}

for (const slice of ["assets", "api4"] as const) test(`${slice}: exact grant revoked during preparation prevents dispatch`, async t => {
  const f = await fixture(t), entered = gate(), release = gate()
  f.hook(async () => { entered.resolve(); await release.promise })
  const pending = f.send(slice), pkg = f.packages[slice === "assets" ? 0 : 1]!
  try { await entered.promise; await f.store.activate(pkg.manifest.id, pkg.digest, false) } finally { release.resolve() }
  assert.equal((await pending).statusCode, 403)
  assert.equal(f.calls.length, 0)
})

test("failed catalogue rejects before a useful mutation without retry", async t => {
  const f = await fixture(t); f.fail()
  assert.deepEqual((await f.send("pruning")).json(), { status: "blocked", reason: "unavailable" })
  assert.equal(f.catalogues.length, 1); assert.equal(f.calls.length, 0)
})

for (const slice of ["history", "ranked"] as const) test(`${slice}: selected directories and continuations each prepare their exact Location`, async t => {
  const f = await fixture(t, { rankedContinuation: true })
  f.manager.getWorktrees = async () => ({ isGitRepo: true, worktrees: [{ serviceDirectory: f.a }] })
  const first = await f.send(slice, { sessionID: undefined })
  assert.equal(first.statusCode, 200, first.body)
  assert(first.json().cursor, first.body)
  const second = await f.send(slice, { sessionID: undefined, cursor: first.json().cursor })
  assert.equal(second.statusCode, 200, second.body)
  assert.deepEqual(f.prepared, slice === "history" ? [f.a, f.b] : [f.a, f.b, f.a, f.b])
  assert.deepEqual(f.calls.map(call => call.directory), f.prepared)
})

test("a delete-and-unblock ABA while preparation waits invalidates a display read", async t => {
  const f = await fixture(t), entered = gate(), release = gate()
  f.hook(async () => { entered.resolve(); await release.promise })
  const pending = f.send("history")
  try { await entered.promise; await f.fence.run(f.b, [f.b], async () => {}) } finally { release.resolve() }
  assert.deepEqual((await pending).json(), { status: "blocked", reason: "unavailable" })
  assert.equal(f.calls.length, 0)
})

test("API4 conversation resolution retains the exact outer connection without reacquisition", async t => {
  const f = await fixture(t), pkg = f.packages[1]!
  let acquisitions = 0
  f.manager.getSharedServiceConnection = async () => {
    assert.equal(++acquisitions, 1, "resolver must use the captured outer connection")
    return f.connection
  }
  const response = await f.app.inject({ method: "POST", url: `/api/panel-extensions/${pkg.manifest.id}/conversationNew`, payload: {
    instanceId: "w", digest: pkg.digest, directory: f.b, title: "Images",
  } })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(acquisitions, 1)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0]!.method, "imagesConversation")
})

test("API4 deadline cancels and joins the targeted catalogue without a late dispatch", async t => {
  const f = await fixture(t, { routeBudgetMs: 100 }), entered = gate(), cancelled = gate(), release = gate()
  f.hook(async signal => {
    entered.resolve()
    signal.addEventListener("abort", cancelled.resolve, { once: true })
    await release.promise
  })
  const pending = f.send("api4")
  try {
    await entered.promise; await cancelled.promise
    assert.equal((await pending).statusCode, 503)
    assert.equal(f.calls.length, 0)
  } finally { release.resolve() }
  // Join the catalogue continuation, including the lifecycle's post-IO fence.
  await f.drain()
  assert.equal(f.calls.length, 0)
})

test("disconnecting a real navigation request cancels preparation and admits no RPC", async t => {
  const f = await fixture(t), entered = gate(), cancelled = gate()
  f.hook(signal => new Promise((_resolve, reject) => {
    entered.resolve()
    signal.addEventListener("abort", () => { cancelled.resolve(); reject(signal.reason) }, { once: true })
  }))
  const address = await f.app.listen({ host: "127.0.0.1", port: 0 }), caller = new AbortController()
  const pending = fetch(`${address}/api/workspaces/w/session-history/outline`, { method: "POST", signal: caller.signal,
    headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionID: "s" }) })
  await entered.promise
  caller.abort()
  await assert.rejects(pending)
  await cancelled.promise
  await f.drain()
  assert.equal(f.calls.length, 0)
})
