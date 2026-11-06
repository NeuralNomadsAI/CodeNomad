import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { test, type TestContext } from "node:test"
import { backendOf, backends, createBackendClient, localBackend, type BackendClient } from "./backend-client"
import { backendEvents } from "./backend-events"
import { getRootClient, buildRootProxyPath, type OpenCodeClient } from "../stores/opencode-client"
import { readHistoryWindow } from "../stores/history-window"
import { SDKManager } from "./sdk-manager"

type Wire = { path: string; method: string; body: string; media?: string }
const registry = backends as Map<string, BackendClient>

async function fixture(t: TestContext, id: string) {
  const requests: Wire[] = []
  const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    requests.push({ path: request.url!, method: request.method!, body,
      ...(request.headers["x-codenomad-media"] ? { media: String(request.headers["x-codenomad-media"]) } : {}) })
    response.setHeader("Content-Type", "application/json")
    if (request.url!.includes("/instance/api/")) {
      // Exercise the real generated request path and typed failure decoder.
      response.statusCode = 400
      response.end(JSON.stringify({ _tag: "InvalidRequestError", message: id, kind: "fixture" }))
    } else if (request.url!.endsWith("/session-history/window")) {
      response.end(JSON.stringify({ status: "window", messages: [], latest: true, resume: { kind: "latest" } }))
    } else response.end(JSON.stringify({ enabled: false, receipts: [] }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address() as { port: number }
  const backend = createBackendClient({ id, baseUrl: `http://127.0.0.1:${address.port}` })
  registry.set(id, backend)
  const detach = backendEvents.attach(id, backend.events)
  t.after(async () => {
    detach(); backend.events.dispose(); registry.delete(id)
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  return { backend, requests, detach }
}

const nativeCalls: [string, (client: OpenCodeClient) => Promise<unknown>][] = [
  ["/api/session?directory=%2Frepo", c => c.session.list({ directory: "/repo" })],
  ["/api/session/s", c => c.session.get({ sessionID: "s" })],
  ["/api/session/s/message", c => c.message.list({ sessionID: "s" })],
  ["/api/session/s/prompt", c => c.session.prompt({ sessionID: "s", text: "hello" })],
  ["/api/session/s/command", c => c.session.command({ sessionID: "s", name: "goal", text: "" })],
  ["/api/session/s/shell", c => c.session.shell({ sessionID: "s", command: "echo hello" })],
  ["/api/session/s/interrupt?resume=false", c => c.session.interrupt({ sessionID: "s", resume: false })],
  ["/api/session/s/compact", c => c.session.compact({ sessionID: "s" })],
  ["/api/session/s/revert/stage", c => c.session.revert.stage({ sessionID: "s", messageID: "m" })],
  ["/api/session/s/permission/p/reply", c => c.permission.reply({ sessionID: "s", requestID: "p", decision: "once" })],
  ["/api/session/s/form/q/reply", c => c.session.form.reply({ sessionID: "s", formID: "q", answer: {} })],
  ["/api/session/s/form/q", c => c.session.form.cancel({ sessionID: "s", formID: "q" })],
]

test("real session/chat SDK requests stay with A or B and expose only the raw workspace id", async t => {
  const a = await fixture(t, "a"), b = await fixture(t, "b")
  assert.equal(backendOf("a~same"), a.backend)
  assert.equal(backendOf("b~same"), b.backend)
  assert.notEqual(getRootClient("a~same"), getRootClient("b~same"))
  for (const owner of [a, b]) {
    const key = `${owner.backend.id}~same`
    const client = getRootClient(key)
    for (const [path, call] of nativeCalls) {
      await assert.rejects(call(client), { message: owner.backend.id })
      assert.equal(owner.requests.at(-1)?.path, `/workspaces/same/instance${path}`)
    }
    assert.equal(owner.requests.length, nativeCalls.length)
    assert.equal(owner.requests[2].media, "deferred")
    assert.equal(owner.requests[3].body, '{"text":"hello"}')
  }
  assert.equal(a.requests.length, nativeCalls.length, "B never sends through A")
  assert.equal(b.requests.length, nativeCalls.length, "A never sends through B")
})

test("conversation API boundaries strip the prefix, including a real history-window consumer", async t => {
  const { requests } = await fixture(t, "chat")
  const key = "chat~w/1", api = backendOf(key).api
  await readHistoryWindow(key, "s", { kind: "latest" })
  await api.fetchPermissionReceipts(key, "s", { unanchored: true })
  await api.fetchSessionOutline(key, "s")
  await api.fetchOutlinePreviews(key, "s", ["m"])
  await api.querySessionHistory(key, { sessionID: "s", purpose: "search", query: "hello", includeTechnical: true })
  await api.queryRankedHistory(key, { version: 1, query: "hello", includeTechnical: true, limit: 40 })
  await api.pruneSessionHistory(key, { sessionID: "s", candidates: [] })
  await api.pruneSessionMessage(key, { sessionID: "s", messageID: "m", indexes: [0], revision: "a".repeat(64) })
  await api.fetchSessionGoal(key, "s")
  await api.getPendingRequests(key, ["/repo"], undefined, ["/old"])
  await api.getYoloState(key, "s")
  await api.toggleYolo(key, "s")
  assert.deepEqual(requests.map(r => r.path), [
    "/api/workspaces/w%2F1/session-history/window",
    "/api/workspaces/w%2F1/sessions/s/permission-receipts?unanchored=true",
    "/api/workspaces/w%2F1/session-history/outline", "/api/workspaces/w%2F1/session-history/outlinePreview",
    "/api/workspaces/w%2F1/session-history/query", "/api/workspaces/w%2F1/session-history/ranked",
    "/api/workspaces/w%2F1/session-history/prune", "/api/workspaces/w%2F1/session-pruning/prune",
    "/api/workspaces/w%2F1/sessions/s/goal",
    "/api/workspaces/w%2F1/pending-requests?directories=%2Frepo&optionalDirectories=%2Fold",
    "/workspaces/w%2F1/yolo/sessions/s", "/workspaces/w%2F1/yolo/sessions/s/toggle",
  ])
  assert.equal(requests[0].media, "deferred")
  assert.equal(requests.some(r => r.body.includes("chat~")), false)
})

test("an absent backend fails before dispatch and never uses local", async t => {
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({}) })
  assert.throws(() => backendOf("absent~w"), /Backend unavailable: absent/)
  assert.throws(() => getRootClient("absent~w"), /Backend unavailable: absent/)
  await assert.rejects(readHistoryWindow("absent~w", "s", { kind: "latest" }), /Backend unavailable/)
  assert.equal(calls, 0)
})

test("local SDK routing preserves the baseline URL, body and headers byte for byte", async t => {
  const wire: unknown[] = []
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    wire.push({ url: String(input), method: init?.method, body: init?.body,
      headers: [...new Headers(init?.headers)], credentials: init?.credentials })
    return Response.json({ _tag: "InvalidRequestError", message: "fixture", kind: "fixture" }, { status: 400 })
  })
  assert.equal(backendOf("w/1"), localBackend)
  assert.equal(buildRootProxyPath("w/1"), "/workspaces/w%2F1/instance")
  // Node needs an absolute base; supply one only to the test's local SDK cache.
  const manager = new SDKManager({ url: path => `https://local.invalid${path}`, fetch: localBackend.fetch })
  t.mock.method(localBackend.sdk, "createClient", manager.createClient.bind(manager))
  const routed = getRootClient("w/1")
  const baseline = new SDKManager({ url: path => `https://local.invalid${path}`, fetch: localBackend.fetch })
    .createClient("w/1", "/workspaces/w%2F1/instance")
  for (const client of [baseline, routed]) await assert.rejects(client.session.prompt({ sessionID: "s", text: "hello" }))
  assert.deepEqual(wire[1], wire[0])
  assert.deepEqual(wire[1], { url: "https://local.invalid/workspaces/w%2F1/instance/api/session/s/prompt",
    method: "POST", body: '{"text":"hello"}', headers: [["content-type", "application/json"]], credentials: "include" })
  assert.equal(wire.length, 2)
})

