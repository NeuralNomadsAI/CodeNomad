import assert from "node:assert/strict"
import { it } from "node:test"
import { createBackendClient, registerBackendClient } from "../lib/backend-client"
import { backendEvents } from "../lib/backend-events"
import { preferences } from "./preferences"
import { createInstance, instances, removeInstance, refreshWorkspaceList } from "./instances"
import { AbortCreatedWorkspaceCleanup } from "./abort-created-workspace-cleanup"

for (const mode of ["SSE", "list"] as const) for (const response of ["before", "after"]) it(`${mode}: cancellation admitted after user opening wins with user response ${response} ACK`, async t => {
  const prior = preferences().multiBackend
  preferences().multiBackend = true
  let requestId = "", finishPost!: () => void, enterPost!: () => void
  let finishCancel!: () => void, enterCancel!: () => void, finishUser!: () => void, enterUser!: () => void
  const post = new Promise<void>(r => { finishPost = r }), posted = new Promise<void>(r => { enterPost = r })
  const cancel = new Promise<void>(r => { finishCancel = r }), canceling = new Promise<void>(r => { enterCancel = r })
  const user = new Promise<void>(r => { finishUser = r }), userEntered = new Promise<void>(r => { enterUser = r })
  const backendId = `admitted-${mode}-${response}`, calls: string[] = []
  const client = createBackendClient({ id: backendId, baseUrl: "https://admission.invalid", relayProfileId: backendId, bindRelayAuthority: true,
    fetcher: async (input, init) => {
      const path = new URL(String(input)).pathname
      if (init?.method !== "POST" && init?.method !== "DELETE") return Response.json([])
      calls.push(`${init.method} ${path}`)
      if (path.endsWith("/creation/cancel")) { enterCancel(); await cancel; return new Response(null, { status: 204 }) }
      const body = JSON.parse(String(init.body))
      if (body.requestId) { requestId = body.requestId; enterPost(); await post }
      else { enterUser(); await user }
      return Response.json({ id: "w", requestId: body.requestId, path: "/same", binaryLabel: "user", status: "starting", proxyPath: "", createdAt: "", updatedAt: "" })
    } })
  client.admitRelayAuthority!("a".repeat(43))
  const unregister = registerBackendClient(client), detach = backendEvents.attach(client.id, client.events), id = `${backendId}~w`
  t.after(() => { finishPost(); finishCancel(); finishUser(); detach(); unregister(); client.events.dispose(); preferences().multiBackend = prior; removeInstance(id, { authoritative: false }) })
  const controller = new AbortController()
  const rejected = assert.rejects(createInstance("/same", undefined, { backend: client, signal: controller.signal }))
  await posted
  const opened = createInstance("/same", undefined, { backend: client }); await userEntered
  controller.abort(); await canceling
  if (response === "before") { finishUser(); await opened }
  finishCancel(); await new Promise<void>(r => setImmediate(r))
  if (response === "after") { finishUser(); await opened }
  const old = { id: "w", requestId, path: "/same", binaryId: "test", binaryLabel: "stale", status: "starting" as const, proxyPath: "", createdAt: "", updatedAt: "" }
  const observe = async (descriptor: typeof old | Omit<typeof old, "requestId">) => {
    if (mode === "SSE") (client.events as any).dispatch({ type: "workspace.created", workspace: descriptor })
    else await refreshWorkspaceList(backendId, { fetchWorkspaces: async () => [descriptor] })
  }
  await observe(old); finishPost(); await rejected; await observe(old)
  await observe({ ...old, requestId: undefined as any, binaryLabel: "blocked" })
  assert.equal(instances().get(id)?.binaryLabel, "user", "a later cancellation must retain precedence")
  ;(client.events as any).dispatch({ type: "workspace.stopped", workspaceId: "w", reason: "deleted" })
  await new Promise<void>(r => setImmediate(r))
  assert.equal(instances().has(id), true, "the cancellation tombstone remains active")
  await createInstance("/same", undefined, { backend: client })
  await observe(old)
  await observe({ ...old, requestId: undefined as any, binaryLabel: "latest-user" })
  assert.equal(instances().get(id)?.binaryLabel, "latest-user", "a subsequent user opening still clears the fence")
  const route = `/api/backends/${backendId}/api/workspaces`
  assert.deepEqual(calls, [`POST ${route}`, `POST ${route}`, `POST ${route}/creation/cancel`, `POST ${route}`])
})

