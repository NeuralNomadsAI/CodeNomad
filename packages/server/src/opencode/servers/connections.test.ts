import assert from "node:assert/strict"
import test from "node:test"
import { createServer, type ServerResponse } from "node:http"
import { once } from "node:events"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import pino from "pino"
import { OpenCodeServerConnections } from "./connections"
import { OpenCodeServerCredentials } from "./credentials"
import { OpenCodeServerRegistry } from "./registry"
import { explicitContractFixture as contract } from "../compatibility/contract-fixture"
import { OpenCodeSharedService } from "../../workspaces/opencode-service"
import { SettingsService } from "../../settings/service"
import { resolveConfigLocation } from "../../config/location"
import { WorkspaceManager } from "../../workspaces/manager"
import { BinaryResolver } from "../../settings/binaries"
import { EventBus } from "../../events/bus"
import type { OpenCodeServerProfile } from "./types"

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function upstream(label = "A") {
  const calls: string[] = [], auth: (string | undefined)[] = []
  const arrived = deferred(), closed = deferred()
  let holdContract = false, holdRequest = false, holdStream = false, schema = contract(), held: ServerResponse | undefined
  let contractStatus = 200, rawContract: string | undefined
  const server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`)
    auth.push(request.headers.authorization)
    response.setHeader("content-type", "application/json")
    if (holdStream && request.url !== "/openapi.json") {
      held = response
      response.on("close", () => closed.resolve())
      response.write("first\n")
      return
    }
    if (request.url === "/openapi.json") {
      response.statusCode = contractStatus
      if (holdContract) { held = response; arrived.resolve(); return }
      response.end(rawContract ?? JSON.stringify(schema)); return
    }
    if (holdRequest) { held = response; response.on("close", () => closed.resolve()); arrived.resolve(); return }
    if (request.url === "/api/info") response.end(JSON.stringify({ version: "99.0.0" }))
    else response.end(JSON.stringify({ data: { id: "same-session", title: label } }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { origin, calls, auth, arrived: arrived.promise, closed: closed.promise,
    blockContract() { holdContract = true }, blockRequest() { holdRequest = true },
    blockStream() { holdStream = true },
    schema(value: any) { schema = value }, finish() { held?.end(JSON.stringify(schema)) },
    contractResponse(status: number, raw?: string) { contractStatus = status; rawContract = raw },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}

async function fixture(origins: string[], localOrigin = origins[0]!) {
  let profiles: OpenCodeServerProfile[] = origins.map((origin, index) => ({ kind: "explicit", id: `s${index}`, label: `Server ${index}`, origin }))
  const registry = new OpenCodeServerRegistry(() => profiles, next => { profiles = next })
  const credentials = new OpenCodeServerCredentials({ profileKey: "test", configIdentity: "config" }, registry)
  for (const profile of profiles) await credentials.set(profile.id, JSON.stringify({ username: "test-user", password: "test-secret" }))
  const local = new OpenCodeSharedService()
  await local.endpoint({ kind: "lifecycle", identity: "fixture", lifecycle: {
    discover: async () => ({ url: localOrigin }), ensure: async () => { throw new Error("No start allowed") },
  } })
  const owner = new OpenCodeServerConnections({ registry, credentials, local: {
    acquire: () => local.acquire(), existing: () => local.existingConnection(), invalidate: () => local.invalidate(),
  } })
  return { owner, credentials, registry, profiles, async close() { await owner.dispose(); await local.shutdown() } }
}

test("A blocked at admission leaves B and local usable; IDs and clients stay scoped; same target shares reservation and promise", async t => {
  const a = await upstream("A"), b = await upstream("B"), c = await upstream("Local")
  const f = await fixture([a.origin, b.origin], c.origin)
  t.after(async () => { await f.close(); await a.close(); await b.close(); await c.close() })
  a.blockContract()
  const first = f.owner.connect("s0"), second = f.owner.acquireForServer("s0", "project")
  assert.equal(first, second)
  await a.arrived
  const B = await f.owner.connect("s1"), local = await f.owner.acquireForServer("local-shared")
  assert.equal((await B.client.session.get({ sessionID: "same-session" })).title, "B")
  assert.equal((await local.client.session.get({ sessionID: "same-session" })).title, "Local")
  a.finish()
  const A = await first
  assert.notEqual(A.client, B.client)
  assert.notEqual(A.client, local.client)
  assert.equal((await A.client.session.get({ sessionID: "same-session" })).title, "A")
  assert.equal(a.calls.filter(call => call === "GET /openapi.json").length, 1)
  assert.equal(a.auth[0], `Basic ${Buffer.from("test-user:test-secret").toString("base64")}`)
})

// prototype-1236 (R15): one connection per server, reused by every project, tab, window and folder browse.
test("every project and browse on one server shares a single connection, negotiated once", async t => {
  const a = await upstream("A"), local = await upstream("Local")
  const f = await fixture([a.origin], local.origin)
  t.after(async () => { await f.close(); await a.close(); await local.close() })
  const leases = ["/one", "/two", "/two"].map(directory => f.owner.retainProject({ serverId: "s0", directory }))
  const [first, ...others] = await Promise.all([...leases.map(lease => lease.acquire()), f.owner.connect("s0"),
    f.owner.acquireForWorkspace({ serverId: "s0", directory: "/one" })])
  for (const connection of others) assert.equal(connection, first)
  assert.equal(f.owner.existingForServer("s0"), first)
  assert.equal(f.owner.activeExplicitTargets, 1)
  assert.equal(a.calls.filter(call => call === "GET /openapi.json").length, 1)
  leases[0]!.release()
  assert.equal(await leases[1]!.acquire(), first, "closing one project keeps its siblings on the same connection")
  for (const lease of leases) lease.release()
})

test("admitted-source observer snapshots existing slots, excludes reservations/probes/failures and retains offline targets", async t => {
  const u = await upstream(), f = await fixture(Array(5).fill(u.origin))
  t.after(async () => { await f.close(); await u.close() })
  const snapshots: string[][] = []
  const off = f.owner.observeAdmitted(ids => snapshots.push([...ids]))
  assert.deepEqual(snapshots.slice(), [[]])
  await f.owner.probe("s0")
  assert.deepEqual(snapshots.slice(), [[]])
  await f.owner.connect("s0")
  const late: string[][] = []
  const stopLate = f.owner.observeAdmitted(ids => late.push([...ids]))
  assert.deepEqual(late, [["s0"]])
  f.owner.invalidateServer("s0")
  assert.deepEqual(snapshots.at(-1), ["s0"])
  await f.owner.acquireForServer("s0")
  for (const id of ["s1", "s2", "s3"]) await f.owner.connect(id)
  await assert.rejects(f.owner.connect("s4"), { code: "quota" })
  assert.ok(snapshots.every(ids => !ids.includes("s4")))
  f.owner.disconnect("s0")
  assert.deepEqual(snapshots.at(-1), ["s1", "s2", "s3"])
  off(); stopLate()
})

test("five concurrent restorations cap at four; last multi-window reference releases; disconnected tabs require Connect", async t => {
  const u = await upstream(), f = await fixture(Array(5).fill(u.origin))
  t.after(async () => { await f.close(); await u.close() })
  const leases = f.profiles.map(profile => f.owner.retainProject({ serverId: profile.id, directory: "/same" }))
  const extraWindow = f.owner.retainProject({ serverId: "s0", directory: "/same" })
  const results = await Promise.allSettled(leases.map(lease => lease.acquire()))
  assert.deepEqual(results.map(result => result.status), ["fulfilled", "fulfilled", "fulfilled", "fulfilled", "rejected"])
  assert.equal((results[4] as PromiseRejectedResult).reason.code, "quota")
  assert.equal(f.owner.activeExplicitTargets, 4)
  leases[0]!.release()
  assert.equal(f.owner.activeExplicitTargets, 4)
  extraWindow.release()
  assert.equal(f.owner.activeExplicitTargets, 3)
  await leases[4]!.acquire()
  assert.equal(f.owner.activeExplicitTargets, 4)
  f.owner.disconnect("s1")
  await assert.rejects(leases[1]!.acquire(), { code: "disconnected" })
  await assert.rejects(f.owner.acquireForWorkspace({ serverId: "s1", directory: "/same" }), { code: "disconnected" })
  await f.owner.connect("s1")
  assert.equal(await leases[1]!.acquire(), f.owner.existingForServer("s1"))
  for (const lease of leases) lease.release()
  assert.equal(f.owner.activeExplicitTargets, 0)
})

test("initial failure frees reservation, admitted offline/retry and rotation retain it; Connect pin expires on first last-close", async t => {
  const u = await upstream(), f = await fixture(Array(5).fill(u.origin))
  t.after(async () => { await f.close(); await u.close() })
  const missing = contract(); delete missing.components.schemas["Session.Message.Assistant.Text"]
  u.schema(missing)
  await assert.rejects(f.owner.connect("s0"), /native_contract/)
  assert.equal(f.owner.activeExplicitTargets, 0)
  u.schema(contract())
  const first = await f.owner.connect("s0")
  assert.equal(f.owner.activeExplicitTargets, 1)
  f.owner.invalidateServer("s0")
  assert.equal(f.owner.activeExplicitTargets, 1)
  u.schema(missing)
  await assert.rejects(f.owner.acquireForServer("s0"), /native_contract/)
  assert.equal(f.owner.activeExplicitTargets, 1)
  u.schema(contract())
  const retry = await f.owner.acquireForServer("s0")
  assert.notEqual(retry, first)
  first.invalidate() // A retired caller cannot invalidate the replacement.
  retry.assertCurrent()
  await f.credentials.set("s0", JSON.stringify({ username: "rotated", password: "new" }))
  assert.equal(f.owner.activeExplicitTargets, 1)
  assert.throws(retry.assertCurrent, /stale_connection/)
  await f.owner.acquireForServer("s0")
  const lease = f.owner.retainProject({ serverId: "s0", directory: "/same" })
  lease.release(); lease.release()
  assert.equal(f.owner.activeExplicitTargets, 0)
  await f.owner.connect("s4")
  f.owner.disconnect("s4")
  assert.equal(f.owner.activeExplicitTargets, 0)
})

for (const action of ["rotate", "forget", "disconnect", "remove", "retarget", "shutdown"] as const) {
  test(`${action} aborts in-flight HTTP and denies held fetch/client/profile wrappers`, async t => {
    const u = await upstream(), f = await fixture([u.origin])
    t.after(async () => { await f.close(); await u.close() })
    const connection = await f.owner.connect("s0")
    const fetch = connection.fetch, client = connection.client, profile = connection.profile
    u.blockRequest()
    const inflight = fetch(`${u.origin}/api/session/same-session`)
    const rejected = assert.rejects(inflight)
    await u.arrived
    if (action === "rotate") await f.credentials.set("s0", JSON.stringify({ username: "new", password: "new" }))
    if (action === "forget") await f.credentials.clear("s0")
    if (action === "disconnect") f.owner.disconnect("s0")
    if (action === "remove") f.registry.replace([])
    if (action === "retarget") f.registry.replace([{ ...f.profiles[0]!, origin: "http://127.0.0.1:1" }])
    if (action === "shutdown") await f.owner.dispose()
    await rejected
    await u.closed
    const count = u.calls.length
    await assert.rejects(fetch(`${u.origin}/api/session/same-session`))
    await assert.rejects(client.session.get({ sessionID: "same-session" }))
    await assert.rejects(client.event.subscribe()[Symbol.asyncIterator]().next())
    await assert.rejects(profile())
    u.finish() // A late server completion cannot resurrect a revoked generation.
    assert.equal(u.calls.length, count)
    if (action === "remove" || action === "retarget") {
      f.registry.replace(f.profiles)
      assert.equal(await f.credentials.readForConnection("s0"), null)
    }
    assert.doesNotMatch(JSON.stringify(connection.endpoint), /test-secret|test-user/)
  })
}

test("disconnect during admission fences late completion and immediately makes room for fifth target", async t => {
  const a = await upstream(), b = await upstream(), f = await fixture([a.origin, b.origin, b.origin, b.origin, b.origin])
  t.after(async () => { await f.close(); await a.close(); await b.close() })
  a.blockContract()
  const pending = f.owner.connect("s0"), rejected = assert.rejects(pending)
  await a.arrived
  await Promise.all(["s1", "s2", "s3"].map(id => f.owner.connect(id)))
  await assert.rejects(f.owner.connect("s4"), { code: "quota" })
  f.owner.disconnect("s0")
  const fifth = await f.owner.connect("s4")
  a.finish()
  await rejected
  fifth.assertCurrent()
  assert.equal(f.owner.existingForServer("s0"), undefined)
})

test("revocation aborts already returned streaming bodies", async t => {
  const u = await upstream(), f = await fixture([u.origin])
  t.after(async () => { await f.close(); await u.close() })
  const old = await f.owner.connect("s0")
  u.blockStream()
  const response = await old.fetch(`${u.origin}/api/event`), reader = response.body!.getReader()
  assert.equal(new TextDecoder().decode((await reader.read()).value), "first\n")
  const waiting = reader.read(), rejected = assert.rejects(waiting)
  await f.credentials.set("s0", JSON.stringify({ username: "next", password: "next" }))
  await rejected
  await u.closed
})

for (const action of ["rotate", "forget", "disconnect", "remove", "retarget", "shutdown", "request-abort"] as const) {
  for (const location of [false, true]) test(`${action} cancels open ${location ? "location JSON" : "binary"} body preparation without producer completion`, async t => {
    const u = await upstream(), f = await fixture([u.origin])
    t.after(async () => { await f.close(); await u.close() })
    const connection = await f.owner.connect("s0"), abort = new AbortController()
    let cancelled = false
    const request = new Request(`${u.origin}/api/session/same-session/prompt`, {
      method: "POST", signal: abort.signal,
      headers: location ? { "x-codenomad-location": JSON.stringify({ directory: "/same" }) } : {},
      body: new ReadableStream({ cancel() { cancelled = true } }), duplex: "half",
    } as RequestInit)
    const count = u.calls.length, sending = connection.fetch(request)
    const rejected = assert.rejects(sending)
    await new Promise<void>(resolve => setImmediate(resolve))
    if (action === "rotate") await f.credentials.set("s0", JSON.stringify({ username: "next", password: "next" }))
    if (action === "forget") await f.credentials.clear("s0")
    if (action === "disconnect") f.owner.disconnect("s0")
    if (action === "remove") f.registry.replace([])
    if (action === "retarget") f.registry.replace([{ ...f.profiles[0]!, origin: "http://127.0.0.1:1" }])
    if (action === "shutdown") await f.owner.dispose()
    if (action === "request-abort") abort.abort()
    assert.equal(await Promise.race([rejected.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 150))]), true,
      "fetch must reject while producer remains open")
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(cancelled, true, "body reader must cancel its source")
    assert.equal(u.calls.length, count, "prepared mutation must never dispatch or replay")
    if (["disconnect", "remove", "retarget", "shutdown"].includes(action)) assert.equal(f.owner.activeExplicitTargets, 0)
  })
}

test("retarget and server-ID reuse clear credentials before publication; old wrappers cannot disconnect a replacement", async t => {
  const a = await upstream(), b = await upstream(), f = await fixture([a.origin])
  t.after(async () => { await f.close(); await a.close(); await b.close() })
  const old = await f.owner.connect("s0")
  f.registry.replace([{ ...f.profiles[0]!, origin: b.origin }])
  assert.deepEqual(await f.credentials.status("s0"), { hasCredentials: false, needsCredentials: true })
  await f.credentials.set("s0", JSON.stringify({ username: "B", password: "B" }))
  const current = await f.owner.connect("s0")
  await assert.rejects(old.fetch(`${a.origin}/api/info`))
  old.invalidate()
  current.assertCurrent()
  assert.equal(f.owner.existingForServer("s0"), current)
  f.registry.replace([])
  f.registry.replace(f.profiles)
  assert.equal(await f.credentials.readForConnection("s0"), null)
  await assert.rejects(f.owner.connect("s0"), { code: "needs_credentials" })
})

test("missing required E1 routes, bodies or replay schemas reject before functional traffic", async t => {
  const u = await upstream(), f = await fixture([u.origin])
  t.after(async () => { await f.close(); await u.close() })
  for (const remove of [
    (schema: any) => { delete schema.paths["/api/event"] },
    (schema: any) => { delete schema.paths["/api/session/{sessionID}/form/{formID}/reply"].post.requestBody },
    (schema: any) => { delete schema.components.schemas["Session.Info"] },
    (schema: any) => { delete schema.components.schemas["Session.Message.Assistant.Text"] },
  ]) {
    const schema = contract(); remove(schema); u.schema(schema)
    await assert.rejects(f.owner.connect("s0"), { code: "missing_contract" })
    assert.equal(f.owner.activeExplicitTargets, 0)
  }
  assert.deepEqual(u.calls, Array(4).fill("GET /openapi.json"))
})

test("bounded probes share one separate lane and create neither slots nor SSE; future contract needs no env/plugin/image enrichment", async t => {
  const a = await upstream(), b = await upstream(), f = await fixture([a.origin, b.origin])
  t.after(async () => { await f.close(); await a.close(); await b.close() })
  a.blockContract()
  const abort = new AbortController(), pending = f.owner.probe("s0", abort.signal), rejected = assert.rejects(pending)
  await a.arrived
  await assert.rejects(f.owner.probe("s1"), { code: "probe_busy" })
  assert.equal(f.owner.activeExplicitTargets, 0)
  abort.abort()
  await rejected
  await f.owner.probe("s1")
  assert.equal(f.owner.activeExplicitTargets, 0)
  const connection = await f.owner.connect("s1")
  const response = await connection.fetch(`${b.origin}/api/info`)
  assert.equal((await response.json()).version, "99.0.0")
  assert.ok([...a.calls, ...b.calls].every(call => /^GET (\/openapi.json|\/api\/info)$/.test(call)))
  assert.equal(f.owner.existingForServer("unknown"), undefined)
  await assert.rejects(f.owner.acquireForServer("unknown", "project"), { code: "unknown_server" })
})

test("authentication and malformed-contract diagnostics are fixed codes without response or credential contents", async t => {
  const u = await upstream(), f = await fixture([u.origin])
  t.after(async () => { await f.close(); await u.close() })
  u.contractResponse(401, "test-secret is echoed by a broken upstream")
  await assert.rejects(f.owner.connect("s0"), { code: "auth", message: "auth" })
  // prototype-1236: a 401 forgets the rejected credential until a new link or password.
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(f.owner.connect("s0"), { code: "needs_credentials" })
  await f.credentials.set("s0", JSON.stringify({ username: "test-user", password: "test-secret" }))
  u.contractResponse(200, "test-secret is malformed JSON")
  await assert.rejects(f.owner.connect("s0"), { code: "missing_contract", message: "missing_contract: canonical_api" })
  assert.equal(f.owner.activeExplicitTargets, 0)
})

test("SettingsService shares registry, credentials and connection owner across window callers; summaries are live and shutdown clears memory", async t => {
  const u = await upstream(), root = mkdtempSync(path.join(process.cwd(), ".tmp-connections-"))
  const settings = new SettingsService(resolveConfigLocation(path.join(root, "config.yaml")), undefined, pino({ level: "silent" }))
  const local = { acquire: async () => { throw new Error("Local must not be used") }, existing: () => undefined, invalidate() {} }
  const manager = new WorkspaceManager({ rootDir: root, settings, binaryResolver: new BinaryResolver(settings),
    eventBus: new EventBus(), logger: pino({ level: "silent" }) })
  t.after(async () => { await manager.shutdown(); await u.close(); rmSync(root, { recursive: true, force: true }) })
  settings.getOpenCodeServerRegistry().replace([{ kind: "explicit", id: "s0", label: "A", origin: u.origin }])
  assert.equal(settings.getOpenCodeServerRegistry(), settings.getOpenCodeServerRegistry())
  assert.equal(settings.getOpenCodeServerCredentials(), settings.getOpenCodeServerCredentials())
  const owner = manager.getServerConnections()
  assert.equal(owner, settings.getOpenCodeServerConnections(local))
  await settings.getOpenCodeServerCredentials().set("s0", JSON.stringify({ username: "sentinel", password: "sentinel" }))
  assert.deepEqual((await settings.getOpenCodeServerSummaries())[1], {
    kind: "explicit", id: "s0", label: "A", origin: u.origin, hasCredentials: true, needsCredentials: false,
  })
  const connection = await owner.connect("s0")
  await manager.shutdown()
  await assert.rejects(connection.fetch(`${u.origin}/api/info`))
  await assert.rejects(settings.getOpenCodeServerCredentials().readForConnection("s0"), { code: "closed" })
  const restarted = new SettingsService(resolveConfigLocation(path.join(root, "config.yaml")), undefined, pino({ level: "silent" }))
  assert.equal((await restarted.getOpenCodeServerSummaries())[1]?.kind, "explicit")
  // prototype-1236 (R17): a manual password is kept across launches, in the private backend file only.
  assert.deepEqual(await restarted.getOpenCodeServerCredentials().status("s0"), { hasCredentials: true, needsCredentials: false })
  const config = readFileSync(path.join(root, "config.yaml"), "utf8")
  assert.equal(config.includes("sentinel"), false)
  assert.equal(readFileSync(path.join(root, "opencode-server-pairings.json"), "utf8").includes("sentinel"), true)
  await restarted.getOpenCodeServerCredentials().rejected("s0")
  assert.equal(readFileSync(path.join(root, "opencode-server-pairings.json"), "utf8").includes("sentinel"), false, "a 401 forgets it")
  await restarted.disposeOpenCodeServers()
})
