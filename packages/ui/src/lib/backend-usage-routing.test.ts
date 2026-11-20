import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { backendOf, backends, createBackendClient, localBackend, type BackendClient } from "./backend-client"
import { parseInstanceKey } from "./backend-identity"

type Api = BackendClient["api"]
type Wire = { url: string; method: string; body: unknown; signal: AbortSignal | null | undefined; credentials?: RequestCredentials; headers: [string, string][] }
const registry = backends as Map<string, BackendClient>
const workspace = "w/1", directory = "/repo with space/é", integration = "provider/a"
function wire(input: RequestInfo | URL, init?: RequestInit): Wire {
  return { url: String(input), method: init?.method ?? "GET", body: init?.body, signal: init?.signal,
    credentials: init?.credentials, headers: [...new Headers(init?.headers)] }
}

// Literal wire expectations independently checked against 7903f1193's real createServerApi.
const paths = [
  "/api/usage/provider%2Fa?instanceId=w%2F1&sessionId=session+%2F1&modelId=model%2Fa",
  "/api/workspaces/w%2F1/service-usage/owner",
  "/api/workspaces/w%2F1/service-usage/cache?timezone=Europe%2FParis&days=7",
  "/api/workspaces/w%2F1/service-usage?from=10&to=20&timezone=Europe%2FParis&restorePeriod=true",
  "/api/workspaces/w%2F1/provider-accounts/provider%2Fa?directory=%2Frepo+with+space%2F%C3%A9",
  "/api/workspaces/w%2F1/provider-accounts/provider%2Fa",
]
function operations(api: Api, raw: string, signal: AbortSignal) {
  return [
    () => api.fetchProviderUsage(raw, "session /1", integration, "model/a", signal),
    () => api.getServiceUsageOwner(raw, signal),
    () => api.getCachedServiceUsage(raw, "Europe/Paris", 7, signal),
    () => api.getServiceUsage(raw, { from: 10, to: 20, timezone: "Europe/Paris", restorePeriod: true }, signal),
    () => api.getProviderAccounts(raw, integration, directory, signal),
    () => api.setProviderAccountSelection(raw, integration, directory, false, signal),
  ]
}
function expected(base: string, signal: AbortSignal): Wire[] {
  return paths.map((path, index) => ({ url: `${base}${path}`, method: index === 5 ? "PUT" : "GET",
    body: index === 5 ? JSON.stringify({ directory, enabled: false }) : undefined, signal,
    credentials: "include", headers: index === 5 ? [["content-type", "application/json"]] : [] }))
}
function fixture(t: TestContext, id: string) {
  const calls: Wire[] = []
  let refused = false
  const backend = createBackendClient({ id, baseUrl: `https://${id.toLowerCase()}.invalid:8443`, fetcher: async (input, init) => {
    const request = wire(input, init)
    calls.push(request)
    return request.url.endsWith("/api/auth/status") ? Response.json({ authenticated: false })
      : refused ? Response.json({ error: "owner refused" }, { status: 401 }) : Response.json({ owner: id })
  } })
  registry.set(id, backend)
  t.after(() => { backend.events.dispose(); registry.delete(id) })
  return { backend, calls, refuse: () => { refused = true } }
}

test("usage, Stats and accounts API wires isolate two owners with colliding raw workspace IDs", async t => {
  const localCalls: Wire[] = []
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    localCalls.push(wire(input, init)); return Response.json({})
  })
  const a = fixture(t, "usageA"), b = fixture(t, "usageB")
  for (const owner of [a, b]) {
    const key = `${owner.backend.id}~${workspace}`, signal = new AbortController().signal
    const api = backendOf(key).api
    for (const invoke of operations(api, parseInstanceKey(key).workspaceId, signal)) {
      assert.deepEqual(await invoke(), { owner: owner.backend.id })
    }
    assert.deepEqual(owner.calls, expected(owner.backend.baseUrl!, signal))
    for (const call of owner.calls) assert.equal(call.signal, signal, "caller signal reaches fetch unchanged")
  }
  assert.equal(a.calls.length, 6, "B does not dispatch through A")
  assert.deepEqual(localCalls, [], "remote methods never dispatch locally")
  assert.throws(() => backendOf(`absentUsage~${workspace}`).api.getServiceUsageOwner(workspace), /Backend unavailable: absentUsage/)
  assert.deepEqual(localCalls, [], "missing owner has no local fallback")
})

test("each usage family 401 probes only its owning backend and never retries", async t => {
  const localCalls: Wire[] = []
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    localCalls.push(wire(input, init)); return Response.json({})
  })
  const a = fixture(t, "usageAuthA"), b = fixture(t, "usageAuthB")
  b.refuse()
  for (let index = 0; index < paths.length; index++) {
    const controller = new AbortController(), signal = controller.signal
    await assert.rejects(operations(b.backend.api, workspace, signal)[index](), /owner refused/)
    await new Promise<void>(resolve => setImmediate(resolve))
    const [application, probe] = b.calls.splice(0)
    assert.deepEqual(application, expected(b.backend.baseUrl!, signal)[index])
    assert.ok(probe)
    assert.equal(probe.url, `${b.backend.baseUrl}/api/auth/status`)
    assert.equal(probe.method, "GET")
    assert.equal(probe.body, undefined)
    assert.equal(probe.credentials, "include")
    assert.ok(probe.signal instanceof AbortSignal)
    controller.abort()
    assert.equal(probe.signal.aborted, true, "auth probe retains caller cancellation")
    assert.deepEqual(b.calls, [], "one application request and one probe, without retry")
  }
  assert.equal(b.backend.auth.required(), true)
  assert.equal(a.backend.auth.required(), false)
  assert.deepEqual(a.calls, [])
  assert.deepEqual(localCalls, [])
})

test("local usage, Stats and account requests retain baseline wire bytes", async t => {
  const calls: Wire[] = [], signal = new AbortController().signal
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(wire(input, init)); return Response.json({})
  })
  assert.equal(backendOf(workspace), localBackend)
  for (const invoke of operations(backendOf(workspace).api, workspace, signal)) await invoke()
  assert.deepEqual(calls, expected(localBackend.baseUrl ?? "", signal))
  for (const call of calls) assert.equal(call.signal, signal)
})
