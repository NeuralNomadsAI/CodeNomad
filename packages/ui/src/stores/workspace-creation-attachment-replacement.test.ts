import assert from "node:assert/strict"
import { it } from "node:test"
import { createBackendClient, registerBackendClient } from "../lib/backend-client"
import { backendEvents } from "../lib/backend-events"
import { preferences } from "./preferences"
import { createInstance, instances, removeInstance, releaseRestoreCreatedInstance } from "./instances"
import { AbortCreatedWorkspaceCleanup } from "./abort-created-workspace-cleanup"

it("an old stopped terminal must not release the replacement creation claim", async t => {
  const prior = preferences().multiBackend
  preferences().multiBackend = true
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const releases: string[] = []
  const make = (label: string) => createBackendClient({ id: "terminal-review", baseUrl: `https://${label}.invalid`,
    relayProfileId: "terminal-review", bindRelayAuthority: true,
    fetcher: async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith("/creation/release")) releases.push(label)
      const body = JSON.parse(String(init?.body ?? "{}"))
      return Response.json(path.endsWith("/api/workspaces") ? { id: "w", requestId: body.requestId, path: "/same", status: "starting", proxyPath: "", createdAt: "", updatedAt: "" } : {})
    } })
  const old = make("old"), next = make("next")
  old.admitRelayAuthority!("a".repeat(43)); next.admitRelayAuthority!("b".repeat(43))
  const removeOld = registerBackendClient(old), detachOld = backendEvents.attach(old.id, old.events)
  let removeNext = () => {}, detachNext = () => {}
  t.after(() => { finish(); detachOld(); removeOld(); detachNext(); removeNext(); old.events.dispose(); next.events.dispose();
    preferences().multiBackend = prior; removeInstance("terminal-review~w", { authoritative: false }) })
  const opening = createInstance("/same", undefined, { backend: old, signal: new AbortController().signal, waitForCreateCommit: () => gate })
  const rejected = assert.rejects(opening)
  await new Promise<void>(resolve => setImmediate(resolve))
  ;(old.events as any).dispatch({ type: "workspace.created", workspace: { id: "w", path: "/same", status: "starting", proxyPath: "", createdAt: "", updatedAt: "" } })
  ;(old.events as any).dispatch({ type: "workspace.stopped", workspaceId: "w", reason: "deleted" })
  detachOld(); removeOld()
  removeNext = registerBackendClient(next); detachNext = backendEvents.attach(next.id, next.events)
  const replacement = await createInstance("/same", undefined, { backend: next, signal: new AbortController().signal })
  assert.equal(instances().has(replacement.instanceId), true)
  finish(); await rejected
  await releaseRestoreCreatedInstance(replacement.instanceId, replacement.requestId!)
  assert.deepEqual(releases, ["next"], "replacement claim must be released over its actual API")
})

it("confirmed released claims do not accumulate retired clients across user create cycles", async () => {
  const cleanup = new AbortCreatedWorkspaceCleanup<{id: string; requestId: string}>({
    requestKey: item => item.requestId, isCurrent: () => true,
    discardWorkspace: async () => {}, restoreWorkspace: () => {}, retryDelaysMs: [],
  })
  for (let i = 0; i < 101; i++) {
    cleanup.track({ id: "same", requestId: `r${i}` })
    await cleanup.releaseAfter("same", async () => {})
    cleanup.releaseTombstoneForUserCreate("same")
  }
  assert.equal((cleanup as any).retired.size, 0, "all 101 releases were acknowledged; no unknown claim needs retention")
  assert.equal((cleanup as any).owned.size, 0)
})

for (const outcome of ["release", "cancel", "reused"] as const) it(`${outcome}: known cycles keep primitive fences only, including distinct UI ids`, async () => {
  const settled: string[] = []
  const cleanup = new AbortCreatedWorkspaceCleanup<{ id: string; requestId: string; reused: boolean; client: object }>({
    requestKey: value => value.requestId, isCurrent: () => true,
    discardWorkspace: async () => {}, restoreWorkspace: () => {}, retryDelaysMs: [],
    onSettled: value => { settled.push(value.requestId) },
  })
  for (let i = 0; i < 101; i++) {
    const value = { id: `w${i}`, requestId: `r${i}`, reused: outcome === "reused", client: {} }
    cleanup.track(value)
    if (outcome === "release") await cleanup.releaseAfter(value.id, async () => {}, value.requestId)
    else await cleanup.discardCreated(value, { retainTombstone: !value.reused })
    cleanup.track({ ...value, client: {} })
    await cleanup.discardCreated(value)
    assert.equal(cleanup.shouldIgnoreEvent(value.id), outcome === "cancel")
    assert.equal(cleanup.owns(value.id), outcome === "cancel", "late list observations keep the occurrence fence")
    for (const marker of (cleanup as any).markers.values()) assert(Object.values(marker).every(value => typeof value === "string" || typeof value === "boolean"))
    cleanup.releaseTombstoneForUserCreate(value.id)
    assert.equal(cleanup.owns(value.id), false)
    await cleanup.discardCreated(value)
  }
  assert.equal(settled.length, 101, "duplicate responses never repeat settlement")
  assert.equal((cleanup as any).owned.size, 0)
  assert.equal((cleanup as any).retired.size, 0)
  assert.equal((cleanup as any).markers.size, 0)
  assert([...((cleanup as any).settledRequests as Set<unknown>)].every(value => typeof value === "string"))
})

