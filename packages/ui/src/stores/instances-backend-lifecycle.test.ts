import assert from "node:assert/strict"
import { it } from "node:test"
import { createBackendClient, registerBackendClient } from "../lib/backend-client"
import { backendEvents } from "../lib/backend-events"
import { preferences } from "./preferences"
import { addInstance, createInstance, closeWorkspace, instances, removeInstance, releaseRestoreCreatedInstance, type WorkspaceCreationOwnership } from "./instances"
import { selectInstanceTab, activeAppTabId } from "./app-tabs"
import { serverApi } from "../lib/api-client"

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

for (const recovery of ["discard", "event"] as const) for (const mode of recovery === "discard"
  ? ["lost-response", "resolved", "retired", "removed"] as const
  : ["lost-response", "resolved", "retired"] as const) it(`${mode}: exhausted cancellation resumes through ${recovery}`, async t => {
  const previous = preferences().multiBackend
  preferences().multiBackend = true
  const id = `recover-${mode}-${recovery}`
  let receipts!: Map<string, any>, original!: WorkspaceCreationOwnership, replacement!: WorkspaceCreationOwnership
  let offline = true, attempts = 0, acknowledgements = 0, sequence = 0, requestId = ""
  const set = Map.prototype.set
  t.mock.method(Map.prototype, "set", function(this: Map<any, any>, key: any, value: any) {
    if (value?.backendId === id && value.api && value.requestKey) receipts = this
    return set.call(this, key, value)
  })
  const resumed = deferred<void>(), finish = deferred<void>()
  const client = createBackendClient({ id, baseUrl: "https://recovery.invalid", relayProfileId: id, bindRelayAuthority: true,
    fetcher: async (input, init) => {
      const path = new URL(String(input)).pathname, body = JSON.parse(String(init?.body ?? "{}"))
      if (path.endsWith("/creation/cancel")) {
        assert.equal(body.requestId, requestId, "cancel retains the original request")
        attempts++
        if (offline) return Response.json({}, { status: 503 })
        resumed.resolve(); await finish.promise
        acknowledgements++
        return Response.json({})
      }
      if (path.endsWith("/creation/release")) return Response.json({})
      if (!path.endsWith("/api/workspaces") || init?.method !== "POST") return Response.json([])
      sequence++; requestId ||= body.requestId
      if (mode === "lost-response") throw new TypeError("lost create ACK")
      return Response.json({ id: "w", requestId: body.requestId, path: "/same", binaryLabel: `occurrence-${sequence}`,
        status: "starting", proxyPath: "", createdAt: "", updatedAt: "" })
    } })
  client.admitRelayAuthority!("a".repeat(43))
  const remove = registerBackendClient(client), detach = backendEvents.attach(id, client.events)
  t.after(() => { finish.resolve(); detach(); remove(); client.events.dispose(); preferences().multiBackend = previous; removeInstance(`${id}~w`, { authoritative: false }) })
  const retained = () => [...receipts.values()].filter(value => value.backendId === id).length
  const opening = createInstance("/same", undefined, { backend: client, signal: new AbortController().signal, onCreation: owner => { original = owner } })
  if (mode === "lost-response") await assert.rejects(opening)
  else await opening
  await Promise.all([original.discard(), original.discard()])
  assert.equal(attempts, 4, "one shared flight exhausts four real attempts")
  assert.equal(acknowledgements, 0)
  assert.equal(retained(), 1, "unknown settlement retains its receipt")
  if (mode === "retired") {
    await createInstance("/same", undefined, { backend: client, signal: new AbortController().signal, onCreation: owner => { replacement = owner } })
    assert.equal(replacement.current(`${id}~w`), true)
  }
  if (mode === "removed") { detach(); remove() }
  offline = false
  const observe = () => (client.events as any).dispatch({ type: "workspace.created", workspace: {
    id: "w", requestId, path: "/same", binaryLabel: "old-event", status: "starting", proxyPath: "", createdAt: "", updatedAt: "",
  } })
  // A later demand starts real IO; repeated demands during it share that IO.
  if (recovery === "event") {
    observe(); observe()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(attempts, 5, "observation alone resumes the retained cancellation")
  }
  const pending = Promise.all([original.discard(), original.discard()])
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(attempts, 5, "recovery admits one new cancellation, coalesced with observations")
  await resumed.promise
  finish.resolve(); await pending
  if (mode === "retired") {
    assert.equal(instances().get(`${id}~w`)?.binaryLabel, "occurrence-2")
    assert.equal(replacement.current(`${id}~w`), true)
    await replacement.release()
  } else if (mode !== "removed") assert.equal(instances().has(`${id}~w`), false)
  assert.equal(acknowledgements, 1)
  assert.equal(retained(), 0)
  await original.discard()
  assert.equal(attempts, 5, "confirmed settlement stays inert")
})

