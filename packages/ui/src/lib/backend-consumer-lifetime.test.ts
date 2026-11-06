import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import fs from "node:fs"
import ts from "typescript"
import { ServerEvents, backendEvents } from "./server-events"
import { integrations, integrationBindings } from "../stores/integrations"
import { addInstance, removeInstance } from "../stores/instances"
import { sessions, setSessions } from "../stores/session-state"
import { handleNativeSessionEvent } from "../stores/session-events"
import { sdkManager } from "./sdk-manager"
import { filesystemInvalidationVersion } from "./filesystem-events"
import { sessionGoals } from "../stores/session-goal"
import { serverApi } from "./api-client"
import { TrailingResyncCoordinator } from "./trailing-resync"
import { registerLocalBackendFixture } from "../../tests/contracts/local-backend-fixture"

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function source() {
  return new ServerEvents({ api: { connectEvents: () => ({ close() {} } as EventSource), sendClientConnectionPong: async () => {} },
    auth: { check: async () => {}, onRestored: () => () => false } })
}
const emit = (source: ServerEvents, event: unknown) => Reflect.get(source, "dispatch").call(source, event)
const open = (source: ServerEvents) => Reflect.get(source, "notify").call(source, Reflect.get(source, "openHandlers"), undefined, "open")
const catalog = { integrations: [], catalog: { state: "fresh" } }
function attach(t: TestContext, id: string, events = source()) {
  registerLocalBackendFixture(t, id)
  const detach = backendEvents.attach(id, events)
  t.after(() => { detach(); events.dispose() })
  return { events, detach }
}

test("catalog event timer cannot acquire new IO after detach", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const a = attach(t, "catalog_timer"), id = "catalog_timer~ws"
  t.after(() => integrations.clearInstance(id))
  let reads = 0
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    if (String(input).includes("/integrations?")) reads++
    return Response.json(catalog)
  })
  t.after(integrations.demand(id, "/repo")); await tick(); await tick()
  assert.equal(reads, 1)
  emit(a.events, { type: "instance.event", instanceId: "ws", event: { type: "config.updated", data: {} } })
  a.detach()
  t.mock.timers.tick(350); await tick()
  assert.equal(reads, 1)
})

test("catalog response cannot publish after detach and retained demand reads under the replacement", async t => {
  const a = attach(t, "catalog_response"), id = "catalog_response~ws"
  t.after(() => integrations.clearInstance(id))
  let release!: (response: Response) => void, signal!: AbortSignal, reads = 0
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (++reads > 1) return Response.json(catalog)
    signal = init!.signal!
    return new Promise<Response>(resolve => { release = resolve })
  })
  t.after(integrations.demand(id, "/repo")); await tick()
  a.detach(); release(Response.json(catalog)); await tick()
  assert.equal(signal.aborted, true)
  assert.notEqual(integrations.state(id, "/repo").status, "ready")
  const b = attach(t, "catalog_response")
  open(b.events); await tick(); await tick()
  assert.equal(reads, 2)
  assert.equal(integrations.state(id, "/repo").status, "ready")
})

test("retained binding demand recovers on reattachment while a released view never resurrects", async t => {
  const a = attach(t, "binding_retained")
  const target = { instanceId: "binding_retained~ws", directory: "/repo", sessionID: "s", integrationId: "i" }
  let reads = 0
  t.mock.method(globalThis, "fetch", async () => { reads++; return Response.json({ state: "attached", label: "current" }) })
  const release = integrationBindings.demand(target)
  t.after(release)
  await tick(); await tick()
  assert.equal(integrationBindings.state(target).state, "attached")
  a.detach()
  const b = attach(t, "binding_retained")
  open(b.events); await tick(); await tick()
  assert.equal(integrationBindings.state(target).state, "attached")
  assert.equal(reads, 2)
  release(); b.detach()
  const c = attach(t, "binding_retained")
  open(c.events); await tick()
  assert.equal(reads, 2)
})

test("unknown session recovery never joins the old attachment even with the same native client and generation", async t => {
  const a = attach(t, "session_coalesce"), id = "session_coalesce~ws"
  t.after(() => { removeInstance(id, { authoritative: false }); sdkManager.destroyClientsForInstance(id) })
  const resolvers: ((value: unknown) => void)[] = []
  const client = { session: { get: async () => new Promise(resolve => { resolvers.push(resolve) }) } }
  ;(Reflect.get(sdkManager, "clients") as Map<string, unknown>).set(`${id}:/workspaces/ws/instance`, client)
  addInstance({ id, backendId: "session_coalesce", folder: "/repo", port: 0, pid: 0, proxyPath: "", status: "ready", client: client as never })
  setSessions(current => new Map(current).set(id, new Map()))
  const event = { id: "e", type: "session.execution.started", created: 1, durable: { aggregateID: "s", seq: 1, version: 1 },
    location: { directory: "/repo" }, data: { sessionID: "s" } } as const
  handleNativeSessionEvent(id, event as never); await tick()
  assert.equal(resolvers.length, 1)
  a.detach(); attach(t, "session_coalesce")
  handleNativeSessionEvent(id, { ...event, id: "e2" } as never); await tick()
  const reads = resolvers.length
  for (const resolve of resolvers) resolve({ id: "s", title: "s", location: { directory: "/repo" }, time: { created: 1, updated: 1 } })
  await tick(); await tick()
  assert.equal(reads, 2)
  assert.equal(sessions().get(id)?.has("s"), true)
})