it("keeps all genuinely unknown retired claims and never settles a replacement on a late request event", async () => {
  let owner = 0, calls = 0
  type Item = { id: string; requestId: string; owner: number; client: object }
  const cleanup = new AbortCreatedWorkspaceCleanup<Item>({
    requestKey: value => `${value.owner}/${value.requestId}`, isCurrent: value => value.owner === owner,
    discardWorkspace: async () => { calls++; throw new Error("revoked") }, restoreWorkspace: () => {}, retryDelaysMs: [],
  })
  for (; owner < 101; owner++) {
    const value = { id: "same", requestId: "same", owner, client: {} }
    cleanup.track(value)
    await cleanup.discardCreated(value)
  }
  const next = { id: "same", requestId: "same", owner, client: {} }
  cleanup.track(next)
  assert.equal((cleanup as any).retired.size, 101)
  assert.equal(cleanup.get("same"), next)
  cleanup.beginRequest("0/same")
  cleanup.quarantineRequest("0/same")
  assert.equal(cleanup.trackPendingRequest({ ...next, owner: 0 }), true)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(cleanup.get("same"), next)
  assert.equal(calls, 102)
  assert.equal((cleanup as any).retired.size, 101)
})

it("a compact cancelled fence follows its exact attachment, not the replacement with the same id and request", async () => {
  let owner = "old"
  const canceled: string[] = [], released: string[] = []
  const cleanup = new AbortCreatedWorkspaceCleanup<{ id: string; requestId: string; owner: string }>({
    requestKey: value => `${value.owner}/${value.requestId}`, isCurrent: value => value.owner === owner,
    isCurrentKey: (_id, key) => key === `${owner}/r`,
    discardWorkspace: async value => { canceled.push(value.owner) }, restoreWorkspace: () => {}, retryDelaysMs: [],
  })
  const old = { id: "w", requestId: "r", owner }, next = { ...old, owner: "next" }
  cleanup.track(old)
  await cleanup.discardCreated(old, { retainTombstone: true })
  assert.equal(cleanup.owns(old.id), true)
  owner = "next"
  assert.equal(cleanup.owns(old.id), false)
  assert.equal(cleanup.shouldIgnoreEvent(old.id), false)
  cleanup.track(next)
  await cleanup.discardCreated(old, { retainTombstone: true })
  await cleanup.releaseAfter(next.id, async value => { released.push(value.owner) }, "next/r")
  assert.deepEqual(canceled, ["old"])
  assert.deepEqual(released, ["next"])
  assert.equal((cleanup as any).owned.size, 0)
  assert.equal((cleanup as any).retired.size, 0)
})

it("confirmed cancellation compacts a pending descriptor and its late completion stays inert", async () => {
  let finish!: () => void, restored = 0
  const cleanup = new AbortCreatedWorkspaceCleanup<{ id: string; requestId: string; client: object }>({
    requestKey: value => value.requestId,
    discardWorkspace: () => new Promise<void>(resolve => { finish = resolve }),
    restoreWorkspace: () => { restored++ }, retryDelaysMs: [],
  })
  const item = { id: "w", requestId: "r", client: {} }
  cleanup.track(item)
  const pending = cleanup.discardCreated(item, { retainTombstone: true })
  cleanup.settleRequest("r")
  await pending
  assert.equal((cleanup as any).owned.size, 0)
  assert.equal(cleanup.shouldIgnoreEvent("w"), true)
  finish()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(restored, 0)
  assert.equal((cleanup as any).owned.size, 0)
})

it("a known stop settles the exact in-flight owner even when its release later rejects", async () => {
  let reject!: (error: Error) => void, owner = "old"
  const cleanup = new AbortCreatedWorkspaceCleanup<{ id: string; requestId: string; owner: string }>({
    requestKey: value => `${value.owner}/${value.requestId}`, isCurrent: value => value.owner === owner,
    discardWorkspace: async () => {}, restoreWorkspace: () => {}, retryDelaysMs: [],
  })
  const old = { id: "same", requestId: "same", owner }, next = { ...old, owner: "next" }
  cleanup.track(old)
  const failed = assert.rejects(cleanup.releaseAfter(old.id, () => new Promise<void>((_resolve, no) => { reject = no }), "old/same"))
  owner = "next"; cleanup.track(next)
  assert.equal(cleanup.release(next.id), undefined, "an absent exact terminal owner never selects the current slot")
  assert.equal(cleanup.release(next.id, "missing/same"), undefined)
  cleanup.release(old.id, "old/same")
  reject(new Error("old late failure")); await failed
  assert.equal(cleanup.get(next.id), next)
  assert.equal((cleanup as any).retired.size, 0)
  assert.equal(cleanup.isReleased(old.id, "old/same"), true)
  assert.equal(cleanup.isReleased(next.id, "next/same"), false)
})

