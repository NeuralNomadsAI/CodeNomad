import assert from "node:assert/strict"
import test from "node:test"
import { createServer, type ServerResponse } from "node:http"
import { once } from "node:events"
import { gzipSync } from "node:zlib"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCodeServerConnections } from "./connections"
import { OpenCodeServerCredentials } from "./credentials"
import { OpenCodeServerRegistry } from "./registry"
import { explicitContractFixture } from "../compatibility/contract-fixture"
import { boundedResponseFetch } from "../bounded-response-fetch"
import type { ResolveAddresses } from "./endpoint"
import { Agent } from "undici"
import { probeExplicitCandidate } from "./probe"

async function fixture(t: test.TestContext, handler?: (path: string, response: ServerResponse) => void, resolveAddresses?: ResolveAddresses) {
  const calls: string[] = [], headers: (string | undefined)[] = []
  const server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`); headers.push(request.headers.authorization)
    if (handler) return handler(request.url!, response)
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify(request.url === "/openapi.json" ? explicitContractFixture() : { version: "99.0.0", pid: 999, urls: ["private"], paths: { tmp: "private" } }))
  })
  server.listen(0, "127.0.0.1"); await once(server, "listening")
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  let writes = 0
  const registry = new OpenCodeServerRegistry(() => [], () => { writes++ })
  const credentials = new OpenCodeServerCredentials({ profileKey: "test", configIdentity: "test" }, registry)
  const owner = new OpenCodeServerConnections({ registry, credentials, resolveAddresses, local: {
    acquire: async () => { throw new Error("local acquire forbidden") }, existing: () => undefined,
    invalidate: () => { throw new Error("local invalidation forbidden") },
  } })
  t.after(async () => { await owner.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return { origin, owner, calls, headers, writes: () => writes, credentials }
}

test("unregistered candidate negotiates and observes version without registry, credentials, slots or subscriptions", async t => {
  const f = await fixture(t)
  f.credentials.set = async () => { assert.fail("candidate must never store credentials") }
  const admitted: string[][] = []
  f.owner.observeAdmitted(ids => admitted.push([...ids]))
  const result = await f.owner.probeCandidate({ origin: f.origin, credentials: { username: "candidate-user", password: "candidate-secret" } })
  assert.equal(result.version, "99.0.0")
  assert.equal(result.capabilities.chat.state, "available")
  assert.equal(result.capabilities.missions.state, "unavailable")
  assert.equal(result.diagnostic, null)
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)))
  assert.deepEqual(f.calls, ["GET /openapi.json", "GET /api/info"])
  assert.ok(f.headers.every(value => value === `Basic ${Buffer.from("candidate-user:candidate-secret").toString("base64")}`))
  assert.deepEqual(admitted, [[]]); assert.equal(f.owner.activeExplicitTargets, 0); assert.equal(f.writes(), 0)
  assert.doesNotMatch(JSON.stringify(result), /candidate-user|candidate-secret|private|999/)
})

test("candidate and registered probes share one lane; abort frees it before old cleanup", async t => {
  let arrived!: () => void
  const ready = new Promise<void>(resolve => { arrived = resolve })
  const f = await fixture(t, (_path, response) => { response.write("{"); arrived() })
  const cancel = new AbortController()
  const pending = f.owner.probeCandidate({ origin: f.origin }, cancel.signal), rejected = assert.rejects(pending)
  await ready
  await assert.rejects(f.owner.probe("unknown"), { code: "probe_busy" })
  await assert.rejects(f.owner.probeCandidate({ origin: f.origin }), { code: "probe_busy" })
  cancel.abort(); await rejected
  assert.equal(f.owner.activeExplicitTargets, 0)
  const again = new AbortController()
  const second = f.owner.probeCandidate({ origin: f.origin }, again.signal), secondRejected = assert.rejects(second)
  await delay(20)
  await assert.rejects(f.owner.probeCandidate({ origin: f.origin }), { code: "probe_busy" })
  again.abort(); await secondRejected
})

test("one real five-second budget spans contract headers/body and canonical info", async t => {
  let resolutions = 0
  const f = await fixture(t, (path, response) => {
    if (path === "/openapi.json") {
      const timer = setTimeout(() => response.end(JSON.stringify(explicitContractFixture())), 2_600)
      response.on("close", () => clearTimeout(timer))
    } else { response.writeHead(200); response.write('{"version":') }
  }, async () => { resolutions++; await delay(900); return [{ address: "127.0.0.1", family: 4 }] })
  const started = performance.now()
  await assert.rejects(f.owner.probeCandidate({ origin: f.origin.replace("127.0.0.1", "localhost") }), { code: "timeout" })
  const elapsed = performance.now() - started
  assert.ok(elapsed >= 4_900 && elapsed < 6_000, `${elapsed}ms`)
  assert.deepEqual(f.calls, ["GET /openapi.json", "GET /api/info"])
  assert.equal(resolutions, 2)
  assert.equal(f.owner.activeExplicitTargets, 0)
})

for (const status of [200, 401, 500]) for (const extra of [0, 1]) {
  test(`decoded probe body ${status}, eight MiB ${extra ? "+1 rejected" : "exact accepted"}`, async t => {
    const document = JSON.stringify(explicitContractFixture())
    const bytes = Buffer.from(document + " ".repeat(8 * 1024 * 1024 + extra - Buffer.byteLength(document)))
    const f = await fixture(t, (path, response) => {
      if (path === "/api/info") { response.setHeader("content-type", "application/json"); response.end('{"version":"99.0.0","pid":1,"urls":[],"paths":{"tmp":"private"}}'); return }
      response.writeHead(status, { "content-type": "application/json", "content-encoding": "gzip", "www-authenticate": "private" })
      response.end(gzipSync(bytes))
    })
    if (extra) await assert.rejects(f.owner.probeCandidate({ origin: f.origin }), { code: "response_limit" })
    else if (status === 401) await assert.rejects(f.owner.probeCandidate({ origin: f.origin }), { code: "auth" })
    else if (status === 500) await assert.rejects(f.owner.probeCandidate({ origin: f.origin }), { code: "network" })
    else assert.equal((await f.owner.probeCandidate({ origin: f.origin })).version, "99.0.0")
    assert.equal(f.owner.activeExplicitTargets, 0)
  })
}

test("bounded response cancellation never waits for held/rejected cleanup and releases its reader", async () => {
  for (const reject of [false, true]) {
    const controller = new AbortController()
    let cancelled = 0
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled++; return reject ? Promise.reject(new Error("private")) : new Promise(() => {}) } })
    const response = new Response(body)
    const fetcher = boundedResponseFetch(async () => response, controller.signal, () => {}, 1)
    const pending = fetcher("http://fixture.test"), rejected = assert.rejects(pending)
    await delay(1); controller.abort(); await rejected
    assert.equal(cancelled, 1); assert.equal(body.locked, false)
  }
})

test("invalid candidate syntax and credentials fail before DNS; disposal cancels pending DNS and late completion", async t => {
  let queries = 0, finish!: () => void
  const pendingDNS = new Promise<void>(resolve => { finish = resolve })
  const f = await fixture(t, undefined, async () => { queries++; await pendingDNS; return [{ address: "127.0.0.1", family: 4 }] })
  for (const origin of ["https://user:password@localhost", "https://localhost/sub", "https://localhost?", "https://localhost#", "malformed"]) {
    await assert.rejects(f.owner.probeCandidate({ origin }), { code: "invalid_origin" })
  }
  await assert.rejects(f.owner.probeCandidate({ origin: f.origin, credentials: { username: "invalid:name", password: "sentinel" } }), { code: "invalid_credentials" })
  assert.equal(queries, 0)
  const pending = f.owner.probeCandidate({ origin: f.origin.replace("127.0.0.1", "localhost") }), rejected = assert.rejects(pending)
  await delay(1); assert.equal(queries, 1)
  await f.owner.dispose(); await rejected
  finish(); await delay(1)
  assert.equal(f.calls.length, 0); assert.equal(f.writes(), 0)
  await assert.rejects(f.owner.probeCandidate({ origin: f.origin }), { code: "closed" })
})

test("canonical-info errors remain bounded before SDK parsing and cannot hide overflow", async t => {
  const f = await fixture(t, (path, response) => {
    response.setHeader("content-type", "application/json")
    if (path === "/openapi.json") response.end(JSON.stringify(explicitContractFixture()))
    else { response.writeHead(500, { "content-encoding": "gzip" }); response.end(gzipSync(Buffer.alloc(8 * 1024 * 1024 + 1, 97))) }
  })
  await assert.rejects(f.owner.probeCandidate({ origin: f.origin }), { code: "response_limit", phase: "info" })
})

test("bounded-response overflow and late fetch settlement release readers without awaiting cleanup", async () => {
  let cancelled = 0
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(2)) }, cancel() { cancelled++; return new Promise(() => {}) } })
  const signal = new AbortController()
  await assert.rejects(boundedResponseFetch(async () => new Response(body), signal.signal, () => {}, 1)("http://fixture.test"), { code: "response_limit" })
  assert.equal(cancelled, 1); assert.equal(body.locked, false)
  let finish!: (value: Response) => void
  const lateBody = new ReadableStream<Uint8Array>({ cancel() { cancelled++; return Promise.reject(new Error("private")) } })
  const fetcher = boundedResponseFetch(() => new Promise(resolve => { finish = resolve }), signal.signal, () => {}, 1)
  const pending = fetcher("http://fixture.test"), rejected = assert.rejects(pending)
  signal.abort(); await rejected
  finish(new Response(lateBody)); await delay(1)
  assert.equal(cancelled, 2); assert.equal(lateBody.locked, false)
})

test("held dispatcher cleanup cannot hold the single probe lane or clear its replacement", async t => {
  const original = Agent.prototype.destroy
  let cleanups = 0
  t.mock.method(Agent.prototype, "destroy", function (this: Agent) {
    cleanups++
    original.call(this, null, () => {})
    return new Promise(() => {})
  })
  const f = await fixture(t, (_path, response) => { response.writeHead(302, { location: "https://private.invalid" }); response.end() })
  await assert.rejects(f.owner.probeCandidate({ origin: f.origin }), { code: "redirect" })
  await assert.rejects(f.owner.probeCandidate({ origin: f.origin }), { code: "redirect" })
  assert.equal(f.calls.length, 2); assert.ok(cleanups >= 2)
})

test("unavailable/custom info stays explicitly unknown and never echoes upstream identity prose", async t => {
  let version = "candidate-secret"
  const f = await fixture(t, (path, response) => {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify(path === "/openapi.json" ? explicitContractFixture() : { version, pid: 999, urls: ["private"], paths: { tmp: "private" } }))
  })
  const result = await f.owner.probeCandidate({ origin: f.origin, credentials: { username: "candidate-user", password: "candidate-secret" } })
  assert.equal(result.version, null)
  assert.deepEqual(result.diagnostic, { code: "info_unavailable", phase: "info" })
  assert.equal(result.capabilities.chat.state, "available")
  assert.doesNotMatch(JSON.stringify(result), /candidate-secret|candidate-user|private|999/)
  version = "99.0.0"
  const numericEcho = await f.owner.probeCandidate({ origin: f.origin, credentials: { username: "candidate-user", password: version } })
  assert.equal(numericEcho.version, null)
  assert.doesNotMatch(JSON.stringify(numericEcho), /99\.0\.0/)
})

for (const depth of [2, 3]) test(`protected probe owns HTTP response at headers/admission depth ${depth}`, async t => {
  let hold = true
  const f = await fixture(t, (path, response) => {
    response.setHeader("content-type", "application/json")
    if (hold) { response.write("{"); return }
    response.end(JSON.stringify(path === "/openapi.json" ? explicitContractFixture() : { version: "99.0.0", pid: 1, urls: [], paths: { tmp: "owned" } }))
  })
  const abort = new AbortController(), NativeResponse = Response, cancel = ReadableStream.prototype.cancel
  let captured: ReadableStream | undefined, cancellations = 0
  const schedule = (remaining: number) => queueMicrotask(() => remaining > 1 ? schedule(remaining - 1) : abort.abort())
  t.mock.method(ReadableStream.prototype, "cancel", function (this: ReadableStream, reason?: unknown) {
    if (this === captured) cancellations++
    return cancel.call(this, reason)
  })
  // Observe the real protected transport's Response receipt, retaining its native body.
  t.mock.method(globalThis, "Response", class extends NativeResponse {
    constructor(...args: ConstructorParameters<typeof NativeResponse>) {
      super(...args)
      if (!captured && args[0] instanceof ReadableStream) { captured = args[0]; schedule(depth) }
    }
  })
  await assert.rejects(probeExplicitCandidate({ origin: f.origin }, abort.signal, () => abort.signal.throwIfAborted()))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(cancellations, 1); assert.equal(captured?.locked, false)
  assert.deepEqual(f.calls, ["GET /openapi.json"])
  t.mock.restoreAll(); hold = false
  assert.equal((await f.owner.probeCandidate({ origin: f.origin })).version, "99.0.0")
  assert.equal(f.owner.activeExplicitTargets, 0); assert.equal(f.writes(), 0)
})
