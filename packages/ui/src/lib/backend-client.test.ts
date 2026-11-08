import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { test, type TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { serverApi } from "./api-client"
import { authenticatedFetch, authRecovery } from "./auth-recovery"
import { backendOf, backends, createBackendClient, createRemoteBackendClient, localBackend } from "./backend-client"
import { createPanelExtensionsApi } from "./panel-extensions-api"
import { toolImageSource } from "./tool-content"
import { sdkManager } from "./sdk-manager"
import { getServerMeta } from "./server-meta"
import { serverEvents } from "./server-events"
import { storage } from "./storage"

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

async function until(condition: () => boolean, message: string) {
  for (let attempt = 0; attempt < 50 && !condition(); attempt++) await tick()
  assert.ok(condition(), message)
}

test("the local backend is made of the singletons its importers already use", () => {
  assert.equal(localBackend.api, serverApi)
  assert.equal(localBackend.events, serverEvents)
  assert.equal(localBackend.auth, authRecovery)
  assert.equal(localBackend.fetch, authenticatedFetch)
  assert.equal(localBackend.storage, storage)
  assert.equal(localBackend.sdk, sdkManager)
  assert.equal(localBackend.meta.getServerMeta, getServerMeta)
  assert.equal(localBackend.id, "local")
  assert.deepEqual([...backends], [["local", localBackend]])
  assert.equal(backendOf("any-instance"), localBackend)
})

class FakeEventSource {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  private listeners = new Map<string, (event: { data: string }) => void>()
  constructor(readonly url: string, readonly init: EventSourceInit) {}
  addEventListener(type: string, listener: (event: { data: string }) => void) { this.listeners.set(type, listener) }
  emit(type: string, data: unknown) { this.listeners.get(type)?.({ data: JSON.stringify(data) }) }
  close() { this.closed = true }
}

function fakeBackend(baseUrl: string, answer: (path: string) => Response = () => Response.json({})) {
  const requests: string[] = [], sources: FakeEventSource[] = []
  const client = createBackendClient({
    id: new URL(baseUrl).hostname.split(".")[0], baseUrl, eventsUrl: "/api/events",
    fetcher: async (input) => {
      const url = String(input)
      requests.push(url)
      return answer(new URL(url).pathname)
    },
    eventSource: (url, init) => {
      const source = new FakeEventSource(url, init)
      sources.push(source)
      return source as unknown as EventSource
    },
  })
  return { client, requests, sources }
}

/** A renderer page; the local singletons were imported before it, without a browser. */
function useRendererWindow(t: TestContext) {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
  t.after(() => {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor)
    else Reflect.deleteProperty(globalThis, "window")
  })
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://ui.invalid" } } })
}

test("a backend client needs an absolute http(s) base URL", () => {
  for (const baseUrl of [undefined, "", "/api", "b.invalid", "ws://b.invalid", "file:///srv"]) {
    assert.throws(() => createBackendClient({ id: "b", baseUrl: baseUrl as string }), TypeError, String(baseUrl))
  }
  assert.equal(createBackendClient({ id: "b", baseUrl: "http://b.invalid:9898" }).url("/api/meta"), "http://b.invalid:9898/api/meta")
})

