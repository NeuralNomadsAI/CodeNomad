import assert from "node:assert/strict"
import { it } from "node:test"
import { createBackendClient, registerBackendClient } from "../lib/backend-client"
import { backendEvents } from "../lib/backend-events"
import { preferences } from "./preferences"
import { createInstance, instances, removeInstance, refreshWorkspaceList, releaseRestoreCreatedInstance } from "./instances"
import { AbortCreatedWorkspaceCleanup } from "./abort-created-workspace-cleanup"

it("the stopped dispatcher settles a release in flight before its late HTTP rejection", async t => {
  const prior = preferences().multiBackend
  preferences().multiBackend = true
  let receipts: Map<string, any> | undefined, finish!: () => void, enter!: () => void
  const waiting = new Promise<void>(resolve => { finish = resolve })
  const entered = new Promise<void>(resolve => { enter = resolve })
  const original = Map.prototype.set
  t.mock.method(Map.prototype, "set", function(this: Map<any, any>, key: any, value: any) {
    if (value?.requestKey && value?.backendId === "stop-in-flight" && value?.api) receipts = this
    return original.call(this, key, value)
  })
  let releases = 0
  const client = createBackendClient({ id: "stop-in-flight", baseUrl: "https://stop.invalid", relayProfileId: "stop-in-flight", bindRelayAuthority: true,
    fetcher: async (input, init) => {
      if (new URL(String(input)).pathname.endsWith("/creation/release")) {
        releases++; enter(); await waiting; throw new TypeError("lost release ACK")
      }
      return Response.json({ id: "w", requestId: JSON.parse(String(init?.body)).requestId, path: "/same", status: "starting", proxyPath: "", createdAt: "", updatedAt: "" })
    } })
  client.admitRelayAuthority!("s".repeat(43))
  const unregister = registerBackendClient(client), detach = backendEvents.attach(client.id, client.events)
  t.after(() => { finish(); detach(); unregister(); client.events.dispose(); preferences().multiBackend = prior; removeInstance("stop-in-flight~w", { authoritative: false }) })
  const created = await createInstance("/same", undefined, { backend: client, signal: new AbortController().signal })
  const rejected = assert.rejects(releaseRestoreCreatedInstance(created.instanceId, created.requestId!))
  await entered
  ;(client.events as any).dispatch({ type: "workspace.stopped", workspaceId: "w", reason: "deleted" })
  ;(client.events as any).dispatch({ type: "workspace.stopped", workspaceId: "w", reason: "deleted" })
  finish(); await rejected
  assert.equal(releases, 4)
  assert.equal([...receipts!.values()].filter(value => value.backendId === client.id).length, 0)
  assert.equal(instances().has(created.instanceId), false)
})

