import assert from "node:assert/strict"
import test from "node:test"
import { createSignal } from "solid-js"
import type { RemoteServerProfile } from "../../../server/src/api-types"
import { CODENOMAD_API_CONTRACT } from "../../../server/src/meta-contract"
import { createBackendClient, type BackendClient } from "../lib/backend-client"
import { BackendEvents } from "../lib/backend-events"
import { createBackendRegistry } from "./backend-registry"

const profile: RemoteServerProfile = { id: "saved", name: "A", baseUrl: "http://a.test", skipTlsVerify: false,
  createdAt: "", updatedAt: "" }
const metadata = { apiContract: CODENOMAD_API_CONTRACT, serverId: "server-a" }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function harness(initial: unknown = true, bound = false) {
  const [enabled, setEnabled] = createSignal(initial)
  const [profiles, setProfiles] = createSignal([profile])
  const clients = new Map<string, BackendClient>()
  const created: BackendClient[] = [], requests: string[] = []
  let read = async () => Response.json(metadata)
  let loads = 0, streams = 0, closes = 0
  let load = async (_client: BackendClient, _signal: AbortSignal) => {}
  const opens: (() => void)[] = [], failures: (() => void)[] = []
  const events = new BackendEvents()
  const registry = createBackendRegistry({ enabled, profiles, events,
    createClient: id => {
      const client = createBackendClient({ id, baseUrl: "http://relay.test", ...(bound ? { relayProfileId: id, bindRelayAuthority: true } : {}), fetcher: async input => {
        requests.push(String(input))
        return read()
      }, eventSource: () => {
        streams++
        const source = { onopen: null as (() => void) | null, onerror: null as (() => void) | null, addEventListener() {},
          close() { closes++ } }
        opens.push(() => source.onopen?.())
        failures.push(() => source.onerror?.())
        return source as unknown as EventSource
      } })
      created.push(client)
      return client
    },
    register: client => { assert.equal(clients.has(client.id), false); clients.set(client.id, client)
      return () => { if (clients.get(client.id) === client) clients.delete(client.id) } },
    loadWorkspaces: async (client, signal) => { assert.equal(signal.aborted, false); loads++; await load(client, signal); return true },
  })
  return { registry, enabled, setEnabled, profiles, setProfiles, clients, created, events, requests, opens, failures,
    read: (next: typeof read) => { read = next }, load: (next: typeof load) => { load = next },
    loads: () => loads, streams: () => streams, closes: () => closes }
}

test("off is strict and observing or ensuring adds no requests or registrations", async () => {
  for (const value of [undefined, false, null, 0, 1, "true", {}, []]) {
    const h = harness(false)
    h.setEnabled(value)
    try {
      assert.equal(await h.registry.ensure("saved"), undefined)
      await assert.rejects(h.registry.retryWorkspaces("saved"))
      assert.equal(h.registry.state("saved"), "idle")
      assert.deepEqual(h.requests, [])
      assert.equal(h.clients.size, 0)
    } finally { h.registry.dispose() }
  }
})

test("explicit retry repairs failed initial and first-open inventories without ensure polling or a new stream", async () => {
  const previous = globalThis.window
  Object.assign(globalThis, { window: { location: { origin: "http://relay.test" } } })
  const h = harness()
  let snapshot = "retained"
  h.load(async () => { throw new Error("offline") })
  const off = h.events.onOpen(() => { void h.registry.retryWorkspaces("saved").catch(() => {}) })
  try {
    const client = await h.registry.ensure("saved")
    assert.ok(client)
    h.opens[0]?.()
    await new Promise(resolve => setImmediate(resolve))
    const before = h.loads(), requests = h.requests.length
    assert.equal(before, 2, "initial list and first-open recovery both failed")
    assert.equal(h.registry.state("saved"), "unreachable")
    assert.equal(snapshot, "retained")
    assert.equal(await h.registry.ensure("saved"), client)
    assert.equal(await h.registry.ensure("saved"), client)
    assert.equal(h.loads(), before)
    assert.equal(h.requests.length, requests)
    h.load(async (owner, signal) => {
      assert.equal(owner, client); assert.equal(signal, h.events.signal("saved")); snapshot = "fresh"
    })
    const first = h.registry.retryWorkspaces("saved")
    assert.equal(h.registry.retryWorkspaces("saved"), first)
    assert.equal(await first, client)
    assert.equal(h.loads(), before + 1)
    assert.equal(snapshot, "fresh")
    assert.equal(h.registry.state("saved"), "compatible")
    assert.equal(h.streams(), 1)
  } finally { off(); h.registry.dispose(); Object.assign(globalThis, { window: previous }) }
})

