import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import fs from "node:fs"
import ts from "typescript"
import { createComputed, createRoot } from "solid-js"
import type { WorkspaceEventPayload } from "../../../server/src/api-types"
import { BackendEvents } from "./backend-events"
import { ServerEvents, backendEvents } from "./server-events"
import { useForegroundRefresh } from "./hooks/use-foreground-refresh"
import { createBackendClient } from "./backend-client"
import { createAuthRecovery } from "./auth-recovery"
import { getSseManager, sseManager } from "./sse-manager"
import { TrailingResyncCoordinator } from "./trailing-resync"
import { addInstance, instances, refreshWorkspaceList, removeInstance, updateInstance } from "../stores/instances"
import { getWorktrees, reloadWorktrees } from "../stores/worktrees"
import { serverApi } from "./api-client"
import type { Instance } from "../types/instance"
import { handleNativeSessionEvent } from "../stores/session-events"
import { sdkManager } from "./sdk-manager"
import { registerLocalBackendFixture } from "../../tests/contracts/local-backend-fixture"
import { sessions, setSessions } from "../stores/session-state"
import type { Session } from "../types/session"
import { reconcileSessionModel } from "../stores/session-model-reconciliation"
import { integrationBindings } from "../stores/integrations"

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function renderer(t: TestContext) {
  const before = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true,
    value: Object.assign(new EventTarget(), { location: { origin: "https://review.invalid" } }) })
  t.after(() => before ? Object.defineProperty(globalThis, "window", before) : Reflect.deleteProperty(globalThis, "window"))
}
function owner(t: TestContext) {
  renderer(t)
  let event!: (event: WorkspaceEventPayload) => void, error!: () => void, connections = 0
  let source!: EventSource
  const events = new ServerEvents({ api: {
    connectEvents: (onEvent, onError) => {
      event = onEvent; error = onError!; connections++
      source = { close() {} } as EventSource
      return source
    }, sendClientConnectionPong: async () => {},
  }, auth: { check: async () => {}, onRestored: () => () => false } })
  t.after(() => events.dispose())
  return { events, event: (value: WorkspaceEventPayload) => event(value), error: () => error(),
    open: () => source.onopen!(new Event("open")), connections: () => connections }
}
const changed = { type: "workspace.worktreesChanged", workspaceId: "ws" } as const
const emitStatus = (events: ServerEvents, status: string) => Reflect.get(events, "emitTransportStatus").call(events, status)

test("detach during wildcard delivery fences remaining and typed callbacks of the old attachment", async t => {
  const a = owner(t), bus = new BackendEvents(), seen: string[] = []
  const detach = bus.attach("race", a.events)
  t.after(detach)
  bus.on("*", () => { seen.push("wildcard"); detach() })
  bus.on("*", () => seen.push("late-wildcard"))
  bus.on("workspace.worktreesChanged", () => seen.push("late-typed"))
  a.events.start(); await tick()
  a.event(changed)
  assert.deepEqual(seen, ["wildcard"])
})

test("detach during connected delivery never publishes old connected after final disconnected", t => {
  const a = owner(t), bus = new BackendEvents(), seen: string[] = []
  const detach = bus.attach("race", a.events)
  t.after(detach)
  bus.onTransportStatus(status => { if (status === "connected") detach() })
  bus.onTransportStatus(status => seen.push(status))
  emitStatus(a.events, "connected")
  assert.deepEqual(seen, ["disconnected"])
})

test("dispose from the reconnect disconnected callback cannot install a timer or reopen the source", async t => {
  const a = owner(t)
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  let disconnected = 0
  a.events.onTransportStatus(status => { if (status === "disconnected" && ++disconnected === 2) a.events.dispose() })
  a.events.start(); await tick()
  a.error()
  assert.equal(Reflect.get(a.events, "retryTimer"), null)
  t.mock.timers.tick(20_000); await tick()
  assert.equal(a.connections(), 1)
  assert.equal(Reflect.get(a.events, "retryTimer"), null)
  assert.equal(Reflect.get(a.events, "connection"), null)
})

test("dispose from restart disconnected callback cannot dereference its cleared connection", async t => {
  const a = owner(t)
  a.events.onTransportStatus(status => { if (status === "disconnected") a.events.dispose() })
  a.events.start(); await tick()
  assert.doesNotThrow(() => a.events.restart())
  await tick()
  assert.equal(a.connections(), 1)
  assert.equal(Reflect.get(a.events, "connection"), null)
})

