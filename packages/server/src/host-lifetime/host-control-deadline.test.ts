import assert from "node:assert/strict"
import test from "node:test"
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { transformSync } from "esbuild"
import { HostError, localOrigin, MAX_BYTES, TIMEOUT_MS } from "./protocol"
import type { hostRequest } from "./transport"
import type { HostLifetimeClient } from "./client"

function fixture() {
  let now = 100_000, timerID = 0, callback!: (response: EventEmitter) => void, parses = 0, requests = 0, destroys = 0
  let parseAt: number | undefined, payload = "", headers: Record<string, unknown> = {}
  let opened!: () => void
  const requestOpened = new Promise<void>(resolve => { opened = resolve })
  const timers = new Map<number, { fn: () => void; delay: number }>()
  const req = Object.assign(new EventEmitter(), { destroyed: false,
    end(value: string) { payload = value },
    destroy(error?: Error) { if (req.destroyed) return; req.destroyed = true; destroys++; if (error) req.emit("error", error); req.emit("close"); return req },
  })
  const sandbox: any = { exports: {}, module: { exports: {} }, Buffer,
    Date: class extends Date { static now() { return now } },
    JSON: { stringify: JSON.stringify, parse(value: string) { parses++; const result = JSON.parse(value); if (parseAt !== undefined) now = parseAt; return result } },
    setTimeout(fn: () => void, delay: number) { const id = ++timerID; timers.set(id, { fn, delay }); return id },
    clearTimeout(id: number) { timers.delete(id) },
    require(id: string): unknown {
      if (id === "node:http") return { request(_url: string, options: { headers: Record<string, unknown>; agent: boolean }, cb: typeof callback) {
        requests++; assert.equal(options.agent, false); headers = options.headers; callback = cb; opened(); return req
      } }
      if (id === "./protocol") return { HostError, localOrigin, MAX_BYTES, TIMEOUT_MS }
      if (id === "./transport") return transport
      if (id === "./storage") return {}
      if (id === "./process-identity") return { ownerState: async () => "live" }
      if (id === "node:crypto") return { randomUUID: () => "private-window", randomBytes: (size: number) => Buffer.alloc(size, 1) }
      throw new Error(`Unexpected private module: ${id}`)
    },
  }
  const load = (name: string) => {
    const source = new URL(name, import.meta.url)
    sandbox.module = { exports: {} }; sandbox.exports = sandbox.module.exports
    runInNewContext(transformSync(readFileSync(source, "utf8"), { loader: "ts", format: "cjs" }).code, sandbox, { filename: source.pathname })
    return sandbox.module.exports
  }
  const transport = load("./transport.ts") as { hostRequest: typeof hostRequest }
  const client = load("./client.ts") as { HostLifetimeClient: typeof HostLifetimeClient }
  const send = (body: unknown = {}) => transport.hostRequest("http://127.0.0.1:1234", "a".repeat(64), "b".repeat(64), "generation", "/attach", body)
  const respond = (body: string, elapsed = 4999, statusCode = 200, close = true) => {
    const response = Object.assign(new EventEmitter(), { statusCode })
    callback(response); now = 100_000 + elapsed
    response.emit("data", Buffer.from(body)); response.emit("end")
    if (close) req.emit("close")
  }
  return { send, client: client.HostLifetimeClient, req, timers, respond, requestOpened,
    responseError() { const response = new EventEmitter(); callback(response); response.emit("error", new Error("RESPONSE_CREDENTIAL_SENTINEL")) },
    crossDuringParse() { parseAt = 105_000 },
    fireTimeout() { now = 105_000; timers.values().next().value!.fn() },
    counters: () => ({ requests, destroys, parses, timersPending: timers.size, elapsed: now - 100_000 }),
    headers: () => headers, payload: () => payload,
  }
}

const success = JSON.stringify({ bootstrapProof: "opaque-proof", capability: "opaque-window" })
for (const elapsed of [4999, 5000, 5001]) {
  test(`host control absolute expiry at elapsed ${elapsed} despite held timer`, async context => {
    const f = fixture(), pending = f.send()
    f.respond(success, elapsed)
    if (elapsed < TIMEOUT_MS) assert.equal((await pending as any).capability, "opaque-window")
    else await assert.rejects(pending, { code: "host-request-timeout" })
    assert.equal(f.timers.size, 0)
    assert.equal(f.counters().requests, 1)
    context.diagnostic(JSON.stringify({ ...f.counters(), accepted: elapsed < TIMEOUT_MS, publishedCapabilities: elapsed < TIMEOUT_MS ? 1 : 0 }))
  })
}

test("host control absolute expiry is checked AFTER JSON parsing", async () => {
  const f = fixture(), pending = f.send()
  f.crossDuringParse(); f.respond(success, 4999)
  await assert.rejects(pending, { code: "host-request-timeout" })
  assert.equal(f.counters().parses, 1); assert.equal(f.timers.size, 0)
})