it("creation ownership without a scope is refused before dispatch", async t => {
  let calls = 0
  t.mock.method(serverApi, "createWorkspace", async () => { calls++; throw new Error("unexpected dispatch") })
  await assert.rejects(createInstance("/same", undefined, { onCreation: () => {} }), /cancellation signal/)
  assert.equal(calls, 0)
})

for (const scenario of ["resolved", "replacement", "reused", "lost-response", "rejected", "missing-echo", "foreign-echo"] as const) it(`captured creation ownership settles ${scenario} exactly once`, async t => {
  const previous = preferences().multiBackend
  preferences().multiBackend = true
  const calls: Array<{ path: string; body: any }> = []
  let sequence = 0
  const client = createBackendClient({ id: "lease", baseUrl: "https://lease.invalid", relayProfileId: "lease", bindRelayAuthority: true,
    fetcher: async (input, init) => {
      const path = new URL(String(input)).pathname, body = JSON.parse(String(init?.body ?? "{}"))
      calls.push({ path, body })
      if (path.endsWith("/api/workspaces")) {
        if (scenario === "lost-response") throw new TypeError("lost create response")
        if (scenario === "rejected") return Response.json({ error: "invalid" }, { status: 400 })
        return Response.json({ id: "w", requestId: scenario === "missing-echo" ? undefined : scenario === "foreign-echo" ? "foreign" : body.requestId, reused: scenario === "reused",
          path: body.path, status: "starting", binaryLabel: `occurrence-${++sequence}`, proxyPath: "", createdAt: "", updatedAt: "" })
      }
      return Response.json({})
    } })
  client.admitRelayAuthority!("l".repeat(43))
  const remove = registerBackendClient(client), detach = backendEvents.attach(client.id, client.events)
  t.after(() => { preferences().multiBackend = previous; detach(); remove(); client.events.dispose(); removeInstance("lease~w", { authoritative: false }) })
  let original!: WorkspaceCreationOwnership, replacement!: WorkspaceCreationOwnership
  const opening = createInstance("/same", undefined, { backend: client, signal: new AbortController().signal, onCreation: owner => { original = owner } })
  if (scenario === "lost-response" || scenario === "rejected" || scenario === "missing-echo" || scenario === "foreign-echo") {
    await assert.rejects(opening)
    await Promise.all([original.discard(), original.discard()])
    assert.equal(instances().has("lease~w"), false)
    const cancellations = calls.filter(c => c.path.endsWith("/creation/cancel"))
    assert.equal(cancellations.length, scenario === "rejected" ? 0 : 1)
    if (cancellations.length) assert.equal(cancellations[0].body.requestId, calls[0].body.requestId)
    return
  }
  const result = await opening
  addInstance({ ...instances().get(result.instanceId)!, id: "lease~other", folder: "/other" })
  assert.equal(selectInstanceTab("lease~other", original), false, "ownership is bound to its exact occurrence")
  removeInstance("lease~other", { authoritative: false })
  if (scenario === "replacement") {
    await createInstance("/same", undefined, { backend: client, signal: new AbortController().signal, onCreation: owner => { replacement = owner } })
    assert.equal(original.current(result.instanceId), false)
    assert.equal(selectInstanceTab(result.instanceId, original), false)
  }
  await Promise.all([original.discard(), original.discard()])
  assert.equal(calls.filter(c => c.path.endsWith("/creation/cancel")).length, 1)
  assert.equal(calls.find(c => c.path.endsWith("/creation/cancel"))!.body.requestId, result.requestId)
  assert.equal(instances().has(result.instanceId), scenario !== "resolved")
  if (scenario === "replacement") {
    assert.equal(instances().get(result.instanceId)?.binaryLabel, "occurrence-2")
    assert.equal(replacement.current(result.instanceId), true)
    assert.equal(selectInstanceTab(result.instanceId, replacement), true)
    assert.equal(activeAppTabId(), "instance:lease~w")
    await new Promise<void>(resolve => setImmediate(resolve))
    await replacement.discard()
    assert.equal(instances().has(result.instanceId), true, "transferred tab survives later cleanup")
    assert.equal(calls.filter(c => c.path.endsWith("/creation/cancel")).length, 1)
    assert.equal(calls.filter(c => c.path.endsWith("/creation/release")).length, 1)
  }
})

