import assert from "node:assert/strict"
import { it } from "node:test"
import { createBackendClient, registerBackendClient } from "../lib/backend-client"
import { backendEvents } from "../lib/backend-events"
import { preferences } from "./preferences"
import { createInstance, closeWorkspace, instances, removeInstance, releaseRestoreCreatedInstance } from "./instances"
import { serverApi } from "../lib/api-client"

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

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
  let callbacks = 0
  const create = createInstance("/same", undefined, { backend: client, signal: new AbortController().signal,
    waitForCreateCommit: () => commit.promise,
    onBeforeCreateCommit: () => { callbacks++ }, onCreateCommit: () => { callbacks++ } })
  const rejected = assert.rejects(create)
  await entered.promise
  if (phase === "commit") await new Promise<void>(resolve => setImmediate(resolve))
  detach(); remove()
  post.resolve(); commit.resolve()
  await rejected
  assert.equal(callbacks, 0)
  assert.equal(instances().has("pending~w"), false)
  assert(calls.some(call => call.path.endsWith("/creation/cancel")))
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