test("retry invalidations coalesce into at most one serialized follow-up", async () => {
  const h = harness()
  try {
    await h.registry.ensure("saved")
    const held = deferred<void>(), entered = deferred<void>()
    h.load(async () => { entered.resolve(); await held.promise })
    const first = h.registry.retryWorkspaces("saved")
    await entered.promise
    for (let i = 0; i < 10; i++) assert.equal(h.registry.retryWorkspaces("saved", { invalidate: true }), first)
    assert.equal(h.loads(), 2)
    held.resolve()
    await first
    assert.equal(h.loads(), 3)
  } finally { h.registry.dispose() }
})

test("current reconnect publication repairs inventory availability; obsolete health and attachments stay fenced", async () => {
  const h = harness()
  try {
    h.load(async () => { throw new Error("offline") })
    await h.registry.ensure("saved")
    assert.equal(h.registry.state("saved"), "unreachable")
    const stale = h.registry.workspaceReadGuard("saved", h.events.signal("saved"))
    h.read(async () => new Response("", { status: 401 }))
    await assert.rejects(h.registry.retryWorkspaces("saved"))
    stale()
    assert.equal(h.registry.state("saved"), "unauthorized")
    h.read(async () => Response.json(metadata))
    h.load(async () => {})
    await h.registry.retryWorkspaces("saved")
    h.load(async () => { throw new Error("inventory failed") })
    await assert.rejects(h.registry.retryWorkspaces("saved"))
    const publish = h.registry.workspaceReadGuard("saved", h.events.signal("saved"))
    publish()
    assert.equal(h.registry.state("saved"), "compatible")
    h.registry.detach("saved")
    publish()
    assert.equal(h.registry.state("saved"), "idle")
  } finally { h.registry.dispose() }
})

test("retry validates fresh identity, contract, authorization and immutable proof before listing", async () => {
  for (const change of ["identity", "contract", "auth", "proof"]) {
    const h = harness(true, true), header = "x-codenomad-backend-authority"
    h.read(async () => Response.json(metadata, { headers: { [header]: "a".repeat(43) } }))
    try {
      await h.registry.ensure("saved")
      h.read(async () => change === "auth" ? new Response("", { status: 401 }) : Response.json({ ...metadata,
        ...(change === "identity" ? { serverId: "other" } : {}),
        ...(change === "contract" ? { apiContract: -1 } : {}),
      }, { headers: { [header]: (change === "proof" ? "b" : "a").repeat(43) } }))
      await assert.rejects(h.registry.retryWorkspaces("saved"))
      assert.equal(h.loads(), 1, change)
      assert.equal(h.registry.state("saved"), change === "auth" ? "unauthorized" : "refused")
      const requests = h.requests.length
      if (change !== "auth") await assert.rejects(h.registry.retryWorkspaces("saved"))
      assert.equal(h.requests.length, requests)
      assert.equal(h.created.length, 1)
    } finally { h.registry.dispose() }
  }
})

test("stale retry metadata and failure never affect B or the replacement client", async () => {
  const h = harness()
  h.setProfiles([profile, { ...profile, id: "b" }])
  try {
    const a = await h.registry.ensure("saved"), b = await h.registry.ensure("b")
    const bSignal = h.events.signal("b"), held = deferred<Response>()
    h.read(() => held.promise)
    const stale = h.registry.retryWorkspaces("saved")
    await new Promise(resolve => setImmediate(resolve))
    h.registry.detach("saved")
    h.read(async () => Response.json(metadata))
    const replacement = await h.registry.ensure("saved")
    assert.notEqual(replacement, a)
    const count = h.loads()
    held.resolve(Response.json({ ...metadata, apiContract: -1 }))
    await assert.rejects(stale)
    assert.equal(h.clients.get("saved"), replacement)
    assert.equal(h.registry.state("saved"), "compatible")
    assert.equal(h.clients.get("b"), b)
    assert.equal(h.events.signal("b"), bSignal)
    assert.equal(h.registry.state("b"), "compatible")
    assert.equal(h.loads(), count)
    const requests = h.requests.length
    await assert.rejects(h.registry.retryWorkspaces("local"))
    await assert.rejects(h.registry.retryWorkspaces("absent"))
    assert.equal(h.requests.length, requests)
  } finally { h.registry.dispose() }
})