for (const phase of ["cancel", "release"] as const) it(`a pending captured ${phase} cannot settle or restore a replacement occurrence`, async t => {
  const previous = preferences().multiBackend
  preferences().multiBackend = true
  const entered = deferred<void>(), finish = deferred<void>()
  const calls: Array<{ path: string; requestId?: string }> = []
  let firstRequest: string | undefined, fail = true, sequence = 0
  const client = createBackendClient({ id: "retired", baseUrl: "https://retired.invalid", relayProfileId: "retired", bindRelayAuthority: true,
    fetcher: async (input, init) => {
      const path = new URL(String(input)).pathname, body = JSON.parse(String(init?.body ?? "{}"))
      calls.push({ path, requestId: body.requestId })
      if (path.endsWith("/api/workspaces")) {
        firstRequest ??= body.requestId
        return Response.json({ id: "w", requestId: body.requestId, path: body.path, status: "starting",
          binaryLabel: `occurrence-${++sequence}`, proxyPath: "", createdAt: "", updatedAt: "" })
      }
      if (body.requestId === firstRequest && path.endsWith(phase === "cancel" ? "/creation/cancel" : "/creation/release")) {
        entered.resolve(); await finish.promise
        if (fail) throw new Error("old proof unavailable")
      }
      return Response.json({})
    } })
  client.admitRelayAuthority!("r".repeat(43))
  const remove = registerBackendClient(client), detach = backendEvents.attach(client.id, client.events)
  t.after(async () => {
    fail = false; finish.resolve()
    if (firstRequest) await releaseRestoreCreatedInstance("retired~w", firstRequest)
    preferences().multiBackend = previous; detach(); remove(); client.events.dispose(); removeInstance("retired~w", { authoritative: false })
  })
  let old!: WorkspaceCreationOwnership, next!: WorkspaceCreationOwnership
  const original = await createInstance("/same", undefined, { backend: client, signal: new AbortController().signal, onCreation: owner => { old = owner } })
  const pending = phase === "cancel" ? old.discard() : old.release().catch(() => undefined)
  await entered.promise
  const replacement = await createInstance("/same", undefined, { backend: client, signal: new AbortController().signal, onCreation: owner => { next = owner } })
  finish.resolve(); await pending
  assert.equal(instances().get("retired~w")?.binaryLabel, "occurrence-2")
  assert.equal(next.current(replacement.instanceId), true)
  assert.equal(calls.filter(c => c.requestId === replacement.requestId && !c.path.endsWith("/api/workspaces")).length, 0)
  assert(calls.filter(c => c.path.includes("/creation/")).every(c => c.requestId === original.requestId))
  fail = false
  await next.discard()
})

for (const phase of ["POST", "commit"] as const) it(`revokes publication during ${phase} while claim settlement retains its exact API`, async t => {
  const previous = preferences().multiBackend
  preferences().multiBackend = true
  const post = deferred<void>(), commit = deferred<void>(), entered = deferred<void>()
  const calls: Array<{ method: string; path: string; body: any }> = []
  const client = createBackendClient({ id: "pending", baseUrl: "https://pending.invalid", relayProfileId: "pending", bindRelayAuthority: true,
    fetcher: async (input, init) => {
      const path = new URL(String(input)).pathname, body = JSON.parse(String(init?.body ?? "{}"))
      calls.push({ method: init?.method ?? "GET", path, body })
      if (path.endsWith("/api/workspaces")) {
        entered.resolve()
        if (phase === "POST") await post.promise
        return Response.json({ id: "w", requestId: body.requestId, path: "/same", status: "starting", proxyPath: "/workspaces/w/instance", createdAt: "", updatedAt: "" })
      }
      return Response.json({})
    } })
  client.admitRelayAuthority!("p".repeat(43))
  const remove = registerBackendClient(client), detach = backendEvents.attach(client.id, client.events)
  t.after(() => { preferences().multiBackend = previous; detach(); remove(); client.events.dispose(); removeInstance("pending~w", { authoritative: false }) })
  let callbacks = 0, owner!: WorkspaceCreationOwnership
  const create = createInstance("/same", undefined, { backend: client, signal: new AbortController().signal,
    onCreation: value => { owner = value },
    waitForCreateCommit: () => commit.promise,
    onBeforeCreateCommit: () => { callbacks++ }, onCreateCommit: () => { callbacks++ } })
  const rejected = assert.rejects(create)
  await entered.promise
  if (phase === "commit") await new Promise<void>(resolve => setImmediate(resolve))
  detach(); remove()
  const cleanup = owner.discard()
  post.resolve(); commit.resolve()
  await rejected; await cleanup; await owner.discard()
  assert.equal(callbacks, 0)
  assert.equal(instances().has("pending~w"), false)
  assert.equal(calls.filter(call => call.path.endsWith("/creation/cancel")).length, 1, "abort, continuation and caller share one cancellation")
  assert(calls.filter(call => call.path.endsWith("/creation/cancel")).every(call => call.body.requestId === calls[0].body.requestId))
  assert.equal(calls.some(call => call.method === "DELETE"), false)
})

