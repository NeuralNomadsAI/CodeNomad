import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { serverApi } from "./api-client"
import { authenticatedFetch, authRecovery } from "./auth-recovery"
import { backendOf, backends, createBackendClient, localBackend } from "./backend-client"
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

test("two backend clients keep their requests, events, pongs and login recovery apart", async (t) => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
  t.after(() => {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor)
    else Reflect.deleteProperty(globalThis, "window")
  })
  // A renderer page; the local singleton was imported before it, without a browser.
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://ui.invalid" } } })

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

test("only the transport modules read the injected API base and events URL", () => {
  const root = fileURLToPath(new URL("..", import.meta.url))
  const readers: string[] = []
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        const source = readFileSync(path, "utf8")
        if (/CODENOMAD_API_BASE|__CODENOMAD_EVENTS_URL__|["'][./]*\/api-base["']/.test(source)) readers.push(relative(root, path).split(sep).join("/"))
      }
    }
  }
  visit(root)
  assert.deepEqual(readers.sort(), ["lib/api-base.ts", "lib/backend-transport.ts"])
})