test("invalidation during the trailing read parks instead of starting a third read", async () => {
  const h = harness()
  try {
    await h.registry.ensure("saved")
    h.load(async () => { h.registry.retryWorkspaces("saved", { invalidate: true }).catch(() => {}) })
    await assert.rejects(h.registry.retryWorkspaces("saved"))
    assert.equal(h.loads(), 3)
    h.load(async () => {})
    await h.registry.retryWorkspaces("saved")
    assert.equal(h.loads(), 4)
  } finally { h.registry.dispose() }
})

test("obsolete retry completion cannot repair a retarget, TLS change, ABA, off or disposed owner", async () => {
  for (const change of ["url", "tls", "aba", "off", "dispose", "detach"]) {
    const h = harness()
    try {
      h.load(async () => { throw new Error("offline") })
      await h.registry.ensure("saved")
      const held = deferred<void>(), entered = deferred<void>()
      h.load(async () => { entered.resolve(); await held.promise })
      const old = h.registry.retryWorkspaces("saved")
      await entered.promise
      if (change === "url") h.setProfiles([{ ...profile, baseUrl: "http://b.test" }])
      if (change === "tls") h.setProfiles([{ ...profile, skipTlsVerify: true }])
      if (change === "aba") { h.setProfiles([]); h.setProfiles([profile]) }
      if (change === "off") h.setEnabled(false)
      if (change === "dispose") h.registry.dispose()
      if (change === "detach") h.events.signal("saved") && h.created[0].events.dispose()
      held.resolve()
      await assert.rejects(old, Error, change)
      assert.notEqual(h.registry.state("saved"), "compatible", change)
    } finally { h.registry.dispose() }
  }
})

test("opted-in candidates require a local proof after metadata validation, never a body field", async () => {
  for (const proof of [undefined, "malformed", ""]) {
    const h = harness(true, true)
    h.read(async () => Response.json({ ...metadata, "x-codenomad-backend-authority": "x".repeat(43) }, {
      headers: proof === undefined ? {} : { "x-codenomad-backend-authority": proof },
    }))
    try {
      assert.equal(await h.registry.ensure("saved"), undefined)
      assert.equal(h.registry.state("saved"), "refused")
      assert.equal(h.loads(), 0)
      assert.equal(h.streams(), 0)
      assert.equal(h.clients.size, 0)
      await assert.rejects(h.created[0].api.deleteWorkspace("w"))
      assert.equal(h.requests.length, 1, "no legacy fallback after proof refusal")
    } finally { h.registry.dispose() }
  }
})

test("reconnect refuses a different local generation without retargeting the admitted client", async () => {
  const previous = globalThis.window
  Object.assign(globalThis, { window: { location: { origin: "http://relay.test" } } })
  const h = harness(true, true), header = "x-codenomad-backend-authority"
  h.read(async () => Response.json(metadata, { headers: { [header]: "a".repeat(43) } }))
  try {
    const client = await h.registry.ensure("saved")
    assert.ok(client)
    const token = h.events.signal("saved")!
    const before = client.url("/api/workspaces")
    h.read(async () => Response.json(metadata, { headers: { [header]: "b".repeat(43) } }))
    client.events.restart()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(h.registry.state("saved"), "refused")
    assert.equal(token.aborted, true)
    assert.equal(client.url("/api/workspaces"), before)
    assert.equal(h.streams(), 1)
  } finally { h.registry.dispose(); Object.assign(globalThis, { window: previous }) }
})