function appRecovery(deps: Record<string, unknown>) {
  const app = fs.readFileSync(new URL("../App.tsx", import.meta.url), "utf8")
  const ast = ts.createSourceFile("App.tsx", app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let callback: ts.Node | undefined
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "useForegroundRefresh") {
      callback = (node.arguments[0] as ts.ObjectLiteralExpression).properties.find(p => p.name?.getText(ast) === "onRefresh")
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(callback && ts.isPropertyAssignment(callback))
  const js = ts.transpileModule(`const callback = ${(callback as ts.PropertyAssignment).initializer.getText(ast)}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return Function(...Object.keys(deps), `${js}; return callback`)(...Object.values(deps))
}

test("detached foreground recovery cannot resume the production App callback against a reattached backend", async t => {
  const a = owner(t)
  let release!: () => void, requestSignal!: AbortSignal
  const pending = new Promise<void>(resolve => { release = resolve }), seen: string[] = []
  let active = { id: "race~old", backendId: "race", status: "ready", client: {} }
  const onRefresh = appRecovery({
    instances: () => new Map([[active.id, active]]), backendIdOf: (v: typeof active) => v.backendId,
    fetchSessions: async (_id: string, options: { signal: AbortSignal }) => { requestSignal = options.signal; seen.push("sessions"); await pending },
    withForegroundRefreshTimeout: (p: Promise<unknown>) => p,
    reloadWorktrees: async (id: string) => { seen.push(`worktrees:${id}`) },
    syncPendingRequests: async (id: string) => { seen.push(`pending:${id}`) },
    refreshVolatileInstanceState: async (id: string) => { seen.push(`volatile:${id}`) },
    syncLoadedSessionInboxes: async (id: string) => { seen.push(`inboxes:${id}`) },
    reconcilePendingSessionIndicators: (id: string) => seen.push(`indicators:${id}`),
    activeInstance: () => active, activeSessionIdForInstance: () => "session",
    messagesLoaded: () => new Map([[active.id, new Set(["other"])]]), parseInstanceKey: () => ({ backendId: "race" }),
    invalidateSessionMessageLoad: (id: string) => seen.push(`invalidate:${id}`),
    getSessionStatus: () => "idle", loadMessages: async (id: string) => { seen.push(`messages:${id}`) }, log: { info() {}, error() {} },
  })
  createRoot(dispose => { t.after(dispose); useForegroundRefresh({ onRefresh }) })
  await tick()
  const detach = backendEvents.attach("race", a.events)
  t.after(detach)
  emitStatus(a.events, "disconnected"); emitStatus(a.events, "connected"); await tick()
  assert.deepEqual(seen, ["sessions"])
  detach()
  active = { ...active, id: "race~new" }
  t.after(backendEvents.attach("race", a.events))
  emitStatus(a.events, "connected")
  release(); await tick(); await tick()
  assert.deepEqual(seen, ["sessions"])
  assert.equal(requestSignal.aborted, true)
})

test("a pong 401 cannot leave an unowned auth probe publishing after source disposal", async t => {
  renderer(t)
  let ping!: (event: { data: string }) => void, resolveProbe!: (response: Response) => void
  let probeSignal: AbortSignal | undefined
  const client = createBackendClient({ id: "pong_auth", baseUrl: "https://pong.invalid",
    eventSource: () => ({ close() {}, addEventListener(type: string, handler: typeof ping) { if (type === "codenomad.client.ping") ping = handler } } as unknown as EventSource),
    fetcher: async (input, init) => {
      if (new URL(String(input)).pathname === "/api/auth/status") {
        probeSignal = init!.signal!; return new Promise<Response>(resolve => { resolveProbe = resolve })
      }
      return new Response("{}", { status: 401 })
    },
  })
  t.after(() => client.events.dispose())
  client.events.start(); await tick()
  ping({ data: JSON.stringify({ ts: 1 }) }); await tick()
  assert.ok(resolveProbe)
  client.events.dispose()
  resolveProbe(Response.json({ authenticated: false })); await tick()
  assert.equal(client.auth.required(), false)
  assert.equal(probeSignal!.aborted, true)
})

test("reattachment during an old open callback fences that open and preserves replacement ownership", async t => {
  const a = owner(t), b = owner(t), bus = new BackendEvents(), seen: string[] = []
  const detach = bus.attach("race", a.events)
  const signal = bus.signal("race")!
  bus.onOpen(() => { detach(); t.after(bus.attach("race", b.events)) })
  bus.onOpen(() => seen.push("late-open"))
  bus.onDetach(() => seen.push("detach"))
  a.events.start(); b.events.start(); await tick()
  a.open()
  assert.deepEqual(seen, ["detach"])
  assert.equal(signal.aborted, true)
  assert.notEqual(bus.signal("race"), signal)
  assert.equal(bus.signal("race")!.aborted, false)
})

test("SSE invalidation can revoke its manager before its specialized callback", async t => {
  const a = owner(t), seen: string[] = []
  const detach = backendEvents.attach("nested", a.events)
  const manager = getSseManager("nested")
  t.after(detach)
  const previous = [sseManager.onInvalidation, sseManager.onSessionDeleted] as const
  t.after(() => { [sseManager.onInvalidation, sseManager.onSessionDeleted] = previous })
  sseManager.onInvalidation = () => { seen.push("invalidate"); detach() }
  sseManager.onSessionDeleted = () => { seen.push("deleted") }
  a.events.start(); await tick()
  a.event({ type: "instance.event", instanceId: "ws", event: { id: "e", type: "session.deleted", created: 1,
    durable: { aggregateID: "s", seq: 1, version: 2 }, data: { sessionID: "s" } } })
  assert.deepEqual(seen, ["invalidate"])
  assert.equal(manager.getStatuses().size, 0)
  assert.equal(sseManager.getStatus("nested~ws"), null)
})

test("auth probes coalesce within an owner while another owner's cancellation stays isolated", async () => {
  const probes: { signal: AbortSignal; resolve: (response: Response) => void }[] = []
  const auth = createAuthRecovery("https://auth.invalid", async (_input, init) => new Promise<Response>(resolve => {
    probes.push({ signal: init!.signal!, resolve })
  }))
  const a = new AbortController(), b = new AbortController()
  const first = auth.check(a.signal), same = auth.check(a.signal), second = auth.check(b.signal)
  assert.equal(first, same)
  assert.equal(probes.length, 2)
  a.abort()
  probes[0].resolve(Response.json({ authenticated: false }))
  await first
  assert.equal(auth.required(), false)
  assert.equal(probes[1].signal.aborted, false)
  probes[1].resolve(Response.json({ authenticated: false }))
  await second
  assert.equal(auth.required(), true)
})

test("revoking a native resync stops trailing passes without deleting a replacement's lane", async () => {
  let release!: () => void, calls = 0
  const wait = new Promise<void>(resolve => { release = resolve })
  const coordinator = new TrailingResyncCoordinator(async () => { calls++; if (calls === 1) await wait }, () => assert.fail("obsolete error"))
  const a = new AbortController(), b = new AbortController()
  const first = coordinator.request("ws", a.signal)
  await tick()
  void coordinator.request("ws", a.signal)
  a.abort()
  await coordinator.request("ws", b.signal)
  release(); await first
  assert.equal(calls, 2)
})

function workspace(id: string): Instance {
  return { id, backendId: id.split("~")[0], folder: "/repo", port: 0, pid: 0, proxyPath: "", status: "starting", client: null }
}

test("a detached workspace-list response cannot remove its retained project", async t => {
  const a = owner(t), instance = workspace("list_owner~ws")
  const detach = backendEvents.attach("list_owner", a.events)
  t.after(detach)
  addInstance(instance)
  t.after(() => removeInstance(instance.id, { authoritative: false }))
  let release!: (value: []) => void
  const read = refreshWorkspaceList("list_owner", { fetchWorkspaces: async () => new Promise<[]>(resolve => { release = resolve }) })
  detach()
  release([]); await read
  assert.ok(instances().has(instance.id))
})

test("a detached worktree read neither publishes nor starts its queued follow-up", async t => {
  const a = owner(t), instance = workspace("tree_owner~ws")
  const detach = backendEvents.attach("tree_owner", a.events)
  t.after(detach)
  addInstance(instance)
  t.after(() => removeInstance(instance.id, { authoritative: false }))
  let release!: (value: Awaited<ReturnType<typeof serverApi.fetchWorktrees>>) => void, calls = 0
  t.mock.method(serverApi, "fetchWorktrees", async () => {
    calls++
    return new Promise<Awaited<ReturnType<typeof serverApi.fetchWorktrees>>>(resolve => { release = resolve })
  })
  const read = reloadWorktrees(instance.id)
  await tick()
  const trailing = reloadWorktrees(instance.id)
  detach()
  release({ worktrees: [{ slug: "late", directory: "/late", kind: "worktree" }], isGitRepo: true })
  await Promise.all([read, trailing])
  assert.deepEqual(getWorktrees(instance.id), [])
  assert.equal(calls, 1)
})

test("a detached terminal-session activity read cannot settle or notify the retained session", async t => {
  registerLocalBackendFixture(t, "terminal_owner")
  const a = owner(t), instanceId = "terminal_owner~ws", instance = workspace(instanceId)
  const detach = backendEvents.attach("terminal_owner", a.events)
  t.after(detach)
  let release!: (value: Record<string, unknown>) => void
  const client = { session: { active: async () => new Promise<Record<string, unknown>>(resolve => { release = resolve }) } }
  ;(Reflect.get(sdkManager, "clients") as Map<string, unknown>).set(`${instanceId}:/workspaces/ws/instance`, client)
  addInstance({ ...instance, status: "ready", client: client as unknown as NonNullable<Instance["client"]> })
  const session = { id: "s", instanceId, status: "working", location: { directory: "/repo" }, parentId: null } as Session
  setSessions(current => new Map(current).set(instanceId, new Map([["s", session]])))
  t.after(() => { removeInstance(instanceId, { authoritative: false }); sdkManager.destroyClientsForInstance(instanceId) })
  const read = handleNativeSessionEvent(instanceId, { id: "e", type: "session.execution.succeeded", created: 1,
    durable: { aggregateID: "s", seq: 1, version: 1 }, data: { sessionID: "s" } })
  assert.ok(release)
  detach()
  release({}); await read
  assert.equal(sessions().get(instanceId)?.get("s")?.status, "working")
})

test("reattaching the same source inside a wildcard cannot deliver the old event to its new subscription", async t => {
  const a = owner(t), bus = new BackendEvents(), seen: string[] = []
  let first = true
  const detach = bus.attach("race", a.events)
  bus.on("*", () => {
    seen.push("wildcard")
    if (first) { first = false; detach(); t.after(bus.attach("race", a.events)) }
  })
  bus.on("workspace.worktreesChanged", () => seen.push("typed"))
  a.events.start(); await tick()
  a.event(changed)
  assert.deepEqual(seen, ["wildcard"])
  a.event(changed)
  assert.deepEqual(seen, ["wildcard", "wildcard", "typed"])
})

test("reattachment from abort still delivers cleanup of the old token without revoking its replacement", t => {
  const a = owner(t), b = owner(t), bus = new BackendEvents(), removed: AbortSignal[] = []
  const detach = bus.attach("race", a.events), signal = bus.signal("race")!
  signal.addEventListener("abort", () => { t.after(bus.attach("race", b.events)) }, { once: true })
  bus.onDetach((_id, token) => { removed.push(token) })
  detach()
  assert.deepEqual(removed, [signal])
  assert.equal(bus.signal("race")!.aborted, false)
})

test("a recovery requested synchronously from cancellation starts under its replacement authority", async () => {
  const a = new AbortController(), b = new AbortController()
  let release!: () => void, calls = 0, replacement = Promise.resolve()
  const pending = new Promise<void>(resolve => { release = resolve })
  const coordinator = new TrailingResyncCoordinator(async (_id, signal) => {
    if (++calls !== 1) return
    signal.addEventListener("abort", () => { replacement = coordinator.request("ws", b.signal) }, { once: true })
    await pending
  }, () => assert.fail("obsolete error"))
  const first = coordinator.request("ws", a.signal)
  await tick()
  a.abort()
  await replacement
  release(); await first
  assert.equal(calls, 2)
})

test("worktree coalescence preserves a request from a replaced client", async t => {
  const a = owner(t), instance = workspace("tree_replaced~ws")
  t.after(backendEvents.attach("tree_replaced", a.events))
  addInstance(instance)
  t.after(() => removeInstance(instance.id, { authoritative: false }))
  let release!: (value: Awaited<ReturnType<typeof serverApi.fetchWorktrees>>) => void, calls = 0
  t.mock.method(serverApi, "fetchWorktrees", async () => {
    if (++calls === 1) return new Promise<Awaited<ReturnType<typeof serverApi.fetchWorktrees>>>(resolve => { release = resolve })
    return { worktrees: [{ slug: "current", directory: "/current", kind: "worktree" }], isGitRepo: true }
  })
  const old = reloadWorktrees(instance.id)
  await tick()
  updateInstance(instance.id, { client: {} as NonNullable<Instance["client"]> })
  const current = reloadWorktrees(instance.id)
  release({ worktrees: [], isGitRepo: false })
  await Promise.all([old, current])
  assert.equal(calls, 2)
  assert.equal(getWorktrees(instance.id)[0]?.slug, "current")
})

test("an older auth probe cannot overwrite a newer accepted login observation", async () => {
  const probes: ((value: Response) => void)[] = []
  const auth = createAuthRecovery("https://auth.invalid", async () => new Promise<Response>(resolve => { probes.push(resolve) }))
  const old = auth.check(new AbortController().signal), current = auth.check(new AbortController().signal)
  probes[1](Response.json({ authenticated: true })); await current
  probes[0](Response.json({ authenticated: false })); await old
  assert.equal(auth.required(), false)
})

test("reattachment during status delivery cannot inherit the same transport event's pending open", async t => {
  const a = owner(t), bus = new BackendEvents(), seen: string[] = []
  const detach = bus.attach("race", a.events)
  let first = true
  bus.onTransportStatus(status => {
    if (status === "connected" && first) { first = false; detach(); t.after(bus.attach("race", a.events)) }
  })
  bus.onOpen(() => seen.push("open"))
  a.events.start(); await tick()
  a.open()
  assert.deepEqual(seen, [])
  a.open()
  assert.deepEqual(seen, ["open"])
})

test("a detached native model refresh cannot publish its old selection", async t => {
  registerLocalBackendFixture(t, "model_owner")
  const a = owner(t), instanceId = "model_owner~ws", instance = workspace(instanceId)
  const detach = backendEvents.attach("model_owner", a.events)
  t.after(detach)
  let release!: (value: { model: { providerID: string; id: string } }) => void
  const client = { session: { get: async () => new Promise<{ model: { providerID: string; id: string } }>(resolve => { release = resolve }) } }
  ;(Reflect.get(sdkManager, "clients") as Map<string, unknown>).set(`${instanceId}:/workspaces/ws/instance`, client)
  addInstance({ ...instance, status: "ready", client: client as unknown as NonNullable<Instance["client"]> })
  const model = { providerId: "p", modelId: "current" }
  setSessions(current => new Map(current).set(instanceId, new Map([["s", { id: "s", instanceId, model } as Session]])))
  t.after(() => { removeInstance(instanceId, { authoritative: false }); sdkManager.destroyClientsForInstance(instanceId) })
  const read = reconcileSessionModel(instanceId, "s")
  await tick()
  detach()
  release({ model: { providerID: "p", id: "obsolete" } }); await read
  assert.deepEqual(sessions().get(instanceId)?.get("s")?.model, model)
})

test("a binding acquired before the first source event is revoked with that attachment", async t => {
  const a = owner(t), target = { instanceId: "silent_binding~ws", directory: "/repo", sessionID: "s", integrationId: "i" }
  const detach = backendEvents.attach("silent_binding", a.events)
  t.after(detach)
  let release!: (response: Response) => void, signal!: AbortSignal
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    signal = init!.signal!
    return new Promise<Response>(resolve => { release = resolve })
  })
  t.after(integrationBindings.demand(target))
  await tick()
  assert.ok(release)
  detach()
  assert.equal(signal.aborted, true)
  release(Response.json({ state: "attached", label: "obsolete" })); await tick()
  assert.deepEqual(integrationBindings.state(target), { state: "unknown" })
})

test("reentrant manager replacement adopts the owner installed during old-state disposal", t => {
  const a = owner(t), b = owner(t), id = "reentrant_manager"
  const detach = backendEvents.attach(id, a.events)
  t.after(detach)
  let nested: ReturnType<typeof getSseManager> | undefined, replacement: ReturnType<typeof getSseManager> | undefined
  backendEvents.signal(id)!.addEventListener("abort", () => {
    t.after(backendEvents.attach(id, b.events))
    replacement = getSseManager(id)
  }, { once: true })
  const old = getSseManager(id)
  old.seedStatus(`${id}~ws`, "connected")
  createRoot(dispose => {
    t.after(dispose)
    createComputed(() => {
      if (old.getStatuses().size) return
      nested = getSseManager(id)
      nested.seedStatus(`${id}~ws`, "connected")
    })
  })
  detach()
  assert.ok(nested)
  assert.equal(replacement, nested)
  assert.equal(getSseManager(id), nested)
  assert.equal(sseManager.getStatuses().get(`${id}~ws`), "connected")
})