test("host control preserves fixed invalid JSON and non-200 errors without exposing bodies", async () => {
  for (const elapsed of [4999, 5000]) {
    for (const invalid of [false, true]) {
      const f = fixture(), pending = f.send()
      f.respond(invalid ? "BODY_CREDENTIAL_SENTINEL" : '{"code":"host-not-ready","secret":"BODY_CREDENTIAL_SENTINEL"}', elapsed, 503)
      await assert.rejects(pending, (error: HostError) => {
        assert.equal(error.code, invalid ? "invalid-host-response" : elapsed < TIMEOUT_MS ? "host-not-ready" : "host-request-timeout")
        assert.equal(error.message.includes("BODY_CREDENTIAL_SENTINEL"), false); return true
      })
      assert.equal(f.timers.size, 0)
    }
  }
})

test("host control keeps byte bounds, origin/auth headers and outgoing content length", async () => {
  const f = fixture(), pending = f.send({ marker: "utf8-é" })
  assert.equal(f.headers().authorization, `Bearer ${"a".repeat(64)}`)
  assert.equal(f.headers()["x-host-scope"], "b".repeat(64)); assert.equal(f.headers()["x-host-generation"], "generation")
  assert.equal(f.headers()["content-length"], Buffer.byteLength(f.payload()))
  f.respond("{}".padEnd(MAX_BYTES, " ")); await pending
  const large = fixture(), oversized = large.send()
  large.respond("x".repeat(MAX_BYTES + 1))
  await assert.rejects(oversized, { code: "response-too-large" })
  assert.equal(large.timers.size, 0)
  const outbound = fixture()
  await assert.rejects(outbound.send("x".repeat(MAX_BYTES)), { code: "request-too-large" })
  assert.equal(outbound.counters().requests, 0); assert.equal(outbound.timers.size, 0)
  assert.throws(() => localOrigin("http://192.0.2.1:1234"), { code: "invalid-local-origin" })
})

test("host control fired timeout fences late success and preserves the timeout cause", async () => {
  const f = fixture(), pending = f.send()
  f.fireTimeout()
  await assert.rejects(pending, { code: "host-request-timeout" })
  f.respond(success, 5001)
  assert.equal(f.counters().parses, 0); assert.equal(f.counters().destroys, 1); assert.equal(f.timers.size, 0)
})

test("host control request error/close fences late success and cleans the owned request", async () => {
  for (const event of ["error", "close", "response-error"]) {
    const f = fixture(), pending = f.send()
    let result: unknown
    void pending.then(() => { result = "accepted" }, error => { result = error.code })
    if (event === "response-error") f.responseError()
    else f.req.emit(event, new Error("REQUEST_CREDENTIAL_SENTINEL"))
    await Promise.resolve()
    assert.equal(result, "host-unreachable")
    f.respond(success)
    assert.equal(f.counters().parses, 0); assert.equal(f.timers.size, 0)
  }
})

for (const route of ["attach", "stop"] as const) for (const elapsed of [4999, 5000, 5001]) {
  test(`host control ${route} at ${elapsed} fences publication and never replays`, async context => {
    const f = fixture()
    const registration: any = { generation: "generation", scope: { key: "b".repeat(64) }, owner: { pid: 1 }, backend: { pid: 2 },
      origin: "http://127.0.0.1:1234", controlOrigin: "http://127.0.0.1:1234" }
    const attachment: any = { generation: "generation", managerPid: 1, backendPid: 2, origin: registration.origin,
      windowId: "private-window", capability: "opaque-window", bootstrapProof: "opaque-proof" }
    let launches = 0, published = 0
    const pending = route === "attach" ? f.client.attach({ storage: { scope: registration.scope, initialize: async () => {}, registration: async () => registration,
      secret: async () => "a".repeat(64) } as never, launch: async () => { launches++ } })
      : new f.client(registration, "a".repeat(64), attachment).stopAuthority()
    void pending.then(() => { published++ }, () => {})
    await Promise.race([f.requestOpened, pending])
    assert.equal(f.counters().requests, 1)
    f.respond(JSON.stringify(route === "attach" ? attachment : { stopped: true }), elapsed)
    if (elapsed < TIMEOUT_MS) await pending
    else await assert.rejects(pending, { code: "host-request-timeout" })
    assert.equal(published, elapsed < TIMEOUT_MS ? 1 : 0)
    assert.equal(launches, 0); assert.equal(f.counters().requests, 1); assert.equal(f.timers.size, 0)
    context.diagnostic(JSON.stringify({ route, ...f.counters(), published, launches, intentOutcome: elapsed < TIMEOUT_MS ? "acknowledged" : "unknown-no-replay" }))
  })
}