test("concurrent ensure coalesces, rename retains client, replacement revokes the exact old token", async () => {
  const h = harness()
  try {
    const first = h.registry.ensure("saved"), second = h.registry.ensure("saved")
    assert.equal(first, second)
    const client = await first
    assert.ok(client)
    assert.equal(h.created.length, 1)
    assert.equal(h.loads(), 1)
    const token = h.events.signal("saved")!
    h.setProfiles([{ ...profile, name: "renamed" }])
    assert.equal(await h.registry.ensure("saved"), client)
    assert.equal(h.events.signal("saved"), token)
    h.registry.detach("saved")
    assert.equal(token.aborted, true)
    const replacement = await h.registry.ensure("saved")
    assert.notEqual(replacement, client)
    assert.notEqual(h.events.signal("saved"), token)
    h.setEnabled(false)
    assert.equal(h.clients.size, 0)
    assert.equal(h.events.signal("saved"), undefined)
  } finally { h.registry.dispose() }
})

test("missing, mismatched or empty metadata refuses without SSE, attachment or workspace reads", async () => {
  for (const meta of [null, {}, { ...metadata, apiContract: 0 }, { ...metadata, serverId: " " }]) {
    const h = harness()
    h.read(async () => Response.json(meta))
    try {
      assert.equal(await h.registry.ensure("saved"), undefined)
      assert.equal(h.registry.state("saved"), "refused")
      assert.equal(h.clients.size, 0)
      assert.equal(h.events.signal("saved"), undefined)
      assert.equal(h.loads(), 0)
      assert.equal(h.streams(), 0)
    } finally { h.registry.dispose() }
  }
})

test("absent metadata endpoint and non-JSON metadata refuse without attachment", async () => {
  for (const response of [new Response("missing", { status: 404 }), new Response("<html>old server</html>")]) {
    const h = harness()
    h.read(async () => response)
    try {
      assert.equal(await h.registry.ensure("saved"), undefined)
      assert.equal(h.registry.state("saved"), "refused")
      assert.equal(h.clients.size, 0)
      assert.equal(h.streams(), 0)
      assert.equal(h.loads(), 0)
    } finally { h.registry.dispose() }
  }
})

test("URL/TLS change, removal, flag off or disposal during metadata fences late publication", async () => {
  for (const change of ["url", "tls", "ssh", "remove", "off", "dispose"]) {
    const h = harness(), response = deferred<Response>()
    h.read(() => response.promise)
    const pending = h.registry.ensure("saved")
    if (change === "url") h.setProfiles([{ ...profile, baseUrl: "http://b.test" }])
    if (change === "tls") h.setProfiles([{ ...profile, skipTlsVerify: true }])
    if (change === "ssh") h.setProfiles([{ ...profile, ssh: { host: "lab" } }])
    if (change === "remove") h.setProfiles([])
    if (change === "off") h.setEnabled(false)
    if (change === "dispose") h.registry.dispose()
    response.resolve(Response.json(metadata))
    assert.equal(await pending, undefined, change)
    assert.equal(h.clients.size, 0, change)
    assert.equal(h.loads(), 0, change)
    assert.equal(h.streams(), 0, change)
    h.registry.dispose()
  }
})

test("fresh metadata revalidation precedes reconnect open/resync; changed identity revokes and closes", async () => {
  const previous = globalThis.window
  Object.assign(globalThis, { window: { location: { origin: "http://relay.test" } } })
  const h = harness()
  let opened = 0
  h.events.onOpen(() => { opened++ })
  try {
    const client = await h.registry.ensure("saved")
    assert.ok(client)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(h.streams(), 1)
    h.opens[0]()
    assert.equal(opened, 1)
    const token = h.events.signal("saved")!
    const held = deferred<Response>()
    h.read(() => held.promise)
    client.events.restart()
    assert.equal(h.streams(), 1, "a reconnect cannot open another source before metadata resolves")
    assert.equal(opened, 1)
    held.resolve(Response.json({ ...metadata, serverId: "replacement" }))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(h.registry.state("saved"), "refused")
    assert.equal(token.aborted, true)
    assert.equal(h.clients.size, 0)
    assert.equal(h.streams(), 1)
    h.opens[0]()
    assert.equal(opened, 1, "late onOpen cannot resync revoked authority")
    assert.equal(h.closes(), 1)
  } finally { h.registry.dispose(); Object.assign(globalThis, { window: previous }) }
})