it("keeps flag-off admission remote-free and the default owner strictly local", async t => {
  const previous = preferences().multiBackend
  preferences().multiBackend = false
  t.after(() => { preferences().multiBackend = previous })
  const client = createBackendClient({ id: "off", baseUrl: "https://off.invalid", fetcher: async () => { throw new Error("unexpected remote IO") } })
  const remove = registerBackendClient(client), detach = backendEvents.attach(client.id, client.events)
  t.after(() => { detach(); remove(); client.events.dispose(); removeInstance("local-default", { authoritative: false }) })
  await assert.rejects(createInstance("/same", undefined, { backend: client }), /Backend unavailable/)
  const bodies: unknown[] = []
  t.mock.method(serverApi, "createWorkspace", async (body: Parameters<typeof serverApi.createWorkspace>[0]) => {
    bodies.push(body)
    return { id: "local-default", path: body.path, status: "starting", proxyPath: "", createdAt: "", updatedAt: "" }
  })
  assert.equal((await createInstance("C:\\physical\\repo", "Named")).instanceId, "local-default")
  assert.deepEqual(bodies, [{ path: "C:\\physical\\repo", name: "Named", requestId: undefined }])
  assert.equal(instances().get("local-default")?.backendId, undefined)
})

it("flag-off local restore waits for commit, releases once and coalesces close without qualifying ids", async t => {
  const previous = preferences().multiBackend
  preferences().multiBackend = false
  t.after(() => { preferences().multiBackend = previous; removeInstance("local-restored", { authoritative: false }) })
  const commit = deferred<void>(), posted = deferred<void>(), deleted = deferred<void>()
  const releases: Array<[string, string]> = [], closes: string[] = [], callbacks: string[] = []
  t.mock.method(serverApi, "createWorkspace", async (body: Parameters<typeof serverApi.createWorkspace>[0]) => {
    assert.equal(body.path, "C:\\physical\\restore")
    assert.ok(body.requestId)
    posted.resolve()
    return { id: "local-restored", requestId: body.requestId, path: body.path, status: "starting" as const,
      proxyPath: "/workspaces/local-restored/instance", createdAt: "", updatedAt: "" }
  })
  t.mock.method(serverApi, "releaseWorkspaceCreation", async (id: string, requestId: string) => { releases.push([id, requestId]) })
  t.mock.method(serverApi, "deleteWorkspace", async (id: string) => { closes.push(id); await deleted.promise })
  t.after(() => { commit.resolve(); deleted.resolve() })
  const restoring = createInstance("C:\\physical\\restore", "Restored", {
    signal: new AbortController().signal, waitForCreateCommit: () => commit.promise,
    onBeforeCreateCommit: id => callbacks.push(`before:${id}`),
    onCreateCommit: id => callbacks.push(`after:${id}`),
  })
  await posted.promise
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(instances().has("local-restored"), false)
  assert.deepEqual(callbacks, [])
  commit.resolve()
  const restored = await restoring
  assert.equal(restored.instanceId, "local-restored")
  assert.equal(instances().get(restored.instanceId)?.backendId, undefined)
  assert.deepEqual(callbacks, ["before:local-restored", "after:local-restored"])
  await releaseRestoreCreatedInstance(restored.instanceId, restored.requestId!)
  await releaseRestoreCreatedInstance(restored.instanceId, restored.requestId!)
  assert.deepEqual(releases, [["local-restored", restored.requestId]])
  const first = closeWorkspace(restored.instanceId), second = closeWorkspace(restored.instanceId)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(closes, ["local-restored"])
  deleted.resolve()
  await Promise.all([first, second])
})

