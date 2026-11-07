import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { createComputed, createRoot } from "solid-js"
import type { WorkspaceDescriptor, WorkspaceEventPayload } from "../../../server/src/api-types"
import { BackendEvents, scopeBackendEvent } from "./backend-events"
import { backends, createBackendClient, localBackend } from "./backend-client"
import { backendEvents, serverEvents } from "./server-events"
import { getSseManager, sseManager } from "./sse-manager"
import { integrations, integrationBindings, integrationEpoch } from "../stores/integrations"
import { pluginControlsCache } from "../stores/plugin-controls"
import "../stores/plugin-controls-events"
import { createSessionGoalStore } from "../stores/session-goal-store"
import { createMissionContentStore } from "../stores/mission-content-store"

class FakeEventSource {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  addEventListener() {}
  close() { this.closed = true }
  emit(event: WorkspaceEventPayload) { this.onmessage?.({ data: JSON.stringify(event) }) }
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
async function settle(condition: () => boolean) {
  for (let i = 0; i < 100 && !condition(); i++) await tick()
  assert.ok(condition())
}

function renderer(t: TestContext) {
  const before = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://ui.invalid" } } })
  t.after(() => {
    if (before) Object.defineProperty(globalThis, "window", before)
    else Reflect.deleteProperty(globalThis, "window")
  })
}

function backend(t: TestContext, id: string, read?: (input: RequestInfo | URL) => Response) {
  const sources: FakeEventSource[] = [], requests: string[] = []
  let authenticated = true, unauthorized = false
  const client = createBackendClient({ id, baseUrl: `https://${id}.invalid`,
    fetcher: async input => {
      const path = new URL(String(input)).pathname
      requests.push(path)
      return path === "/api/auth/status" ? Response.json({ authenticated })
        : unauthorized ? new Response("{}", { status: 401 }) : read?.(input) ?? Response.json({})
    },
    eventSource: () => {
      const source = new FakeEventSource()
      sources.push(source)
      return source as unknown as EventSource
    },
  })
  t.after(() => client.events.dispose())
  return { client, sources, requests, authenticate: (value: boolean) => { authenticated = value },
    rejectRequests: () => { unauthorized = true } }
}

test("all CodeNomad envelope identities are scoped, with native identities and local objects intact", () => {
  const workspace = { id: "ws", path: "/same", proxyPath: "/workspaces/ws/instance" } as WorkspaceDescriptor
  const native = { id: "event", type: "server.connected" as const, location: { directory: "/same", workspaceID: "native" }, data: { daemon: "opaque" } }
  const events: WorkspaceEventPayload[] = [
    ...(["workspace.created", "workspace.started", "workspace.error"] as const).map(type => ({ type, workspace })),
    { type: "workspace.log", entry: { workspaceId: "ws", level: "info", timestamp: "now", message: "log" } },
    { type: "workspace.stopped", workspaceId: "ws", reason: "deleted" },
    { type: "workspace.worktreesChanged", workspaceId: "ws" },
    { type: "workspace.filesChanged", workspaceId: "ws", changes: [{ directory: "/same", path: "." }] },
    { type: "instance.event", instanceId: "ws", event: native },
    { type: "instance.eventStatus", instanceId: "ws", status: "connected", generation: 7 },
    { type: "instance.dataChanged", instanceId: "ws", data: { messageHistory: [], agentModelSelections: {} } },
    { type: "yolo.stateChanged", instanceId: "ws", sessionId: "session", enabled: true },
    { type: "yolo.autoAccepted", instanceId: "ws", sessionId: "session", permissionId: "permission" },
    { type: "permission.receiptsChanged", instanceId: "ws", sessionId: "session", messageId: "message" },
    { type: "storage.stateChanged", owner: "ui", value: { untouched: "ws" } },
    { type: "storage.configChanged", owner: "ui", value: {} },
    { type: "workspace.temporaryChanged", folders: ["/same"] },
    { type: "sidecar.removed", sidecarId: "ws" },
  ]
  for (const event of events) {
    assert.equal(scopeBackendEvent("local", event), event)
    const before = JSON.stringify(event), scoped = scopeBackendEvent("b", event)
    assert.equal(scoped.backendId, "b")
    if ("instanceId" in scoped) assert.equal(scoped.instanceId, "b~ws")
    if ("workspaceId" in scoped) assert.equal(scoped.workspaceId, "b~ws")
    if ("workspace" in scoped) {
      assert.deepEqual(scoped.workspace, { ...workspace, id: "b~ws" })
      assert.notEqual(scoped.workspace, workspace)
    }
    if ("entry" in scoped) assert.equal(scoped.entry.workspaceId, "b~ws")
    if ("event" in scoped) assert.equal(scoped.event, native)
    if ("generation" in scoped) assert.equal(scoped.generation, 7)
    if ("sessionId" in scoped) assert.equal(scoped.sessionId, "session")
    if ("sidecarId" in scoped) assert.equal(scoped.sidecarId, "ws")
    assert.equal(JSON.stringify(event), before)
  }
})

test("two real streams fan in in order; subscriptions, status, generations, 401 and reconnect stay backend-owned", async t => {
  renderer(t)
  t.after(() => serverEvents.dispose())
  const a = backend(t, "a"), b = backend(t, "b")
  const bus = new BackendEvents()
  for (const owner of [a, b]) {
    t.after(bus.attach(owner.client.id, owner.client.events))
    t.after(backendEvents.attach(owner.client.id, owner.client.events))
    owner.client.events.start()
  }
  await settle(() => a.sources.length === 1 && b.sources.length === 1)
  const observedKeys: string[][] = []
  createRoot(dispose => {
    t.after(dispose)
    createComputed(() => { observedKeys.push([...sseManager.getStatuses().keys()]) })
  })
  const seen: string[] = [], aOnly: string[] = [], opens: string[] = [], statuses: string[] = []
  t.after(bus.on("*", event => { seen.push(`*:${event.backendId}:${event.type}`) }))
  t.after(bus.on("instance.eventStatus", event => { seen.push(`typed:${"instanceId" in event && event.instanceId}`) }))
  t.after(bus.forInstance(() => "a~ws").on("*", event => { aOnly.push(event.type) }))
  t.after(bus.forInstance(() => "a~ws").onOpen(id => { opens.push(id) }))
  t.after(bus.onTransportStatus((status, id) => { statuses.push(`${id}:${status}`) }))
  // Throwing subscribers cannot discard another callback or the source's lifecycle.
  t.after(bus.onOpen(() => { throw new Error("expected subscriber failure") }))
  a.sources[0].onopen!()
  b.sources[0].onopen!()
  assert.deepEqual(opens, ["a"])
  assert.deepEqual(statuses, ["a:connected", "b:connected"])
  const status = { type: "instance.eventStatus", instanceId: "ws", status: "connected", generation: 1 } as const
  b.sources[0].emit(status)
  a.sources[0].emit(status)
  b.sources[0].emit({ type: "workspace.worktreesChanged", workspaceId: "ws" })
  assert.deepEqual(seen, ["*:b:instance.eventStatus", "typed:b~ws", "*:a:instance.eventStatus", "typed:a~ws", "*:b:workspace.worktreesChanged"])
  assert.deepEqual(aOnly, ["instance.eventStatus"])
  assert.notEqual(getSseManager("a"), getSseManager("b"))
  assert.equal(sseManager.getStatus("a~ws"), "connected")
  assert.equal(sseManager.getStatus("b~ws"), "connected")
  assert.equal(sseManager.getStatuses().get("b~ws"), "connected")
  assert.ok(observedKeys.some(keys => keys.includes("b~ws")), "existing observers discover new backend managers")
  const previousHandler = sseManager.onNativeSessionEvent, nativeOwners: string[] = []
  sseManager.onNativeSessionEvent = (id, event) => { nativeOwners.push(`${id}:${event.type}`) }
  t.after(() => { sseManager.onNativeSessionEvent = previousHandler })
  b.sources[0].emit({ type: "instance.event", instanceId: "ws", event: { id: "event", type: "server.connected", data: {} } })
  assert.deepEqual(nativeOwners, ["b~ws:server.connected"])

  // A 401 and login probe on B leave A's source and login untouched.
  b.authenticate(false)
  b.rejectRequests()
  await assert.rejects(b.client.api.fetchServerMeta())
  await settle(() => b.client.auth.required())
  assert.deepEqual(b.requests, ["/api/meta", "/api/auth/status"])
  assert.deepEqual(a.requests, [])
  assert.equal(a.client.auth.required(), false)
  assert.equal(a.sources[0].closed, false)

  // A disconnect immediately fences B's old callbacks and only changes B's display.
  b.sources[0].onerror!()
  assert.equal(b.sources[0].closed, true)
  assert.equal(sseManager.getStatus("b~ws"), "connecting")
  assert.equal(sseManager.getStatus("a~ws"), "connected")
  const count = seen.length
  b.sources[0].emit(status)
  b.sources[0].onopen!()
  assert.equal(seen.length, count)
  assert.deepEqual(opens, ["a"])
  // Authentication restoration takes the ordinary reconnect path, cancelling its retry timer.
  await b.client.auth.check()
  b.authenticate(true)
  await b.client.auth.check()
  await settle(() => b.sources.length === 2)
  assert.equal(a.sources.length, 1)
  b.sources[1].onopen!()
  assert.equal(sseManager.getStatus("b~ws"), "connected")

  // Reconnecting A never relaunches B, nor publishes superseded generation callbacks.
  a.client.events.restart()
  await settle(() => a.sources.length === 2)
  assert.equal(b.sources.length, 2)
  assert.equal(b.sources[1].closed, false)
  a.sources[0].onopen!()
  assert.deepEqual(opens, ["a"])
  a.sources[1].onopen!()
  assert.deepEqual(opens, ["a", "a"])
  assert.equal(sseManager.getStatus("a~ws"), "connected")
})

test("the local stream keeps aliases, event identity, callback order and reconnect delivery neutral", async t => {
  renderer(t)
  assert.equal(serverEvents, localBackend.events)
  assert.deepEqual([...backends.keys()], ["local"])
  const local = backend(t, "local"), bus = new BackendEvents()
  t.after(bus.attach("local", local.client.events))
  const delivered: WorkspaceEventPayload[] = [], order: string[] = [], opens: string[] = []
  t.after(local.client.events.on("*", event => { delivered.push(event) }))
  t.after(bus.on("*", event => { delivered.push(event); order.push("*") }))
  t.after(bus.on("workspace.worktreesChanged", () => { order.push("typed") }))
  t.after(bus.forInstance(() => "ws").onOpen(id => { opens.push(id) }))
  local.client.events.start()
  await settle(() => local.sources.length === 1)
  local.sources[0].onopen!()
  local.sources[0].emit({ type: "workspace.worktreesChanged", workspaceId: "ws" })
  assert.equal(delivered[0], delivered[1])
  assert.deepEqual(delivered[0], { type: "workspace.worktreesChanged", workspaceId: "ws" })
  assert.deepEqual(order, ["*", "typed"])
  local.client.events.restart()
  await settle(() => local.sources.length === 2)
  local.sources[1].onopen!()
  assert.deepEqual(opens, ["local", "local"])
})

test("retry backoff, detach and current-view filtering stay source-owned", async t => {
  renderer(t)
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const a = backend(t, "retry_a"), b = backend(t, "retry_b"), bus = new BackendEvents()
  const detach = bus.attach("retry_a", a.client.events)
  t.after(detach)
  t.after(bus.attach("retry_b", b.client.events))
  assert.throws(() => bus.attach("bad~id", a.client.events), TypeError)
  assert.throws(() => bus.attach("retry_a", a.client.events), /already attached/)
  let target = "retry_a~ws"
  const statuses: string[] = [], opened: string[] = []
  t.after(bus.forInstance(() => target).onTransportStatus((status, id) => { statuses.push(`${id}:${status}`) }))
  t.after(bus.forInstance(() => target).onOpen(id => { opened.push(id) }))
  a.client.events.start(); b.client.events.start()
  await settle(() => a.sources.length === 1 && b.sources.length === 1)
  a.sources[0].onopen!(); b.sources[0].onopen!()
  assert.deepEqual(opened, ["retry_a"])
  a.sources[0].onerror!()
  assert.deepEqual(statuses, ["retry_a:connected", "retry_a:disconnected", "retry_a:disconnected"])
  t.mock.timers.tick(999)
  assert.equal(a.sources.length, 1)
  t.mock.timers.tick(1)
  await settle(() => a.sources.length === 2)
  assert.equal(b.sources.length, 1)
  assert.equal(b.sources[0].closed, false)
  assert.deepEqual(a.requests, ["/api/auth/status"])
  assert.deepEqual(b.requests, [])
  target = "retry_b~ws"
  a.sources[1].onopen!(); b.sources[0].onopen!()
  assert.deepEqual(opened, ["retry_a", "retry_b"])
  detach(); detach()
  target = "retry_a~ws"
  a.sources[1].onopen!()
  assert.deepEqual(opened, ["retry_a", "retry_b"])
})

test("production reconnect subscribers revoke and reread only their backend's demanded snapshots", async t => {
  renderer(t)
  const ids = ["offers_a~ws", "offers_b~ws"], location = { directory: "/same" }
  const targets = ids.map(instanceId => ({ instanceId, directory: "/same", sessionID: "session", integrationId: "fixture" }))
  const reads: string[] = []
  const read = (id: string) => (input: RequestInfo | URL) => {
    const url = String(input)
    reads.push(`${id}:${url}`)
    return Response.json(url.includes("/binding?") ? { state: "attached", label: "Scene" }
      : { location, catalog: { state: "fresh" }, integrations: [], ambiguousSources: [] })
  }
  const a = backend(t, "offers_a", read(ids[0])), b = backend(t, "offers_b", read(ids[1]))
  for (const owner of [a, b]) {
    const registry = backends as Map<string, typeof owner.client>
    registry.set(owner.client.id, owner.client)
    t.after(() => registry.delete(owner.client.id))
    t.mock.method(owner.client.api, "getPluginControls", async (id: string, location: { directory: string }) => {
      reads.push(`plugin:${owner.client.id}~${id}`)
      return { location, runtime: [], configured: { rules: [], sources: [] }, targets: [], controls: [] }
    })
    t.after(backendEvents.attach(owner.client.id, owner.client.events))
    owner.client.events.start()
  }
  await settle(() => a.sources.length === 1 && b.sources.length === 1)
  a.sources[0].onopen!(); b.sources[0].onopen!()
  for (let i = 0; i < ids.length; i++) {
    t.after(integrations.demand(ids[i], "/same"))
    t.after(integrationBindings.demand(targets[i]))
    t.after(pluginControlsCache.acquireDemand(ids[i], location))
    t.after(() => { integrations.clearInstance(ids[i]); pluginControlsCache.clearInstance(ids[i]) })
  }
  await settle(() => targets.every(target => integrationBindings.state(target).state === "attached")
    && ids.every(id => !pluginControlsCache.state(id, location).loading && integrations.state(id, "/same").status === "ready"))
  const aEpoch = integrationEpoch(ids[0]), aState = integrations.state(ids[0], "/same"), aPlugin = pluginControlsCache.state(ids[0], location)
  reads.length = 0
  b.sources[0].onerror!()
  assert.equal(integrationBindings.state(targets[0]).state, "attached")
  assert.equal(integrationBindings.state(targets[1]).state, "unknown")
  assert.equal(integrationEpoch(ids[0]), aEpoch)
  assert.equal(integrations.state(ids[0], "/same"), aState)
  // Restart B immediately, then restore it; no pending retry outlives this test.
  b.client.events.restart()
  await settle(() => b.sources.length === 2)
  b.sources[1].onopen!()
  await settle(() => integrationBindings.state(targets[1]).state === "attached" && reads.length === 3)
  assert.ok(reads.every(read => read.includes(ids[1])), reads.join("\n"))
  assert.equal(integrationEpoch(ids[0]), aEpoch)
  assert.equal(integrations.state(ids[0], "/same"), aState)
  assert.equal(pluginControlsCache.state(ids[0], location), aPlugin)
})

test("backend refresh scopes include retained goal demands and Mission bodies", async t => {
  const reads: string[] = []
  const goals = createSessionGoalStore(async id => { reads.push(`goal:${id}`); return { status: "goal", goal: null } })
  const bodies = createMissionContentStore(async ref => {
    reads.push(`body:${ref.instanceId}`)
    return { available: true, version: 1, projectID: ref.projectID, missionID: ref.missionID, refused: "content-not-found" }
  })
  for (const instanceId of ["goals_a~ws", "goals_b~ws", "local-ws"]) {
    t.after(goals.demand(instanceId, "session"))
    const body = bodies.use({ instanceId, projectID: "project", missionID: "mission", selector: { kind: "mission", field: "objective" } }, "connection")
    body.need(Infinity)
    t.after(body.release)
  }
  await settle(() => reads.length === 6)
  await tick()
  reads.length = 0
  await goals.refreshDemanded(undefined, "goals_b")
  bodies.invalidate(undefined, "goals_b")
  await settle(() => reads.length === 2)
  assert.deepEqual(reads, ["goal:goals_b~ws", "body:goals_b~ws"])
})
