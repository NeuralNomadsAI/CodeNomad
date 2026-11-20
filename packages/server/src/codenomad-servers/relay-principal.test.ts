import assert from "node:assert/strict"
import http from "node:http"
import path from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { backendAdmissionFixture, backendAuthorityHeader, backendBootstrap } from "../remote-control/test-support/backend-admission"
import { DEVICE_COOKIE_NAME } from "../remote-control/gate"
import { FAKE_TUNNEL_HOST, startRemoteSurface } from "../remote-control/test-support/surface"
import { CodeNomadServerClient } from "./client"
import { CodeNomadServerCredentials } from "./credentials"

const PUBLIC = "https://ui.example.test"
type Caller = { address: string; headers: Record<string, string> }

async function call(caller: Caller, path: string, method = "GET", payload?: unknown) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const request = http.request(`http://${caller.address}${path}`, {
      method, agent: false, headers: { ...caller.headers, ...(payload ? { "content-type": "application/json" } : {}) },
    }, response => {
      let body = ""
      response.on("data", chunk => { body += chunk })
      response.on("error", reject)
      response.on("end", () => resolve({ status: response.statusCode!, body, headers: response.headers }))
    })
    request.on("error", reject)
    request.end(payload ? JSON.stringify(payload) : undefined)
  })
}

async function fixture(t: test.TestContext, options: Parameters<typeof startRemoteSurface>[1] = {}) {
  const backend = await backendAdmissionFixture(t)
  const upstreams = new Map<string, { closed: boolean; ticks: number }>()
  backend.remotes[0]!.state.handlers.set("/api/events", (request, response) => {
    const id = new URL(request.url!, "http://test").searchParams.get("stream")!
    const state = { closed: false, ticks: 0 }
    upstreams.set(id, state)
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write("data: open\n\n")
    const timer = setInterval(() => { state.ticks++; response.write("data: confidential-tick\n\n") }, 20)
    response.on("close", () => { clearInterval(timer); state.closed = true })
  })
  const surface = await startRemoteSurface(t, { settings: backend.settings, allowedOrigins: [PUBLIC], ...options })
  const session = (username = "codenomad"): Caller => ({
    address: surface.local,
    headers: { host: "ui.example.test", origin: PUBLIC,
      cookie: `${surface.authManager.getCookieName()}=${surface.authManager.createSession(username).id}` },
  })
  const direct = async () => {
    const pairing = surface.manager.createDirectPairing(PUBLIC)
    const response = await call({ address: surface.local, headers: { host: "ui.example.test", origin: PUBLIC } },
      "/api/remote-control/pair", "POST", { code: new URL(pairing.url).hash.slice(1) })
    assert.equal(response.status, 200, response.body)
    return { caller: { address: surface.local, headers: { host: "ui.example.test", origin: PUBLIC,
      cookie: String(response.headers["set-cookie"]).split(";")[0]! } }, id: JSON.parse(response.body).device.id as string }
  }
  const stream = async (caller: Caller, id: string) => {
    const meta = await call({ ...caller, headers: { ...caller.headers, [backendAuthorityHeader]: backendBootstrap } }, "/api/backends/A/api/meta")
    assert.equal(meta.status, 200, meta.body)
    const state = { bytes: 0, closed: false }
    await new Promise<void>((resolve, reject) => {
      const request = http.get(`http://${caller.address}/api/backends/A/api/events?stream=${id}`, {
        agent: false, headers: { ...caller.headers, [backendAuthorityHeader]: String(meta.headers[backendAuthorityHeader]) },
      }, response => {
        if (response.statusCode !== 200) { response.resume(); reject(new Error(`stream status ${response.statusCode}`)); return }
        response.on("data", chunk => { state.bytes += chunk.length; resolve() })
        response.on("error", () => undefined) // Revocation aborts a response with unread SSE bytes.
        response.on("close", () => { state.closed = true })
      })
      request.on("error", reject)
      t.after(() => request.destroy())
    })
    return state
  }
  return { ...surface, session, direct, stream, upstreams }
}