it("captures create/close/release owner, converges qualified identities and fences a queued close", async t => {
  const previous = preferences().multiBackend
  preferences().multiBackend = true
  t.after(() => { preferences().multiBackend = previous })
  const requests: Array<[string, string, string]> = []
  const make = (id: string) => createBackendClient({ id, baseUrl: `https://${id}.invalid`,
    relayProfileId: id, bindRelayAuthority: true,
    fetcher: async (input, init) => {
      const url = new URL(String(input)), method = init?.method ?? "GET"
      requests.push([id, method, url.pathname])
      if (method === "POST" && url.pathname.endsWith("/api/workspaces")) {
        const body = JSON.parse(String(init?.body))
        return Response.json({ id: "w", path: body.path, requestId: body.requestId, status: "starting", proxyPath: "/workspaces/w/instance", createdAt: "", updatedAt: "" })
      }
      return Response.json({})
    } })
  const a = make("A"), b = make("B")
  a.admitRelayAuthority!("a".repeat(43)); b.admitRelayAuthority!("b".repeat(43))
  const removeA = registerBackendClient(a), removeB = registerBackendClient(b)
  const detachA = backendEvents.attach("A", a.events), detachB = backendEvents.attach("B", b.events)
  t.after(() => { detachA(); detachB(); removeA(); removeB(); a.events.dispose(); b.events.dispose();
    for (const id of ["A~w", "B~w"]) removeInstance(id, { authoritative: false }) })
  const ar = await createInstance("/same", undefined, { backend: a })
  const br = await createInstance("/same", undefined, { backend: b, signal: new AbortController().signal })
  assert.equal(ar.instanceId, "A~w"); assert.equal(br.instanceId, "B~w")
  assert.equal(instances().get("B~w")?.backendId, "B")
  await releaseRestoreCreatedInstance(br.instanceId, br.requestId!)
  await releaseRestoreCreatedInstance(br.instanceId, br.requestId!)
  assert.equal(requests.filter(([id, , route]) => id === "B" && route.endsWith("/w/creation/release")).length, 1)
  const close = closeWorkspace(br.instanceId)
  await Promise.all([close, closeWorkspace(br.instanceId)])
  assert.deepEqual(requests.filter(([, method]) => method === "DELETE"), [["B", "DELETE", "/api/backends/B/api/workspaces/w"]])
  const queued = closeWorkspace(ar.instanceId)
  detachA()
  await assert.rejects(queued)
  assert.equal(requests.filter(([id, method]) => id === "A" && method === "DELETE").length, 0)
})

it("a release retry after reattachment keeps the original API and duplicate release stays inert", async t => {
  const previous = preferences().multiBackend
  preferences().multiBackend = true
  let releaseCalls = 0, replacementCalls = 0
  let replace = () => {}
  const old = createBackendClient({ id: "release", baseUrl: "https://old.invalid", relayProfileId: "release", bindRelayAuthority: true,
    fetcher: async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith("/creation/release")) {
        releaseCalls++
        if (releaseCalls === 1) { replace(); return Response.json({}, { status: 503 }) }
        return Response.json({})
      }
      const body = JSON.parse(String(init?.body))
      return Response.json({ id: "w", requestId: body.requestId, path: body.path, status: "starting", proxyPath: "", createdAt: "", updatedAt: "" })
    } })
  const replacement = createBackendClient({ id: "release", baseUrl: "https://new.invalid", relayProfileId: "release", bindRelayAuthority: true,
    fetcher: async () => { replacementCalls++; throw new Error("replacement must not settle an old claim") } })
  old.admitRelayAuthority!("o".repeat(43)); replacement.admitRelayAuthority!("n".repeat(43))
  const removeOld = registerBackendClient(old), detachOld = backendEvents.attach(old.id, old.events)
  let removeNew = () => {}, detachNew = () => {}
  replace = () => { detachOld(); removeOld(); removeNew = registerBackendClient(replacement); detachNew = backendEvents.attach(replacement.id, replacement.events) }
  t.after(() => { preferences().multiBackend = previous; detachOld(); removeOld(); detachNew(); removeNew(); old.events.dispose(); replacement.events.dispose(); removeInstance("release~w", { authoritative: false }) })
  const created = await createInstance("/same", undefined, { backend: old, signal: new AbortController().signal })
  await releaseRestoreCreatedInstance(created.instanceId, created.requestId!)
  await releaseRestoreCreatedInstance(created.instanceId, created.requestId!)
  assert.equal(releaseCalls, 2)
  assert.equal(replacementCalls, 0)
})