test("production initial hydration cannot admit supplemental metadata config or pending after revocation", async t => {
  const a = attach(t, "hydration_owner")
  const text = fs.readFileSync(new URL("../stores/instances.ts", import.meta.url), "utf8")
  const ast = ts.createSourceFile("instances.ts", text, ts.ScriptTarget.Latest, true)
  const names = ["startInstanceSessionHydration", "hydrateInstanceData"]
  const functions = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name!.text)).map(n => n.getText(ast))
  assert.equal(functions.length, 2)
  const js = ts.transpileModule(functions.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve }), seen: string[] = []
  const instance = { id: "hydration_owner~ws", client: {} }
  const deps = {
    serverEvents: backendEvents,
    reloadWorktrees: async () => {}, ensureWorktreesLoaded: async () => {}, instances: () => new Map([[instance.id, instance]]),
    loadInstanceProjectMetadata: async () => { seen.push("project") },
    fetchSessions: async () => { seen.push("sessions"); await wait },
    loadInstanceMetadata: async () => { seen.push("metadata") }, getActiveCatalogLocation: () => ({ directory: "/repo" }),
    refreshSessionCatalog: async () => { seen.push("catalog") }, ensureInstanceConfigLoaded: async () => { seen.push("config") },
    syncPendingRequests: async () => { seen.push("pending") }, log: { warn() {}, error() {} },
  }
  const hydrate = Function(...Object.keys(deps), `${js};return hydrateInstanceData`)(...Object.values(deps))
  const read = hydrate(instance.id); await tick()
  const before = [...seen]
  a.detach(); release(); await read; await tick()
  assert.deepEqual(seen, before)
})

test("old filesystem timer cannot invalidate a reattached backend", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const a = attach(t, "filesystem_owner"), id = "filesystem_owner~ws"
  const before = filesystemInvalidationVersion(id)
  emit(a.events, { type: "workspace.filesChanged", workspaceId: "ws" })
  a.detach(); attach(t, "filesystem_owner")
  t.mock.timers.tick(150)
  assert.equal(filesystemInvalidationVersion(id), before)
})

test("goal refresh admitted by open cannot publish after detach", async t => {
  const a = attach(t, "goal_owner"), id = "goal_owner~ws"
  t.after(() => sessionGoals.clearInstance(id))
  let reads = 0, release!: (value: unknown) => void, signal!: AbortSignal
  t.mock.method(serverApi, "fetchSessionGoal", async (_id: string, _session: string, parent?: AbortSignal) => {
    if (++reads === 1) return { status: "goal", goal: null } as never
    signal = parent!
    return new Promise(resolve => { release = resolve }) as never
  })
  t.after(sessionGoals.demand(id, "s")); await tick()
  open(a.events); await tick()
  assert.equal(reads, 2)
  a.detach(); release({ status: "unsupported" }); await tick()
  assert.equal(signal.aborted, true)
  assert.notEqual(sessionGoals.state(id, "s").status, "unsupported")
})

test("detach unsubscribes the source rather than merely suppressing delivery", t => {
  const events = source()
  const count = () => [
    [...(Reflect.get(events, "handlers") as Map<string, Set<unknown>>).values()].reduce((sum, bucket) => sum + bucket.size, 0),
    ...( ["openHandlers", "statusHandlers", "disposeHandlers"].map(key => (Reflect.get(events, key) as Set<unknown>).size)),
  ]
  const before = count()
  const owner = attach(t, "unsubscribe_owner", events)
  assert.notDeepEqual(count(), before)
  owner.detach()
  assert.deepEqual(count(), before)
})

test("an old ping callback after reconnect cannot send a pong", async t => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://ui.invalid" } } })
  t.after(() => before ? Object.defineProperty(globalThis, "window", before) : Reflect.deleteProperty(globalThis, "window"))
  const pings: ((value: { ts?: number }) => void)[] = []
  let pongs = 0
  const events = new ServerEvents({ api: {
    connectEvents: (_event, _error, ping) => { pings.push(ping!); return { close() {} } as EventSource },
    sendClientConnectionPong: async () => { pongs++ },
  }, auth: { check: async () => {}, onRestored: () => () => false } })
  t.after(() => events.dispose())
  events.start(); await tick(); events.restart(); await tick()
  assert.equal(pings.length, 2)
  pings[0]({ ts: 1 }); await tick()
  assert.equal(pongs, 0)
  pings[1]({ ts: 2 }); await tick()
  assert.equal(pongs, 1)
})

test("old resync finally preserves the replacement lane while it remains occupied", async () => {
  const releases: (() => void)[] = []
  const coordinator = new TrailingResyncCoordinator(async () => new Promise<void>(resolve => { releases.push(resolve) }), () => {})
  const a = new AbortController(), b = new AbortController()
  const old = coordinator.request("ws", a.signal); await tick()
  a.abort()
  const current = coordinator.request("ws", b.signal); await tick()
  releases[0](); await old
  const joined = coordinator.request("ws", b.signal)
  try { assert.equal(joined, current) }
  finally {
    b.abort()
    for (const release of releases) release()
    await Promise.all([current, joined])
  }
})