async function stopped(f: Awaited<ReturnType<typeof fixture>>, id: string, stream: { bytes: number; closed: boolean }) {
  const deadline = Date.now() + 1800
  while ((!stream.closed || !f.upstreams.get(id)?.closed) && Date.now() < deadline) await delay(20)
  assert.equal(stream.closed, true, "client stream must close within 1800 ms")
  assert.equal(f.upstreams.get(id)?.closed, true, "upstream must close within 1800 ms")
  const before = { bytes: stream.bytes, ticks: f.upstreams.get(id)!.ticks }
  await delay(100)
  assert.deepEqual({ bytes: stream.bytes, ticks: f.upstreams.get(id)!.ticks }, before, "publication and upstream production stop")
}

async function alive(stream: { bytes: number; closed: boolean }) {
  const before = stream.bytes
  const deadline = Date.now() + 1800
  while (!stream.closed && stream.bytes === before && Date.now() < deadline) await delay(20)
  assert.equal(stream.closed, false, "unrelated principal stays connected")
  assert.ok(stream.bytes > before, "unrelated principal keeps receiving bytes")
}

test("logout closes only its principal's real HTTP relay and upstream", async t => {
  const f = await fixture(t)
  const caller = f.session()
  const target = await f.stream(caller, "logout")
  const other = await f.stream(f.session(), "other")
  const response = await call(caller, "/api/auth/logout", "POST")
  assert.equal(response.status, 200)
  assert.equal(JSON.parse((await call(caller, "/api/auth/status")).body).authenticated, false)
  await stopped(f, "logout", target)
  await alive(other)
})

for (const kind of ["idle", "absolute"] as const) {
  test(`${kind} expiry closes an otherwise idle real HTTP relay without another auth request`, async t => {
    const f = await fixture(t, kind === "idle" ? { sessionIdleMs: 800 } : { sessionIdleMs: 5000, sessionAbsoluteMs: 800 })
    const target = await f.stream(f.session(), kind)
    const other = await f.stream((await f.direct()).caller, "other")
    await stopped(f, kind, target)
    await alive(other)
  })
}

test("successful persistent password change closes all user relays, preserving another principal", async t => {
  const f = await fixture(t, { password: null })
  await f.authManager.setPassword("initial-password")
  const first = await f.stream(f.session(), "first")
  const second = await f.stream(f.session(), "second")
  const other = await f.stream((await f.direct()).caller, "other")
  const response = await call({ address: f.local, headers: { ...f.session().headers, host: "localhost:0", origin: "http://localhost:0" } },
    "/api/auth/password", "POST", { password: "replacement-password" })
  assert.equal(response.status, 200, response.body)
  assert.equal(await f.authManager.validateLogin("codenomad", "replacement-password"), true)
  await stopped(f, "first", first)
  await stopped(f, "second", second)
  await alive(other)
})

test("device revocation closes its relay and upstream without closing another device", async t => {
  const f = await fixture(t)
  const device = await f.direct()
  const target = await f.stream(device.caller, "device")
  const other = await f.stream((await f.direct()).caller, "other")
  assert.equal(f.manager.revokeDevice(device.id), true)
  await stopped(f, "device", target)
  await alive(other)
})

test("direct device idle expiry closes its relay without refreshing device activity or another session", async t => {
  let now = Date.now()
  const f = await fixture(t, { now: () => now })
  const target = await f.stream((await f.direct()).caller, "expired-device")
  const other = await f.stream(f.session(), "other")
  now += 31 * 24 * 60 * 60 * 1000
  await stopped(f, "expired-device", target)
  await alive(other)
})