test("two backend clients keep their requests, events, pongs and login recovery apart", async (t) => {
  useRendererWindow(t)

  let aAuthenticated = true
  const a = fakeBackend("https://a.invalid", path => path === "/api/auth/status"
    ? Response.json({ authenticated: aAuthenticated }) : Response.json({}))
  const b = fakeBackend("https://b.invalid", path => path === "/api/auth/status"
    ? Response.json({ authenticated: true }) : new Response("{}", { status: 401 }))

  assert.notEqual(a.client.api, b.client.api)
  assert.equal(a.client.url("/api/meta"), "https://a.invalid/api/meta")
  assert.equal(a.client.eventsUrl, "https://a.invalid/api/events")

  await a.client.api.fetchServerMeta()
  assert.deepEqual(a.requests, ["https://a.invalid/api/meta"])

  // A 401 on B probes only B's login.
  await assert.rejects(b.client.api.fetchServerMeta())
  await until(() => b.requests.includes("https://b.invalid/api/auth/status"), "B's login is probed")
  assert.deepEqual(b.requests, ["https://b.invalid/api/meta", "https://b.invalid/api/auth/status"])
  assert.deepEqual(a.requests, ["https://a.invalid/api/meta"])

  // A client other than the local one connects only once started.
  await tick()
  assert.equal(a.sources.length, 0)
  assert.equal(b.sources.length, 0)
  a.client.events.start()
  b.client.events.start()
  await until(() => a.sources.length === 1 && b.sources.length === 1, "each started client opens its stream")
  assert.match(a.sources[0].url, /^https:\/\/a\.invalid\/api\/events\?clientId=[^&]+&connectionId=/)
  assert.match(b.sources[0].url, /^https:\/\/b\.invalid\/api\/events\?clientId=/)
  assert.deepEqual(a.sources[0].init, { withCredentials: true })

  // Events reach only their own client's subscribers.
  const received: string[] = []
  t.after(a.client.events.on("*", event => { received.push(`a:${event.type}`) }))
  t.after(b.client.events.on("*", event => { received.push(`b:${event.type}`) }))
  b.sources[0].onmessage!({ data: JSON.stringify({ type: "storage.stateChanged", owner: "fixture", value: {} }) })
  assert.deepEqual(received, ["b:storage.stateChanged"])

  // A's ping is answered to A.
  a.sources[0].emit("codenomad.client.ping", { ts: 7 })
  await until(() => a.requests.includes("https://a.invalid/api/client-connections/pong"), "A's pong goes to A")
  assert.equal(b.requests.some(url => url.includes("/pong")), false)

  // Restoring A's login restarts A's stream only.
  aAuthenticated = false
  await a.client.auth.check()
  assert.equal(a.client.auth.required(), true)
  assert.equal(b.client.auth.required(), false)
  aAuthenticated = true
  await a.client.auth.check()
  assert.equal(a.client.auth.required(), false)
  await until(() => a.sources.length === 2, "A reconnects after its login is restored")
  assert.equal(a.sources[0].closed, true)
  assert.equal(b.sources.length, 1)
  assert.equal(b.sources[0].closed, false)
  a.sources.forEach(source => source.close())
  b.sources.forEach(source => source.close())
})

test("two backend clients keep their OpenCode clients, stored owners and server meta apart", async (t) => {
  useRendererWindow(t)
  // Anything reaching the global fetch went through a local singleton.
  const globalRequests: string[] = []
  const globalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = globalFetch })
  globalThis.fetch = async (input) => {
    globalRequests.push(String(input instanceof Request ? input.url : input))
    return new Response("{}", { status: 599 })
  }

  const answers = (name: string) => (path: string) => {
    if (path === "/api/auth/status") return Response.json({ authenticated: true })
    if (path === "/api/meta") return Response.json({ host: name })
    if (path === "/api/storage/config/ui") return Response.json({ from: name })
    if (path.startsWith("/workspaces/ws/instance/")) return new Response("{}", { status: 401 })
    return Response.json({})
  }
  const a = fakeBackend("https://a.invalid", answers("a"))
  const b = fakeBackend("https://b.invalid", answers("b"))

  // B's OpenCode client is proxied by B, and its 401 probes only B's login.
  assert.notEqual(b.client.sdk, localBackend.sdk)
  const native = b.client.sdk.createClient("ws", "/workspaces/ws/instance")
  await assert.rejects(native.session.prompt({ sessionID: "owned", text: "fixture" }))
  await until(() => b.requests.includes("https://b.invalid/api/auth/status"), "B's login is probed")
  assert.deepEqual(b.requests, ["https://b.invalid/workspaces/ws/instance/api/session/owned/prompt", "https://b.invalid/api/auth/status"])
  assert.deepEqual(a.requests, [])

  // Each client caches its own backend's meta.
  assert.notEqual(b.client.meta, localBackend.meta)
  assert.deepEqual(await b.client.meta.getServerMeta(), { host: "b" })
  assert.deepEqual(await b.client.meta.getServerMeta(), { host: "b" })
  assert.deepEqual(await a.client.meta.getServerMeta(), { host: "a" })
  assert.equal(b.requests.filter(url => url === "https://b.invalid/api/meta").length, 1)
  assert.deepEqual(a.requests, ["https://a.invalid/api/meta"])

  // Each client reads its own backend's owners, and only its stream updates them.
  assert.notEqual(b.client.storage, localBackend.storage)
  assert.deepEqual(await a.client.storage.loadConfigOwner("ui"), { from: "a" })
  assert.deepEqual(await b.client.storage.loadConfigOwner("ui"), { from: "b" })
  assert.ok(b.requests.includes("https://b.invalid/api/storage/config/ui"))
  const changes: string[] = []
  t.after(a.client.storage.onConfigOwnerChanged("ui", value => { changes.push(`a:${value.from}`) }))
  t.after(b.client.storage.onConfigOwnerChanged("ui", value => { changes.push(`b:${value.from}`) }))
  t.after(localBackend.storage.onConfigOwnerChanged("ui", value => { changes.push(`local:${value.from}`) }))
  changes.length = 0
  a.client.events.start()
  b.client.events.start()
  await until(() => a.sources.length === 1 && b.sources.length === 1, "each started client opens its stream")
  b.sources[0].onmessage!({ data: JSON.stringify({ type: "storage.configChanged", owner: "ui", value: { from: "b2" } }) })
  assert.deepEqual(changes, ["b:b2"])
  assert.deepEqual(await b.client.storage.loadConfigOwner("ui"), { from: "b2" })
  assert.deepEqual(await a.client.storage.loadConfigOwner("ui"), { from: "a" })

  assert.deepEqual(globalRequests, [])
  a.sources.forEach(source => source.close())
  b.sources.forEach(source => source.close())
})