it("store receipts end after definitive refusal and confirmed cancel, but survive unknown POST outcomes", async t => {
  const prior = preferences().multiBackend
  preferences().multiBackend = true
  let receiptMap: Map<string, any> | undefined
  const originalSet = Map.prototype.set
  t.mock.method(Map.prototype, "set", function(this: Map<any, any>, key: any, value: any) {
    if (value?.requestKey && value?.backendId === "retention" && value?.api) receiptMap = this
    return originalSet.call(this, key, value)
  })
  let mode: "release" | "refused" | "network" | "server" | "timeout" | "abandoned" | "cancel" | "reused" = "release"
  let refuseCancel = false, cancelCalls = 0
  let finishPost!: () => void, enter!: () => void, canceled!: () => void
  let entered = Promise.resolve(), cancelAck = Promise.resolve()
  const client = createBackendClient({ id: "retention", baseUrl: "https://retention.invalid", relayProfileId: "retention", bindRelayAuthority: true,
    fetcher: async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith("/creation/cancel")) {
        if (!refuseCancel || ++cancelCalls === 4) canceled()
        return refuseCancel ? new Response("unknown", { status: 503 }) : new Response(null, { status: 204 })
      }
      if (path.endsWith("/creation/release")) return new Response(null, { status: 204 })
      const body = JSON.parse(String(init?.body))
      if (mode === "refused") return new Response("refused", { status: 400 })
      if (mode === "network") throw new TypeError("lost ACK")
      if (mode === "server") return new Response("unknown", { status: 503 })
      if (mode === "timeout") return new Response("unknown", { status: 408 })
      if (mode === "abandoned") return new Response("unknown", { status: 499 })
      if (mode === "cancel") { enter(); await new Promise<void>(resolve => { finishPost = resolve }) }
      return Response.json({ id: "w", requestId: mode === "reused" ? undefined : body.requestId,
        reused: mode === "reused", path: "/same", status: "starting", proxyPath: "", createdAt: "", updatedAt: "" })
    } })
  client.admitRelayAuthority!("r".repeat(43))
  const remove = registerBackendClient(client), detach = backendEvents.attach(client.id, client.events)
  t.after(() => { preferences().multiBackend = prior; detach(); remove(); client.events.dispose(); removeInstance("retention~w", { authoritative: false }) })
  const count = () => [...receiptMap!.values()].filter(value => value.backendId === client.id).length
  for (let i = 0; i < 101; i++) {
    const result = await createInstance("/same", undefined, { backend: client, signal: new AbortController().signal })
    await releaseRestoreCreatedInstance(result.instanceId, result.requestId!)
    assert.equal(count(), 0)
    mode = "refused"
    await assert.rejects(createInstance("/same", undefined, { backend: client, signal: new AbortController().signal }))
    assert.equal(count(), 0)
    mode = "reused"
    const reused = await createInstance("/same", undefined, { backend: client, signal: new AbortController().signal })
    assert.equal(reused.reused, true)
    assert.equal(reused.requestId, undefined)
    assert.equal(count(), 0)
    mode = "release"
  }
  mode = "cancel"
  entered = new Promise<void>(resolve => { enter = resolve })
  cancelAck = new Promise<void>(resolve => { canceled = resolve })
  const controller = new AbortController()
  const opening = assert.rejects(createInstance("/same", undefined, { backend: client, signal: controller.signal }))
  await entered; controller.abort(); await cancelAck
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(count(), 0)
  finishPost(); await opening
  assert.equal(count(), 0)
  for (const unknown of ["network", "server", "timeout", "abandoned"] as const) {
    mode = unknown
    const before = count()
    await assert.rejects(createInstance("/same", undefined, { backend: client, signal: new AbortController().signal }))
    assert.equal(count(), before + 1)
  }
  mode = "cancel"; refuseCancel = true
  entered = new Promise<void>(resolve => { enter = resolve })
  cancelAck = new Promise<void>(resolve => { canceled = resolve })
  const aborted = new AbortController(), beforeAbort = count()
  const uncertain = assert.rejects(createInstance("/same", undefined, { backend: client, signal: aborted.signal }))
  await entered; aborted.abort(); await cancelAck
  finishPost(); await uncertain
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(count(), beforeAbort + 1, "a network abort with unconfirmed cancel retains the original owner")
})
