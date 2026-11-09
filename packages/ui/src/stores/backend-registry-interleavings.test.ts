import assert from "node:assert/strict"
import test from "node:test"
import { createBackendClient } from "../lib/backend-client"
import { BackendEvents } from "../lib/backend-events"
import { createBackendRegistry } from "./backend-registry"
import { CODENOMAD_API_CONTRACT } from "../../../server/src/meta-contract"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function setup() {
  const previous = globalThis.window
  Object.assign(globalThis, { window: { location: { origin: "http://relay.test" } } })
  const meta = () => Response.json({ apiContract: CODENOMAD_API_CONTRACT, serverId: "a" })
  let read = async () => meta(), load = async () => {}, streams = 0
  const client = createBackendClient({ id: "a", baseUrl: "http://relay.test", fetcher: async () => read(),
    eventSource: () => { streams++; return { onopen: null, onerror: null, addEventListener() {}, close() {} } as unknown as EventSource } })
  const events = new BackendEvents()
  const registry = createBackendRegistry({ enabled: () => true, profiles: () => [{ id: "a", name: "A", baseUrl: "http://a.test", skipTlsVerify: false, createdAt: "", updatedAt: "" }],
    events, createClient: () => client, register: () => () => {}, loadWorkspaces: async () => load() })
  // Exercise the actual connection path, settling on its promise rather than its retry timer.
  const transport = client.events as unknown as { connect(): Promise<void>; connection: unknown; retryTimer: unknown }
  return { registry, client, meta, transport, streams: () => streams,
    dispose: () => { registry.dispose(); Object.assign(globalThis, { window: previous }) },
    read: (next: typeof read) => { read = next }, load: (next: typeof load) => { load = next } }
}

test("retry overtaking held SSE metadata preserves a healthy connection", async () => {
  for (const staleStatus of [200, 401, 404]) {
    const h = setup()
    try {
      await h.registry.ensure("a")
      const entered = deferred<void>(), held = deferred<Response>()
      h.read(async () => { entered.resolve(); return held.promise })
      const reconnect = h.transport.connect()
      await entered.promise
      h.read(async () => h.meta())
      await h.registry.retryWorkspaces("a")
      held.resolve(staleStatus === 200 ? h.meta() : new Response("", { status: staleStatus }))
      await reconnect
      assert.equal(h.registry.state("a"), "compatible")
      assert.notEqual(h.transport.connection, null)
      assert.equal(h.transport.retryTimer, null)
      assert.equal(h.streams(), 2)
    } finally { h.dispose() }
  }
})

test("SSE overtaking retry metadata rejects the obsolete flight and permits fresh demand", async () => {
  const h = setup()
  try {
    await h.registry.ensure("a")
    const entered = deferred<void>(), held = deferred<Response>()
    h.read(async () => { entered.resolve(); return held.promise })
    const rejected = assert.rejects(h.registry.retryWorkspaces("a"), /inventory unavailable/)
    await entered.promise
    h.read(async () => h.meta())
    await h.transport.connect()
    held.resolve(h.meta())
    await rejected
    assert.equal(await h.registry.retryWorkspaces("a"), h.client)
    assert.equal(h.registry.state("a"), "compatible")
    assert.notEqual(h.transport.connection, null)
    assert.equal(h.streams(), 2)
  } finally { h.dispose() }
})

test("metadata-only reconnect cannot repair failed inventory in either completion order", async () => {
  for (const failFirst of [false, true]) {
    const h = setup()
    try {
      await h.registry.ensure("a")
      const entered = deferred<void>(), held = deferred<void>()
      h.load(async () => { entered.resolve(); await held.promise; throw new Error("inventory offline") })
      const rejected = assert.rejects(h.registry.retryWorkspaces("a"), /inventory offline/)
      await entered.promise
      if (failFirst) { held.resolve(); await rejected }
      await h.transport.connect()
      if (!failFirst) { held.resolve(); await rejected }
      assert.equal(h.registry.state("a"), "unreachable")
      h.load(async () => {})
      assert.equal(await h.registry.retryWorkspaces("a"), h.client)
      assert.equal(h.registry.state("a"), "compatible")
      assert.notEqual(h.transport.connection, null)
      assert.equal(h.streams(), 2)
    } finally { h.dispose() }
  }
})

test("metadata failure during inventory fences success until a new explicit demand", async () => {
  const h = setup()
  try {
    await h.registry.ensure("a")
    const entered = deferred<void>(), held = deferred<void>()
    h.load(async () => { entered.resolve(); await held.promise })
    const rejected = assert.rejects(h.registry.retryWorkspaces("a"), /inventory unavailable/)
    await entered.promise
    h.read(async () => new Response("", { status: 401 }))
    await h.transport.connect()
    assert.equal(h.registry.state("a"), "unauthorized")
    held.resolve()
    await rejected
    assert.equal(h.registry.state("a"), "unauthorized")
    h.read(async () => h.meta())
    h.load(async () => {})
    assert.equal(await h.registry.retryWorkspaces("a"), h.client)
    assert.equal(h.registry.state("a"), "compatible")
  } finally { h.dispose() }
})

test("healthy reconnect preserves pending inventory success authority", async () => {
  const h = setup()
  try {
    h.load(async () => { throw new Error("initial offline") })
    await h.registry.ensure("a")
    const entered = deferred<void>(), held = deferred<void>()
    h.load(async () => { entered.resolve(); await held.promise })
    const retry = h.registry.retryWorkspaces("a")
    await entered.promise
    await h.transport.connect()
    assert.equal(h.registry.state("a"), "unreachable")
    held.resolve()
    assert.equal(await retry, h.client)
    assert.equal(h.registry.state("a"), "compatible")
    assert.equal(h.streams(), 2)
  } finally { h.dispose() }
})