test("only the transport modules read the injected API base and events URL", () => {
  const root = fileURLToPath(new URL("..", import.meta.url))
  const readers: string[] = []
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        const source = readFileSync(path, "utf8")
        if (/CODENOMAD_API_BASE|__CODENOMAD_EVENTS_URL__|["'][^"']*\/api-base["']/.test(source)) readers.push(relative(root, path).split(sep).join("/"))
      }
    }
  }
  visit(root)
  assert.deepEqual(readers.sort(), ["lib/api-base.ts", "lib/backend-transport.ts"])
})

test("the remote factory routes HTTP, SDK, media, SSE and login through the local profile relay", async t => {
  useRendererWindow(t)
  const requests: { url: string; init?: RequestInit }[] = []
  const sources: FakeEventSource[] = []
  let authenticated = false
  const client = createRemoteBackendClient("remote_1", {
    fetcher: async (input, init) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.endsWith("/auth/status")) return Response.json({ authenticated })
      if (url.endsWith("/auth/login")) { authenticated = true; return Response.json({ ok: true }) }
      if (url.endsWith("/api/meta") && !authenticated) return new Response("{}", { status: 401 })
      return Response.json({})
    },
    eventSource: (url, init) => {
      const source = new FakeEventSource(url, init)
      sources.push(source)
      return source as unknown as EventSource
    },
  })
  t.after(() => client.events.dispose())
  const relay = "https://ui.invalid/api/backends/remote_1"
  assert.equal(client.id, "remote_1")
  assert.equal(client.baseUrl, "https://ui.invalid")
  assert.equal(client.eventsUrl, `${relay}/api/events`)
  assert.equal(sources.length, 0)
  assert.deepEqual([...backends], [["local", localBackend]])
  assert.throws(() => backendOf("remote_1~ws"), /Backend unavailable/)

  // Failed application requests are never replayed; recovery probes this relay only.
  await assert.rejects(client.api.fetchServerMeta())
  await until(() => client.auth.required(), "relay login is required")
  assert.deepEqual(requests.map(request => request.url), [`${relay}/api/meta`, `${relay}/api/auth/status`])
  assert.equal(await client.auth.signIn("owner", "password"), "ok")
  assert.equal(client.auth.required(), false)
  const login = requests.find(request => request.url.endsWith("/auth/login"))!
  assert.equal(login.init?.body, JSON.stringify({ username: "owner", password: "password" }))

  await client.meta.getServerMeta()
  await client.storage.loadConfigOwner("ui")
  await client.sdk.createClient("remote_1~ws", "/workspaces/ws/instance").session.prompt({ sessionID: "s", text: "fixture" })
  await createPanelExtensionsApi(client).panelExtensionsApi.list()
  const imagePath = `/api/workspaces/ws/session-media/s/m/0/0/${"a".repeat(64)}`
  const image = toolImageSource({ type: "file", mime: "image/png", uri: imagePath }, client)!
  assert.equal(image, `${relay}${imagePath}`)
  await client.fetch(image, { credentials: "include" })
  client.events.start()
  await until(() => sources.length === 1, "relay stream starts")
  assert.match(sources[0].url, /^https:\/\/ui\.invalid\/api\/backends\/remote_1\/api\/events\?clientId=/)
  assert.deepEqual(sources[0].init, { withCredentials: true })
  sources[0].emit("codenomad.client.ping", { ts: 7 })
  await until(() => requests.some(request => request.url.endsWith("/pong")), "relay pong is sent")
  for (const request of requests) {
    assert.ok(request.url.startsWith(`${relay}/`), request.url)
    assert.equal(request.init?.credentials, "include")
    assert.equal(new Headers(request.init?.headers).has("Authorization"), false)
  }
  assert.ok(requests.some(request => request.url === `${relay}/workspaces/ws/instance/api/session/s/prompt`))
  assert.ok(requests.some(request => request.url === `${relay}/api/storage/config/ui`))
  assert.ok(requests.some(request => request.url === `${relay}/api/panel-extensions`))
  for (const id of ["", "local", "../escape", "a/b", "a?b", "a".repeat(65)]) {
    assert.throws(() => createRemoteBackendClient(id), TypeError)
  }
})