test("a late candidate cannot publish into or remove the same profile's replacement", async () => {
  const h = harness(), held = deferred<Response>()
  h.read(() => held.promise)
  try {
    const stale = h.registry.ensure("saved")
    h.setProfiles([{ ...profile, baseUrl: "http://new.test" }])
    h.read(async () => Response.json(metadata))
    const replacement = await h.registry.ensure("saved")
    const token = h.events.signal("saved")!
    held.resolve(Response.json({ ...metadata, apiContract: -1 }))
    assert.equal(await stale, undefined)
    assert.equal(h.clients.get("saved"), replacement)
    assert.equal(h.events.signal("saved"), token)
    assert.equal(token.aborted, false)
    assert.equal(h.registry.state("saved"), "compatible")
  } finally { h.registry.dispose() }
})

test("unauthorized and unavailable candidates stay distinct and an explicit retry rereads metadata", async () => {
  for (const status of [401, 503]) {
    const h = harness()
    h.read(async () => new Response("", { status }))
    try {
      assert.equal(await h.registry.ensure("saved"), undefined)
      assert.equal(h.registry.state("saved"), status === 401 ? "unauthorized" : "unreachable")
      h.read(async () => Response.json(metadata))
      assert.ok(await h.registry.ensure("saved"))
    } finally { h.registry.dispose() }
  }
})

test("detach and disposal close a live stream and cancel its watchdog", async t => {
  const previous = globalThis.window
  Object.assign(globalThis, { window: { location: { origin: "http://relay.test" } } })
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"] })
  try {
    for (const action of ["detach", "dispose"] as const) {
      const h = harness()
      try {
        const client = await h.registry.ensure("saved")
        assert.ok(client)
        let disposed = 0
        client.events.onDispose(() => { disposed++ })
        await new Promise(resolve => setImmediate(resolve))
        h.opens[0]()
        const token = h.events.signal("saved")!
        assert.equal(h.streams(), 1)
        assert.equal(h.closes(), 0, "the source is still live before revocation")
        if (action === "detach") h.registry.detach("saved")
        else h.registry.dispose()
        assert.equal(h.closes(), 1, action)
        assert.equal(disposed, 1, action)
        const requests = h.requests.length
        t.mock.timers.tick(60_000)
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(h.closes(), 1, action)
        assert.equal(h.requests.length, requests, action)
        assert.equal(h.streams(), 1, action)
        assert.equal(token.aborted, true, action)
        assert.equal(h.clients.size, 0, action)
      } finally { h.registry.dispose() }
    }
  } finally { Object.assign(globalThis, { window: previous }); t.mock.timers.reset() }
})

test("superseded reconnect metadata cannot revoke a newer connection; disposal cancels retry timers", async t => {
  const previous = globalThis.window
  Object.assign(globalThis, { window: { location: { origin: "http://relay.test" } } })
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  const h = harness()
  try {
    const client = (await h.registry.ensure("saved"))!
    await new Promise(resolve => setImmediate(resolve))
    const token = h.events.signal("saved")!
    const stale = deferred<Response>()
    h.read(() => stale.promise)
    client.events.restart()
    h.read(async () => Response.json(metadata))
    client.events.restart()
    await new Promise(resolve => setImmediate(resolve))
    stale.resolve(Response.json({ ...metadata, apiContract: -1 }))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(h.registry.state("saved"), "compatible")
    assert.equal(h.events.signal("saved"), token)
    h.failures.at(-1)!()
    assert.equal(token.aborted, false, "temporary stream failure retains its attachment")
    t.mock.timers.tick(1000)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(h.streams(), 3, "ordinary retry connects after fresh metadata")
    h.failures.at(-1)!()
    h.registry.dispose()
    const requests = h.requests.length, streams = h.streams()
    t.mock.timers.tick(60_000)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(h.requests.length, requests)
    assert.equal(h.streams(), streams)
    assert.equal(token.aborted, true)
    assert.equal(h.closes(), 3)
  } finally { h.registry.dispose(); Object.assign(globalThis, { window: previous }); t.mock.timers.reset() }
})