for (const mode of ["SSE", "list"] as const) it(`cancel ACK before any descriptor fences late ${mode}, including after POST finally`, async t => {
  const prior = preferences().multiBackend
  preferences().multiBackend = true
  let requestId = "", finish!: () => void, enter!: () => void, cancel!: () => void
  const waiting = new Promise<void>(resolve => { finish = resolve })
  const entered = new Promise<void>(resolve => { enter = resolve })
  const canceled = new Promise<void>(resolve => { cancel = resolve })
  let postCount = 0
  const client = createBackendClient({ id: `late-${mode}`, baseUrl: "https://late.invalid", relayProfileId: `late-${mode}`, bindRelayAuthority: true,
    fetcher: async (input, init) => {
      if (new URL(String(input)).pathname.endsWith("/creation/cancel")) { cancel(); return new Response(null, { status: 204 }) }
      const body = JSON.parse(String(init?.body))
      if (++postCount === 1) { requestId = body.requestId; enter(); await waiting }
      return Response.json({ id: "w", requestId: body.requestId, path: body.path, status: "starting", proxyPath: "", createdAt: "", updatedAt: "" })
    } })
  client.admitRelayAuthority!("l".repeat(43))
  const unregister = registerBackendClient(client), detach = backendEvents.attach(client.id, client.events)
  const id = `${client.id}~w`
  t.after(() => { finish(); detach(); unregister(); client.events.dispose(); preferences().multiBackend = prior; removeInstance(id, { authoritative: false }) })
  const controller = new AbortController()
  const rejected = assert.rejects(createInstance("/same", undefined, { backend: client, signal: controller.signal }))
  await entered; controller.abort(); await canceled
  await new Promise<void>(resolve => setImmediate(resolve))
  const descriptor = { id: "w", requestId, path: "/same", status: "starting" as const, proxyPath: "", createdAt: "", updatedAt: "", binaryId: "test", binaryLabel: "test" }
  const observe = async () => {
    if (mode === "SSE") (client.events as any).dispatch({ type: "workspace.created", workspace: descriptor })
    else await refreshWorkspaceList(client.id, { fetchWorkspaces: async () => [descriptor] })
  }
  await observe()
  const published = instances().has(id)
  finish(); await rejected
  await observe()
  assert.equal(instances().has(id), false, "late POST/catch/finally and duplicate observation stay inert")
  assert.equal(published, false, "the first observation must never publish the canceled creation")
  await createInstance("/user", undefined, { backend: client })
  await observe()
  assert.equal(instances().get(id)?.folder, "/user", "old canceled observations cannot replace the explicit user occurrence")
  const reused = { ...descriptor, requestId: undefined, reused: true, path: "/user" }
  if (mode === "SSE") (client.events as any).dispatch({ type: "workspace.created", workspace: reused })
  else await refreshWorkspaceList(client.id, { fetchWorkspaces: async () => [reused] })
  assert.equal(instances().has(id), true, "the reused user workspace stays visible")
})

it("primitive observation fences distinguish backend, request and attachment ABA without retaining owners", () => {
  let attachment = "A1"
  const key = (backend: string, request: string, owner = attachment) => JSON.stringify([backend, request, owner])
  const cleanup = new AbortCreatedWorkspaceCleanup<{ id: string; requestId: string }>({
    requestKey: value => value.requestId,
    isCurrentKey: (id, request) => request === key(id.split("~")[0], JSON.parse(request)[1]),
    discardWorkspace: async () => {}, restoreWorkspace: () => {},
  })
  const original = key("a", "r")
  cleanup.beginRequest(original)
  cleanup.settleRequest(original)
  cleanup.settleRequest(original)
  assert.equal(cleanup.shouldIgnoreObservation("a~w", original), true)
  assert.equal(cleanup.shouldIgnoreObservation("b~w", key("b", "r")), false)
  assert.equal(cleanup.shouldIgnoreObservation("a~other", key("a", "next")), false)
  assert.equal(cleanup.shouldIgnoreObservation("a~reused", original, true), false)
  cleanup.releaseTombstoneForUserCreate("a~before-first-descriptor")
  assert.equal(cleanup.shouldIgnoreObservation("a~before-first-descriptor", original), true)
  assert.equal(cleanup.owns("a~before-first-descriptor"), false, "an old observation cannot tombstone a later user opening")
  const later = key("a", "later")
  cleanup.settleRequest(later)
  assert.equal(cleanup.shouldIgnoreObservation("a~before-first-descriptor", later), true)
  assert.equal(cleanup.owns("a~before-first-descriptor"), true, "a new cancellation still fences the next occurrence")
  attachment = "B"
  assert.equal(cleanup.shouldIgnoreObservation("a~w", key("a", "r")), false)
  assert.equal(cleanup.shouldIgnoreObservation("a~w", original), false)
  attachment = "A2"
  assert.equal(cleanup.shouldIgnoreObservation("a~w", key("a", "r")), false)
  assert.equal(cleanup.shouldIgnoreEvent("a~w"), false)
  assert.equal((cleanup as any).owned.size, 0)
  assert.equal((cleanup as any).retired.size, 0)
})