for (const failure of ["network", 503, 408, 499, 400] as const) it(`unconfirmed cancellation ${failure} retains its exact unknown owner without a confirmed observation fence`, async () => {
  const client = createBackendClient({ id: "unknown-order", baseUrl: "https://unknown.invalid", fetcher: async () => {
    if (failure === "network") throw new TypeError("lost ACK")
    return new Response("unconfirmed", { status: failure })
  } })
  const value = { id: "w", requestId: "r", client, api: client.api, attachment: new AbortController().signal }
  const cleanup = new AbortCreatedWorkspaceCleanup<typeof value>({ requestKey: w => w.requestId,
    discardWorkspace: w => w.api.cancelWorkspaceCreation(w.requestId), restoreWorkspace: () => {}, retryDelaysMs: [] })
  try {
    cleanup.beginRequest("r"); cleanup.track(value)
    await cleanup.quarantineRequest("r")
    assert.equal(cleanup.isRequestSettled("r"), false)
    assert.equal(cleanup.shouldIgnoreObservation("w", "r"), false)
    assert.equal(cleanup.shouldIgnoreEvent("w"), false)
    assert.equal(cleanup.get("w"), value)
    assert.equal((cleanup as any).markers.size, 0)
  } finally { client.events.dispose() }
})

it("duplicate and older cancellation acknowledgements cannot replace a newer cancellation order", () => {
  const cleanup = new AbortCreatedWorkspaceCleanup<{ id: string; requestId: string }>({ requestKey: w => w.requestId,
    discardWorkspace: async () => {}, restoreWorkspace: () => {} })
  const opening = cleanup.captureOperationOrder()
  cleanup.beginCancellation("old")
  cleanup.beginCancellation("new")
  cleanup.settleRequest("new"); cleanup.shouldIgnoreObservation("w", "new")
  cleanup.releaseTombstoneForUserCreate("w", opening)
  cleanup.settleRequest("old"); cleanup.settleRequest("old"); cleanup.shouldIgnoreObservation("w", "old")
  assert.equal((cleanup as any).markers.get("w").requestKey, "new")
  assert.equal(cleanup.shouldIgnoreEvent("w"), true)
  const latest = cleanup.captureOperationOrder()
  cleanup.releaseTombstoneForUserCreate("w", latest)
  cleanup.settleRequest("old"); cleanup.settleRequest("new")
  cleanup.shouldIgnoreObservation("w", "old"); cleanup.shouldIgnoreObservation("w", "new")
  assert.equal(cleanup.shouldIgnoreEvent("w"), false)
})

it("descriptor cleanup captures cancellation before dispatch and its late confirmation preserves a later user opening", async () => {
  let finish!: () => void
  const cleanup = new AbortCreatedWorkspaceCleanup<{ id: string; requestId: string }>({ requestKey: w => w.requestId,
    discardWorkspace: () => new Promise<void>(r => { finish = r }), restoreWorkspace: () => {}, retryDelaysMs: [] })
  const pending = cleanup.discardCreated({ id: "w", requestId: "r" }, { retainTombstone: true })
  cleanup.releaseTombstoneForUserCreate("w")
  finish(); await pending
  assert.equal(cleanup.shouldIgnoreObservation("w", "r"), true)
  assert.equal(cleanup.shouldIgnoreEvent("w"), false)
  assert.equal((cleanup as any).owned.size, 0)
})