test("Remote Control stop closes ingress relay and upstream, preserving direct HTTPS device", async t => {
  const f = await fixture(t)
  const paired = f.manager.exchangePairing(f.code, "test-browser")!
  assert.ok(paired)
  const target = await f.stream({ address: f.target(), headers: { host: FAKE_TUNNEL_HOST,
    origin: `https://${FAKE_TUNNEL_HOST}`, cookie: `${DEVICE_COOKIE_NAME}=${paired.token}` } }, "tunnel")
  const other = await f.stream((await f.direct()).caller, "other")
  await f.manager.stop()
  await stopped(f, "tunnel", target)
  await alive(other)
})

test("loopback relay retains local authority after the supplied session logs out", async t => {
  const f = await fixture(t)
  const caller = f.session()
  const local = { address: f.local, headers: { ...caller.headers, host: "localhost:0", origin: "http://localhost:0" } }
  const stream = await f.stream(local, "local")
  assert.equal((await call(caller, "/api/auth/logout", "POST")).status, 200)
  await alive(stream)
})

test("logout cancels only its no-proof relay while another principal borrows the same password login", { timeout: 6000 }, async t => {
  const backend = await backendAdmissionFixture(t)
  const remote = backend.remotes[0]!
  new CodeNomadServerCredentials(path.join(backend.directory, "remote-server-credentials.json"))
    .set("A", remote.origin, { kind: "password", username: "codenomad", password: "remote-password" })
  let releaseLogin: (() => void) | undefined
  let loginCalls = 0
  remote.state.handlers.set("/api/auth/login", (_request, response) => {
    loginCalls++
    releaseLogin = () => {
      response.writeHead(200, { "content-type": "application/json", "set-cookie": "codenomad_session=shared-login; Path=/" })
      response.end('{"ok":true}')
    }
  })
  const f = await startRemoteSurface(t, { settings: backend.settings, allowedOrigins: [PUBLIC] })
  const principal = (): Caller => ({ address: f.local, headers: { host: "ui.example.test", origin: PUBLIC,
    cookie: `${f.authManager.getCookieName()}=${f.authManager.createSession("codenomad").id}` } })
  let entries = 0
  const signals: (AbortSignal | null | undefined)[] = []
  const actualFetch = CodeNomadServerClient.prototype.fetch
  t.mock.method(CodeNomadServerClient.prototype, "fetch", function (this: CodeNomadServerClient, ...args: Parameters<typeof actualFetch>) {
    const pending = actualFetch.apply(this, args)
    if (args[0] === "/api/workspaces") { entries++; signals.push(args[1]?.signal) }
    return pending
  })
  const firstPrincipal = principal()
  const first = call(firstPrincipal, "/api/backends/A/api/workspaces").then(response => ({ response }), error => ({ error }))
  const firstDeadline = Date.now() + 2000
  while ((entries !== 1 || !releaseLogin) && Date.now() < firstDeadline) await delay(10)
  assert.equal(Number(entries), 1, "first principal enters before the second request starts")
  assert.ok(releaseLogin, "first principal is waiting on the held upstream login")
  const second = call(principal(), "/api/backends/A/api/workspaces").then(response => ({ response }), error => ({ error }))
  const deadline = Date.now() + 2000
  while ((entries !== 2 || !releaseLogin) && Date.now() < deadline) await delay(10)
  assert.equal(entries, 2, "both real HTTP requests entered the actual shared client")
  assert.ok(releaseLogin, "upstream login is held")
  assert.equal((await call(firstPrincipal, "/api/auth/logout", "POST")).status, 200)
  assert.equal(signals[0]?.aborted, true, "first principal lost its publication authority")
  assert.equal(signals[1]?.aborted, false, "second principal retains its operation")
  releaseLogin()
  const [cancelled, retained] = await Promise.all([first, second])
  assert.ok("error" in cancelled, "logged-out caller's HTTP operation is aborted")
  assert.ok("response" in retained, "authorized caller receives an HTTP response")
  assert.equal(retained.response.status, 200, retained.response.body)
  assert.deepEqual(JSON.parse(retained.response.body), [{ id: "same-workspace", server: "A" }])
  assert.equal(loginCalls, 1, "borrowers share one password login")
})
