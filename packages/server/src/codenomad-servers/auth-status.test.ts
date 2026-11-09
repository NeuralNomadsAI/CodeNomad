import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import http, { type IncomingMessage, type ServerResponse } from "node:http"
import { gzipSync } from "node:zlib"
import { test, type TestContext } from "node:test"
import Fastify from "fastify"
import { RemoteServerBrowseManager } from "./browse-manager"
import { CodeNomadServerClient } from "./client"
import { CodeNomadServerCredentials, type CodeNomadServerSecret } from "./credentials"
import { startFakeCodeNomad } from "./test-support/fake-codenomad"
import { registerBackendRelayRoutes } from "../server/routes/backend-relay"
import { registerRequestLogging } from "../server/request-logging"
import type { Logger } from "../logger"
import { RELAY_AUTHORITY_HEADER as AUTHORITY, RELAY_BOOTSTRAP } from "./relay-authority"
import { resolveHttpsOptions } from "../server/tls"

const STATUS = "/api/auth/status", LOGIN = "/api/auth/login", BUSINESS = "/api/test/once"
const valid = { authenticated: true, username: "codenomad", passwordUserProvided: true }
const password: CodeNomadServerSecret = { kind: "password", username: "codenomad", password: "private-test-password", cookie: "codenomad_session=initial-private" }
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function bounded<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("HTTP barrier timed out")), ms) })]) }
  finally { clearTimeout(timer) }
}
function json(response: ServerResponse, body: unknown, code = 200) {
  response.writeHead(code, { "content-type": "application/json" }); response.end(JSON.stringify(body))
}
function open(origin: string, target: string, options: { method?: string; headers?: http.OutgoingHttpHeaders } = {}) {
  const received = deferred<IncomingMessage>()
  const request = http.request(new URL(target, origin), { method: options.method ?? "GET", agent: false,
    headers: { origin, ...options.headers } }, response => received.resolve(response))
  const response = Promise.race([received.promise, new Promise<never>((_, reject) => request.once("error", reject))])
  // Cancellation before headers is an expected outcome for follower tests.
  void response.catch(() => {})
  return { request, response }
}
async function read(response: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of response) chunks.push(Buffer.from(chunk))
  return { status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }
}
async function fixture(t: TestContext, secret: CodeNomadServerSecret | null = password, anonymous = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-auth-status-"))
  // Anonymous fixture admission lets handlers independently control expired/private cookies.
  const remote = await startFakeCodeNomad({ anonymous })
  if (!anonymous) remote.state.sessions.add("initial-private")
  const file = path.join(directory, "remote-server-credentials.json")
  if (secret) new CodeNomadServerCredentials(file).set("saved", remote.origin, secret)
  const profiles = [{ id: "saved", baseUrl: remote.origin, skipTlsVerify: false }]
  const settings = { getOwner: () => ({ remoteServers: profiles }), configYamlPathForAuthority: () => path.join(directory, "config.yaml") }
  const manager = new RemoteServerBrowseManager(settings)
  const app = Fastify()
  const logs: unknown[] = []
  registerRequestLogging(app, { debug: (record: unknown) => logs.push(record), trace: (record: unknown) => logs.push(record), isLevelEnabled: () => true } as unknown as Logger)
  let origin = ""
  registerBackendRelayRoutes(app, { manager, getSelfOrigins: () => new Set([origin]) })
  origin = await app.listen({ host: "127.0.0.1", port: 0 })
  t.after(async () => { manager.close(); app.server.closeAllConnections(); await app.close(); await remote.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  remote.state.handlers.set("/api/meta", (_req, res) => json(res, { serverId: "remote-A", apiContract: 1 }))
  remote.state.handlers.set(STATUS, (_req, res) => json(res, valid))
  remote.state.handlers.set(LOGIN, (req, res) => { req.resume(); req.on("end", () => { res.setHeader("set-cookie", "codenomad_session=renewed-private; HttpOnly; Path=/"); json(res, { ok: true }) }) })
  remote.state.handlers.set(BUSINESS, (req, res) => { req.resume(); req.on("end", () => { res.writeHead(401, { "content-type": "text/plain", "retry-after": "7" }); res.end("native-401-sentinel") }) })
  const socket = (target: string, options: Parameters<typeof open>[2] = {}, proof?: string) => open(origin, `/api/backends/saved${target}`, { ...options, headers: { ...(proof ? { [AUTHORITY]: proof } : {}), ...options.headers } })
  const call = async (target: string, proof?: string, options: Parameters<typeof socket>[1] & { body?: string } = {}) => {
    const request = socket(target, options, proof); request.request.end(options.body)
    return bounded(request.response.then(read), 12000)
  }
  const admitted = await call("/api/meta", RELAY_BOOTSTRAP)
  assert.equal(admitted.status, 200)
  const proof = String(admitted.headers[AUTHORITY])
  assert.equal(/^[A-Za-z0-9_-]{43}$/.test(proof), true, "local proof format")
  const count = (route: string, method = "GET") => remote.state.requests.filter(req => req.path === route && req.method === method).length
  const saved = () => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
  const live = async () => {
    let upstream!: ServerResponse
    remote.state.handlers.set("/api/events", (_req, res) => { upstream = res; res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: initial\n\n") })
    const stream = socket("/api/events", {}, proof)
    stream.request.end()
    const response = await bounded(stream.response)
    response.on("error", () => {})
    t.after(() => stream.request.destroy())
    const initial = deferred<void>()
    response.once("data", () => initial.resolve())
    await bounded(initial.promise)
    const closed = deferred<void>(); response.once("close", () => closed.resolve())
    return { response, closed: closed.promise, tick: async () => {
      const next = deferred<string>(); response.once("data", chunk => next.resolve(String(chunk)))
      upstream.write("data: still-live\n\n")
      assert.equal(await bounded(next.promise), "data: still-live\n\n")
    } }
  }
  return { remote, manager, profiles, file, origin, proof, call, socket, count, saved, live, logs }
}

for (const kind of ["password", "anonymous", "session", "device"] as const) {
  test(`1: native 401 with live ${kind} retains proof, private identity and SSE`, async t => {
    const secret = kind === "password" ? password : kind === "anonymous" ? null : { kind, cookie: "codenomad_session=private-device-or-session" } as CodeNomadServerSecret
    const f = await fixture(t, secret, kind !== "password")
    const saved = f.saved(), stream = await f.live()
    const result = await f.call(BUSINESS, f.proof)
    assert.equal(result.status, 401); assert.equal(result.body, "native-401-sentinel")
    assert.equal(result.headers["retry-after"], "7")
    assert.equal(f.count(BUSINESS), 1); assert.equal(f.count(STATUS), 1); assert.equal(f.count(LOGIN, "POST"), 0)
    assert.equal(f.saved() === saved, true, "identity retained")
    f.manager.assertProof("saved", f.proof)
    await stream.tick()
    const observation = f.remote.state.requests.find(req => req.path === STATUS)!
    assert.equal(observation.headers.cookie === secret?.cookie, true, "status uses original private session")
  })
}

for (const restore of [false, true]) for (const variant of ["GET", "POST-empty", "POST-payload", "upload"]) {
  test(`2/3: zero replay ${variant}, private restoration=${restore}`, async t => {
    const f = await fixture(t), stream = await f.live()
    let statuses = 0
    f.remote.state.handlers.set(STATUS, (_req, res) => json(res, restore && ++statuses === 1 ? { authenticated: false } : valid))
    let result: Awaited<ReturnType<typeof f.call>>
    if (variant === "upload") {
      const entered = deferred<void>(), release = deferred<void>()
      f.remote.state.handlers.set(BUSINESS, (req, res) => {
        req.once("data", () => entered.resolve()); req.resume()
        req.once("end", () => { void release.promise.then(() => { res.writeHead(401); res.end("native-401-sentinel") }) })
      })
      const socket = f.socket(BUSINESS, { method: "POST", headers: { "content-type": "application/octet-stream" } }, f.proof)
      t.after(() => socket.request.destroy())
      socket.request.write("first-effect")
      await bounded(entered.promise)
      assert.equal(socket.request.writableEnded, false)
      socket.request.end("last-effect"); release.resolve()
      result = await bounded(socket.response.then(read))
    } else result = await f.call(BUSINESS, f.proof, { method: variant === "GET" ? "GET" : "POST", body: variant === "POST-payload" ? "effect" : undefined })
    assert.equal(result.status, 401); assert.equal(result.body, "native-401-sentinel")
    assert.equal(f.count(BUSINESS, variant === "GET" ? "GET" : "POST"), 1)
    assert.equal(f.count(STATUS), restore ? 2 : 1); assert.equal(f.count(LOGIN, "POST"), restore ? 1 : 0)
    f.manager.assertProof("saved", f.proof); await stream.tick()
    if (restore) assert.equal(f.saved().includes("renewed-private"), true, "rotation persisted privately")
  })
}

test("1/8: opted-in metadata JSON path preserves its 401 without publishing or revoking proof", async t => {
  const f = await fixture(t), stream = await f.live(), saved = f.saved()
  f.remote.state.handlers.set("/api/meta", (_req, res) => json(res, { marker: "native-metadata-401" }, 401))
  const before = f.count("/api/meta")
  const result = await f.call("/api/meta", RELAY_BOOTSTRAP)
  assert.equal(result.status, 401); assert.deepEqual(JSON.parse(result.body), { marker: "native-metadata-401" })
  assert.equal(result.headers[AUTHORITY], undefined)
  assert.equal(f.count("/api/meta") - before, 1); assert.equal(f.count(STATUS), 1); assert.equal(f.count(LOGIN, "POST"), 0)
  assert.equal(f.saved() === saved, true)
  f.manager.assertProof("saved", f.proof); await stream.tick()
})

test("2/3: direct bodyless POST and no-cookie initial login share the one-login quota", async t => {
  const f = await fixture(t)
  for (const cookie of [password.cookie, undefined]) {
    const before = { login: f.count(LOGIN, "POST"), status: f.count(STATUS), business: f.count(BUSINESS, "POST") }
    let status = 0, rejected = 0
    f.remote.state.handlers.set(STATUS, (_req, res) => json(res, { authenticated: ++status > 1 }))
    const client: CodeNomadServerClient = new CodeNomadServerClient(f.remote.origin, { ...password, cookie }, { onRejected: () => { rejected++ } })
    t.after(() => client.close())
    if (cookie) {
      const response: Response = await client.fetch(BUSINESS, { method: "POST" }, "observe-status")
      assert.equal(response.status, 401); assert.equal(await response.text(), "native-401-sentinel")
      assert.equal(rejected, 0)
    } else await assert.rejects(client.fetch(BUSINESS, { method: "POST" }, "observe-status"), { code: "auth" })
    assert.equal(f.count(LOGIN, "POST") - before.login, 1)
    assert.equal(f.count(STATUS) - before.status, cookie ? 2 : 1)
    assert.equal(f.count(BUSINESS, "POST") - before.business, 1)
  }
})

for (const rejection of ["false", "pairing", "login400", "login401"]) {
  test(`4: explicit ${rejection} revokes only its profile and refuses stale proof before IO`, async t => {
    const f = await fixture(t), stream = await f.live()
    const other = await startFakeCodeNomad({ anonymous: true }); t.after(() => other.close())
    other.state.overrides.set("/api/meta", { status: 200, body: { serverId: "B" } })
    f.profiles.push({ id: "other", baseUrl: other.origin, skipTlsVerify: false })
    const b = await f.manager.relay("other", "/api/meta", {}, RELAY_BOOTSTRAP)
    const bProof = b.headers.get(AUTHORITY)!; await b.text()
    f.remote.state.handlers.set(STATUS, (_req, res) => json(res, { authenticated: false, ...(rejection === "pairing" ? { pairingRequired: true } : {}) }))
    if (rejection.startsWith("login")) f.remote.state.handlers.set(LOGIN, (req, res) => { req.resume(); json(res, {}, Number(rejection.slice(5))) })
    const result = await f.call(BUSINESS, f.proof)
    assert.equal(result.status, 401); assert.deepEqual(JSON.parse(result.body), { error: "auth" })
    await bounded(stream.closed)
    assert.equal(new CodeNomadServerCredentials(f.file).has("saved", f.remote.origin), false)
    const before = f.remote.state.requests.length
    assert.equal((await f.call(STATUS, f.proof)).status, 502)
    assert.equal(f.remote.state.requests.length, before)
    f.manager.assertProof("other", bProof)
    const healthy = await f.manager.relay("other", STATUS, {}, bProof)
    assert.equal(healthy.status, 200); await healthy.text()
    assert.equal(f.count(LOGIN, "POST"), rejection === "pairing" ? 0 : 1)
  })
}

test("4: late old status/login cannot clear or overwrite a replacement owner", async t => {
  for (const stage of ["status", "login"]) {
    const f = await fixture(t), entered = deferred<void>(), release = deferred<void>()
    const stream = await f.live()
    f.remote.state.handlers.set(STATUS, (_req, res) => stage === "status"
      ? (entered.resolve(), void release.promise.then(() => json(res, { authenticated: false, pairingRequired: true })))
      : json(res, { authenticated: false }))
    if (stage === "login") f.remote.state.handlers.set(LOGIN, (req, res) => { req.resume(); entered.resolve(); void release.promise.then(() => { res.setHeader("set-cookie", "codenomad_session=late-old-private"); json(res, {}) }) })
    const pending = f.call(BUSINESS, f.proof)
    await bounded(entered.promise)
    await f.manager.forget("saved"); await bounded(stream.closed)
    f.remote.state.handlers.set(STATUS, (_req, res) => json(res, valid))
    f.remote.state.handlers.set(LOGIN, (req, res) => { req.resume(); req.on("end", () => { res.setHeader("set-cookie", "codenomad_session=new-owner-private"); json(res, {}) }) })
    const connected = await f.call(LOGIN, undefined, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "codenomad", password: "replacement-private" }) })
    assert.equal(connected.status, 200)
    const next = await f.call("/api/meta", RELAY_BOOTSTRAP), proof = String(next.headers[AUTHORITY]), saved = f.saved()
    assert.equal(proof === f.proof, false)
    release.resolve(); await pending
    // An independent HTTP round trip fences released continuations without sleeps.
    assert.equal((await f.call(STATUS, proof)).status, 200)
    assert.equal(f.saved() === saved, true, "late completion leaves new identity intact")
    f.manager.assertProof("saved", proof)
  }
})

test("5/8: distinct HTTP followers and direct status coalesce; cancelling first preserves the others", async t => {
  const f = await fixture(t), entered = deferred<void>(), headers = deferred<void>(), body = deferred<void>()
  let business = 0
  const businesses = deferred<void>()
  f.remote.state.handlers.set(BUSINESS, (req, res) => { req.resume(); req.on("end", () => { if (++business === 3) businesses.resolve(); res.writeHead(401); res.end("native-401-sentinel") }) })
  f.remote.state.handlers.set(STATUS, (_req, res) => { entered.resolve(); void headers.promise.then(() => { res.writeHead(200, { "content-type": "application/json" }); res.write('{"authenticated":'); void body.promise.then(() => res.end("true}")) }) })
  const first = f.socket(STATUS, {}, f.proof); first.request.end()
  await bounded(entered.promise)
  const remaining = [f.call(BUSINESS, f.proof), f.call(BUSINESS, f.proof), f.call(BUSINESS, f.proof), f.call(STATUS, f.proof), f.call(STATUS, f.proof)]
  await bounded(businesses.promise)
  first.request.destroy(); headers.resolve(); body.resolve()
  const results = await Promise.all(remaining)
  assert.deepEqual(results.map(result => result.status), [401, 401, 401, 200, 200])
  assert.equal(f.count(STATUS), 1); assert.equal(f.count(LOGIN, "POST"), 0)
  f.manager.assertProof("saved", f.proof)
  assert.equal((await f.call(STATUS, f.proof)).status, 200)
  assert.equal(f.count(STATUS), 2, "completed verdict is not an authorization cache")
})

test("5: cancelling all followers aborts the shared exchange and forbids follow-up login", async t => {
  const f = await fixture(t), entered = deferred<void>(), closed = deferred<void>(), release = deferred<void>()
  f.remote.state.handlers.set(STATUS, (_req, res) => { entered.resolve(); res.once("close", () => closed.resolve()); void release.promise.then(() => json(res, { authenticated: false })) })
  const first = f.socket(STATUS, {}, f.proof); first.request.end()
  await bounded(entered.promise)
  first.request.destroy(); await bounded(closed.promise)
  release.resolve()
  assert.equal((await f.call("/api/meta", f.proof)).status, 200)
  assert.equal(f.count(STATUS), 1); assert.equal(f.count(LOGIN, "POST"), 0)
  f.manager.assertProof("saved", f.proof)
})

test("5: a pre-existing private login is shared by bodyless POST and direct status followers", async t => {
  const f = await fixture(t), entered = deferred<void>(), release = deferred<void>()
  f.remote.state.handlers.set(LOGIN, (req, res) => {
    req.resume(); entered.resolve()
    void release.promise.then(() => { res.setHeader("set-cookie", "codenomad_session=shared-login-private"); json(res, {}) })
  })
  const client = new CodeNomadServerClient(f.remote.origin, password)
  t.after(() => client.close())
  const login = client.login()
  await bounded(entered.promise)
  const first = new AbortController(), second = new AbortController()
  const direct = client.fetch(STATUS, { signal: first.signal }, "observe-status")
  const business = client.fetch(BUSINESS, { method: "POST", signal: second.signal }, "observe-status")
  const businessEntered = deferred<void>()
  f.remote.state.handlers.set(BUSINESS, (req, res) => { req.resume(); businessEntered.resolve(); res.writeHead(401); res.end("native-401-sentinel") })
  await bounded(businessEntered.promise)
  release.resolve()
  const results = await bounded(Promise.all([direct, business]))
  await login
  assert.equal(results[0]!.status, 200); await results[0]!.text()
  assert.equal(results[1]!.status, 401); assert.equal(await results[1]!.text(), "native-401-sentinel")
  assert.equal(f.count(LOGIN, "POST"), 1); assert.equal(f.count(STATUS), 1); assert.equal(f.count(BUSINESS, "POST"), 1)
})

test("6: real eight-second episode bounds status headers/body, login headers and second status", { timeout: 15000 }, async t => {
  await Promise.all(["headers", "body", "login", "second"].map(async stage => {
    const f = await fixture(t), entered = deferred<void>(), release = deferred<void>()
    let statuses = 0
    const hold = (res: ServerResponse) => { entered.resolve(); void release.promise.then(() => { if (!res.destroyed) json(res, valid) }) }
    f.remote.state.handlers.set(STATUS, (_req, res) => {
      statuses++
      if (stage === "headers" || stage === "second" && statuses === 2) return hold(res)
      if (stage === "body") { entered.resolve(); res.writeHead(200, { "content-type": "application/json" }); res.write('{"authenticated":'); void release.promise.then(() => res.end("true}")); return }
      json(res, { authenticated: false })
    })
    if (stage === "login") f.remote.state.handlers.set(LOGIN, (req, res) => { req.resume(); hold(res) })
    const saved = f.saved(), started = performance.now()
    const pending = f.call(BUSINESS, f.proof)
    await bounded(entered.promise)
    const result = await pending, elapsed = performance.now() - started
    assert.equal(result.status, 401); assert.equal(result.body, "native-401-sentinel")
    // Real deadline with a declared +3s CI scheduling tolerance, never a fake clock.
    assert(elapsed >= 7600 && elapsed < 11000, `eight-second deadline (${stage})`)
    const counts = [f.count(STATUS), f.count(LOGIN, "POST")]
    assert.equal(counts[0], stage === "second" ? 2 : 1)
    assert.equal(counts[1], ["login", "second"].includes(stage) ? 1 : 0)
    release.resolve()
    assert.equal((await f.call("/api/meta", f.proof)).status, 200)
    assert.deepEqual([f.count(STATUS), f.count(LOGIN, "POST")], counts)
    assert.equal(f.saved() === saved || stage === "second", true, "unknown preserves credentials")
    f.manager.assertProof("saved", f.proof)
  }))
})

test("6: login response body may remain open without unbounded cleanup", async t => {
  const f = await fixture(t), release = deferred<void>()
  let statuses = 0
  f.remote.state.handlers.set(STATUS, (_req, res) => json(res, ++statuses === 1 ? { authenticated: false } : valid))
  f.remote.state.handlers.set(LOGIN, (req, res) => { req.resume(); res.writeHead(200, { "content-type": "application/json", "set-cookie": "codenomad_session=bounded-login-private" }); res.write("{"); void release.promise.then(() => res.end("}")) })
  const result = await bounded(f.call(BUSINESS, f.proof))
  assert.equal(result.status, 401); assert.equal(f.count(STATUS), 2); assert.equal(f.count(LOGIN, "POST"), 1)
  release.resolve(); f.manager.assertProof("saved", f.proof)
})

test("6: initial and pre-existing login waits consume the real eight-second budget", { timeout: 15000 }, async t => {
  await Promise.all(["initial", "existing"].map(async kind => {
    const f = await fixture(t), entered = deferred<void>(), closed = deferred<void>(), release = deferred<void>()
    f.remote.state.handlers.set(LOGIN, (req, res) => {
      req.resume(); entered.resolve(); res.once("close", () => closed.resolve())
      void release.promise.then(() => { if (!res.destroyed) { res.setHeader("set-cookie", "codenomad_session=too-late-private"); json(res, {}) } })
    })
    let persisted = 0, rejected = 0
    const client = new CodeNomadServerClient(f.remote.origin, kind === "initial" ? { ...password, cookie: undefined } : password,
      { onSecretChanged: () => { persisted++ }, onRejected: () => { rejected++ } })
    t.after(() => client.close())
    const previous = kind === "existing" ? client.login().then(() => "ok", () => "cancelled") : undefined
    if (previous) await bounded(entered.promise)
    const started = performance.now()
    const pending = client.fetch(kind === "initial" ? BUSINESS : STATUS, {}, "observe-status").then(() => "unexpected-success", () => "unreachable")
    await bounded(entered.promise)
    assert.equal(await bounded(pending, 11000), "unreachable")
    const elapsed = performance.now() - started
    assert(elapsed >= 7600 && elapsed < 11000, `${kind} login shares deadline`)
    assert.equal(f.count(LOGIN, "POST"), 1); assert.equal(f.count(STATUS), 0); assert.equal(f.count(BUSINESS), 0)
    assert.equal(persisted, 0); assert.equal(rejected, 0)
    client.close(); await bounded(closed.promise); release.resolve()
    if (previous) await previous
    assert.equal((await f.call("/api/meta", f.proof)).status, 200)
    assert.equal(f.count(LOGIN, "POST"), 1); assert.equal(f.count(STATUS), 0)
    assert.equal(persisted, 0); assert.equal(rejected, 0)
  }))
})

test("6: late business 401 cannot restart auth budget; successful business and SSE outlive it", { timeout: 15000 }, async t => {
  const f = await fixture(t), stream = await f.live(), saved = f.saved()
  const businessEntered = deferred<void>(), successEntered = deferred<void>(), statusEntered = deferred<void>(), release = deferred<void>()
  f.remote.state.handlers.set(BUSINESS, (req, res) => {
    req.resume(); businessEntered.resolve()
    void release.promise.then(() => { res.writeHead(401); res.end("native-401-sentinel") })
  })
  f.remote.state.handlers.set("/api/test/success", (_req, res) => { successEntered.resolve(); void release.promise.then(() => { res.writeHead(200); res.end("late-success") }) })
  f.remote.state.handlers.set(STATUS, (_req, res) => { statusEntered.resolve(); void release.promise.then(() => { if (!res.destroyed) json(res, valid) }) })
  const started = performance.now()
  const business = f.call(BUSINESS, f.proof), success = f.call("/api/test/success", f.proof)
  await bounded(Promise.all([businessEntered.promise, successEntered.promise]))
  const status = f.call(STATUS, f.proof)
  await bounded(statusEntered.promise)
  assert.equal((await status).status, 502)
  const elapsed = performance.now() - started
  assert(elapsed >= 7600 && elapsed < 11000, "admitted business owns the original eight-second deadline")
  release.resolve()
  const [failed, completed] = await Promise.all([business, success])
  assert.equal(failed.status, 401); assert.equal(failed.body, "native-401-sentinel")
  assert.equal(completed.status, 200); assert.equal(completed.body, "late-success")
  assert.equal(f.count(STATUS), 1); assert.equal(f.count(LOGIN, "POST"), 0); assert.equal(f.count(BUSINESS), 1)
  assert.equal(f.saved() === saved, true)
  f.manager.assertProof("saved", f.proof); await stream.tick()
})

test("7/8: strict unknown observations retain proof, vault and live SSE; direct status never becomes false", async t => {
  const f = await fixture(t), stream = await f.live(), saved = f.saved()
  const invalid: Array<{ name: string; body?: Buffer | string; mime?: string; code?: number; reset?: boolean; gzip?: boolean }> = [
    { name: "502", body: "{}", code: 502 }, { name: "reset", reset: true },
    { name: "invalid-json", body: "{" }, { name: "mime", body: JSON.stringify(valid), mime: "text/plain" },
    ...[{}, [], true, { authenticated: "true" }, { authenticated: true, unexpected: 1 }, { authenticated: true, pairingRequired: true }, { authenticated: false, username: "x", passwordUserProvided: true }, { authenticated: true, username: "x" }].map((value, i) => ({ name: `schema-${i}`, body: JSON.stringify(value) })),
    { name: "invalid-utf8", body: Buffer.concat([Buffer.from('{"authenticated":true,"username":"'), Buffer.from([0xc3, 0x28]), Buffer.from('","passwordUserProvided":true}')]) },
    { name: "4097-chunked", body: JSON.stringify({ authenticated: true }) + " ".repeat(4097 - JSON.stringify({ authenticated: true }).length) },
    { name: "4097-gzip", body: JSON.stringify({ authenticated: true }) + " ".repeat(4097 - JSON.stringify({ authenticated: true }).length), gzip: true },
    { name: "truncated", body: '{"authenticated":' },
  ]
  for (const sample of invalid) {
    f.remote.state.handlers.set(STATUS, (req, res) => {
      if (sample.reset) { req.socket.destroy(); return }
      res.writeHead(sample.code ?? 200, { "content-type": sample.mime ?? "application/json", ...(sample.gzip ? { "content-encoding": "gzip" } : {}) })
      const body = sample.gzip ? gzipSync(sample.body!) : Buffer.from(sample.body!)
      res.write(body.subarray(0, Math.min(12, body.length))); res.end(body.subarray(Math.min(12, body.length)))
    })
    const business = await f.call(BUSINESS, f.proof)
    assert.equal(business.status, 401, sample.name); assert.equal(business.body, "native-401-sentinel", sample.name)
    const direct = await f.call(STATUS, f.proof)
    assert.equal(direct.status, 502, sample.name); assert.deepEqual(JSON.parse(direct.body), { error: "unreachable" }, sample.name)
    assert.equal(f.saved() === saved, true, `${sample.name}: private identity retained`)
    f.manager.assertProof("saved", f.proof); await stream.tick()
  }
  assert.equal(f.count(LOGIN, "POST"), 0)
  for (const size of [4096]) {
    const text = JSON.stringify(valid)
    f.remote.state.handlers.set(STATUS, (_req, res) => { res.writeHead(200, { "content-type": "application/json; charset=utf-8" }); res.write(text); res.end(" ".repeat(size - Buffer.byteLength(text))) })
    const direct = await f.call(STATUS, f.proof)
    assert.equal(direct.status, 200); assert.deepEqual(JSON.parse(direct.body), valid)
  }
})

test("8: bootstrap status observes once and explicit pairing publishes valid false", async t => {
  const f = await fixture(t)
  assert.deepEqual(JSON.parse((await f.call(STATUS, RELAY_BOOTSTRAP)).body), valid)
  assert.equal(f.count(STATUS), 1)
  f.remote.state.handlers.set(STATUS, (_req, res) => json(res, { authenticated: false, pairingRequired: true }))
  const result = await f.call(STATUS, f.proof)
  assert.equal(result.status, 200); assert.deepEqual(JSON.parse(result.body), { authenticated: false, pairingRequired: true })
  assert.equal(f.count(STATUS), 2); assert.equal(f.count(LOGIN, "POST"), 0)
  const before = f.remote.state.requests.length
  assert.equal((await f.call(STATUS, f.proof)).status, 502)
  assert.equal(f.remote.state.requests.length, before)
})

test("7: HTTPS certificate failure remains tls_error and preserves the private vault", async t => {
  const f = await fixture(t)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-auth-status-tls-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const logger = { info() {}, warn() {}, error() {}, child() { return logger } } as unknown as Logger
  const tls = resolveHttpsOptions({ enabled: true, configDir: directory, host: "localhost", logger })!
  const remote = await startFakeCodeNomad({ anonymous: true, tls: tls.httpsOptions })
  t.after(() => remote.close())
  const file = path.join(directory, "remote-server-credentials.json")
  new CodeNomadServerCredentials(file).set("tls", remote.origin, password)
  const manager = new RemoteServerBrowseManager({ getOwner: () => ({ remoteServers: [{ id: "tls", baseUrl: remote.origin }] }), configYamlPathForAuthority: () => path.join(directory, "config.yaml") })
  t.after(() => manager.close())
  const app = Fastify()
  let origin = ""
  registerBackendRelayRoutes(app, { manager, getSelfOrigins: () => new Set([origin]) })
  origin = await app.listen({ host: "127.0.0.1", port: 0 })
  t.after(async () => { app.server.closeAllConnections(); await app.close() })
  const saved = fs.readFileSync(file, "utf8")
  const socket = open(origin, `/api/backends/tls${STATUS}`, { headers: { [AUTHORITY]: RELAY_BOOTSTRAP } }); socket.request.end()
  const result = await bounded(socket.response.then(read))
  assert.equal(result.status, 502); assert.deepEqual(JSON.parse(result.body), { error: "tls_error" })
  assert.equal(fs.readFileSync(file, "utf8") === saved, true, "TLS uncertainty preserves credentials")
  assert.equal(remote.state.requests.length, 0)
  f.manager.assertProof("saved", f.proof)
})

test("9: private headers and credentials never cross response/log/redirect boundaries", async t => {
  const f = await fixture(t), saved = f.saved()
  f.remote.state.handlers.set(BUSINESS, (req, res) => {
    assert.equal(req.headers.cookie === password.cookie, true, "only backend private cookie arrives")
    for (const header of ["authorization", AUTHORITY, "origin", "referer"]) assert.equal(req.headers[header], undefined)
    req.resume(); res.writeHead(401, { "content-type": "text/plain", "set-cookie": "private_rotation=response-private", authorization: "response-private", [AUTHORITY]: "forged-private" }); res.end("native-401-sentinel")
  })
  const result = await f.call(BUSINESS, f.proof, { headers: { cookie: "caller=caller-private", authorization: "Bearer caller-private" } })
  assert.equal(result.status, 401)
  for (const header of ["set-cookie", "authorization", AUTHORITY]) assert.equal(result.headers[header], undefined)
  const other = await startFakeCodeNomad({ anonymous: true }); t.after(() => other.close())
  const beforeRedirect = f.saved()
  f.remote.state.handlers.set("/api/test/redirect", (_req, res) => { res.writeHead(302, { location: `${other.origin}/api/meta`, "set-cookie": "codenomad_session=redirect-private" }); res.end() })
  assert.equal((await f.call("/api/test/redirect", f.proof)).status, 502)
  assert.equal(other.state.requests.length, 0); assert.equal(f.saved() === beforeRedirect, true)
  assert.equal(saved.includes(f.proof), false)
  const logs = JSON.stringify(f.logs)
  for (const value of ["private-test-password", "initial-private", "caller-private", "response-private", "redirect-private", f.proof]) assert.equal(logs.includes(value), false, "diagnostics omit private values")
  if (process.platform !== "win32") assert.equal(fs.statSync(f.file).mode & 0o777, 0o600)
})

test("10: observation and legacy recovery alternate on the exact same client", async t => {
  const f = await fixture(t)
  const client = new CodeNomadServerClient(f.remote.origin, password)
  t.after(() => client.close())
  for (const observed of [true, false, true, false]) {
    let dispatches = 0
    f.remote.state.handlers.set(BUSINESS, (req, res) => { req.resume(); json(res, { marker: "native" }, ++dispatches === 1 ? 401 : 200) })
    const beforeStatus = f.count(STATUS), beforeLogin = f.count(LOGIN, "POST")
    const result = await client.fetch(BUSINESS, {}, observed ? "observe-status" : undefined)
    assert.equal(result.status, observed ? 401 : 200); await result.text()
    assert.equal(dispatches, observed ? 1 : 2)
    assert.equal(f.count(STATUS) - beforeStatus, observed ? 1 : 0)
    assert.equal(f.count(LOGIN, "POST") - beforeLogin, observed ? 0 : 1)
  }
})
