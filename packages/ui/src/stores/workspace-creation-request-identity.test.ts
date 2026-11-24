import assert from "node:assert/strict"
import { it } from "node:test"
import { createBackendClient, registerBackendClient } from "../lib/backend-client"
import { backendEvents } from "../lib/backend-events"
import { preferences } from "./preferences"
import { createInstance, instances, removeInstance, refreshWorkspaceList, releaseRestoreCreatedInstance } from "./instances"

for (const mode of ["SSE", "list"] as const) it(`${mode}: exact request collision across backend and attachment A1/B/A2 preserves current owner`, async t => {
  const prior = preferences().multiBackend
  preferences().multiBackend = true
  t.mock.method(globalThis.crypto, "randomUUID", () => "11111111-1111-4111-8111-111111111111")
  let finish!: () => void, enter!: () => void, cancel!: () => void, first = true, requestId = ""
  const waiting = new Promise<void>(r => { finish = r }), entered = new Promise<void>(r => { enter = r }), canceled = new Promise<void>(r => { cancel = r })
  const releases: string[] = [], registrations: Array<() => void> = [], attachments: Array<() => void> = []
  const clients: ReturnType<typeof createBackendClient>[] = []
  const make = (label: string, backendId = "aba-order") => {
    const client = createBackendClient({ id: backendId, baseUrl: `https://${label}.invalid`, relayProfileId: backendId, bindRelayAuthority: true,
      fetcher: async (input, init) => {
        const path = new URL(String(input)).pathname
        if (init?.method !== "POST") return Response.json([])
        if (path.endsWith("/creation/cancel")) { cancel(); return new Response(null, { status: 204 }) }
        if (path.endsWith("/creation/release")) { releases.push(label); return new Response(null, { status: 204 }) }
        const body = JSON.parse(String(init.body)); requestId = body.requestId
        if (label === "a" && first) { first = false; enter(); await waiting }
        return Response.json({ id: "w", requestId: body.requestId, path: body.path, binaryLabel: label, status: "starting", proxyPath: "", createdAt: "", updatedAt: "" })
      } })
    client.admitRelayAuthority!("i".repeat(43)); clients.push(client); return client
  }
  const attach = (client: ReturnType<typeof createBackendClient>) => {
    const off = registerBackendClient(client), detach = backendEvents.attach(client.id, client.events)
    registrations.push(off); attachments.push(detach); return () => { detach(); off() }
  }
  t.after(() => {
    finish(); attachments.forEach(fn => fn()); registrations.forEach(fn => fn()); clients.forEach(client => client.events.dispose())
    preferences().multiBackend = prior; removeInstance("aba-order~w", { authoritative: false }); removeInstance("other-order~w", { authoritative: false })
  })
  const a = make("a"), b = make("b"), other = make("other", "other-order"), detachA = attach(a), controller = new AbortController()
  const rejected = assert.rejects(createInstance("/same", undefined, { backend: a, signal: controller.signal }))
  await entered; controller.abort(); await canceled; await new Promise<void>(r => setImmediate(r)); detachA()
  const collidedRequestId = requestId
  const detachB = attach(b)
  const current = await createInstance("/same", undefined, { backend: b, signal: new AbortController().signal })
  assert.equal(current.requestId, collidedRequestId)
  await releaseRestoreCreatedInstance(current.instanceId, current.requestId!)
  const descriptor = { id: "w", requestId, path: "/same", binaryLabel: "b-refreshed", binaryId: "test", status: "starting" as const, proxyPath: "", createdAt: "", updatedAt: "" }
  if (mode === "SSE") (b.events as any).dispatch({ type: "workspace.created", workspace: descriptor })
  else await refreshWorkspaceList(b.id, { fetchWorkspaces: async () => [descriptor] })
  finish(); await rejected
  assert.equal(instances().get(current.instanceId)?.binaryLabel, "b-refreshed")
  assert.deepEqual(releases, ["b"])
  detachB(); attach(a)
  const a2 = await createInstance("/same", undefined, { backend: a, signal: new AbortController().signal })
  assert.equal(a2.requestId, collidedRequestId)
  assert.equal(instances().get(a2.instanceId)?.binaryLabel, "a")
  await releaseRestoreCreatedInstance(a2.instanceId, a2.requestId!)
  attach(other)
  const unrelated = await createInstance("/same", undefined, { backend: other, signal: new AbortController().signal })
  assert.equal(unrelated.requestId, collidedRequestId)
  assert.equal(instances().get(unrelated.instanceId)?.binaryLabel, "other")
  await releaseRestoreCreatedInstance(unrelated.instanceId, unrelated.requestId!)
  assert.deepEqual(releases, ["b", "a", "other"])
})