test("local conversation HTTP routes preserve literal baseline requests", async t => {
  const wire: unknown[] = []
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    wire.push({ url: String(input), method: init?.method ?? "GET", body: init?.body,
      headers: [...new Headers(init?.headers)], credentials: init?.credentials })
    return Response.json({})
  })
  const api = backendOf("w/1").api
  await api.fetchHistoryWindow("w/1", "s", { kind: "latest" })
  await api.fetchPermissionReceipts("w/1", "s", { messageId: "m/1" }, "next")
  await api.getPendingRequests("w/1", ["/repo"], undefined, ["/old"])
  await api.toggleYolo("w/1", "s")
  assert.deepEqual(wire, [
    { url: "/api/workspaces/w%2F1/session-history/window", method: "POST", body: '{"sessionID":"s","target":{"kind":"latest"}}',
      headers: [["content-type", "application/json"], ["x-codenomad-media", "deferred"]], credentials: "include" },
    { url: "/api/workspaces/w%2F1/sessions/s/permission-receipts?messageId=m%2F1&cursor=next", method: "GET", body: undefined, headers: [], credentials: "include" },
    { url: "/api/workspaces/w%2F1/pending-requests?directories=%2Frepo&optionalDirectories=%2Fold", method: "GET", body: undefined, headers: [], credentials: "include" },
    { url: "/workspaces/w%2F1/yolo/sessions/s/toggle", method: "POST", body: undefined, headers: [], credentials: "include" },
  ])
})

test("a detached SDK response cannot settle on the replacement attachment", async t => {
  let release!: (response: Response) => void
  const backend = createBackendClient({ id: "revoked", baseUrl: "https://revoked.invalid",
    fetcher: () => new Promise<Response>(resolve => { release = resolve }) })
  registry.set(backend.id, backend)
  const detach = backendEvents.attach(backend.id, backend.events)
  t.after(() => { backend.events.dispose(); registry.delete(backend.id) })
  const pending = getRootClient("revoked~w").session.get({ sessionID: "s" })
  const rejected = assert.rejects(pending, error => error instanceof Error && /abort/i.test(error.message))
  assert.ok(release, "request dispatched under A")
  detach()
  t.after(backendEvents.attach(backend.id, backend.events))
  release(Response.json({}))
  await rejected
})
