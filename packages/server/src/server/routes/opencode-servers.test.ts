import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http"
import { once } from "node:events"
import { join } from "node:path"
import pino from "pino"
import dns from "node:dns/promises"
import { syncBuiltinESMExports } from "node:module"
import { setTimeout as delay } from "node:timers/promises"
import { startRemoteSurface, FAKE_TUNNEL_HOST } from "../../remote-control/test-support/surface"
import { SettingsService } from "../../settings/service"
import { resolveConfigLocation } from "../../config/location"
import { explicitContractFixture } from "../../opencode/compatibility/contract-fixture"
import { isOpenCodeServerAdminTarget } from "./opencode-servers"
import Fastify from "fastify"

function send(target: string, path: string, method: string, headers: Record<string, string>, payload: unknown) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const request = httpRequest(`http://${target}${path}`, { method, headers: { "content-type": "application/json", ...headers } }, response => {
      let body = ""
      response.setEncoding("utf8").on("data", chunk => { body += chunk }).on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body }))
    })
    request.on("error", reject); request.end(JSON.stringify(payload))
  })
}

async function fixture(t: test.TestContext, skipAuth = false) {
  const root = mkdtempSync(join(process.cwd(), ".tmp-admin-")), logs: string[] = [], calls: string[] = []
  const logger = pino({ level: "trace" }, { write: text => logs.push(text) })
  const settings = new SettingsService(resolveConfigLocation(join(root, "config.yaml")), undefined, logger)
  const local = { acquire: async () => { assert.fail("GET must not acquire local") }, existing: () => undefined,
    invalidate: () => { assert.fail("admin must not invalidate local") } }
  const owner = settings.getOpenCodeServerConnections(local)
  const upstream = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`)
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify(request.url === "/openapi.json" ? explicitContractFixture() : { version: "99.0.0", pid: 999, urls: [], paths: { tmp: "private" } }))
  })
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening")
  const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
  settings.getOpenCodeServerRegistry().replace([{ id: "saved", kind: "explicit", label: "Saved", origin }])
  await settings.getOpenCodeServerCredentials().set("saved", JSON.stringify({ username: "saved-user", password: "saved-password" }))
  const surface = await startRemoteSurface(t, { skipAuth, settings, logger, workspaceManager: { getServerConnections: () => owner } })
  const session = surface.authManager.createSession("codenomad")
  const cookie = `${surface.authManager.getCookieName()}=${session.id}`
  t.after(async () => { await owner.dispose(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); rmSync(root, { recursive: true, force: true }) })
  return { ...surface, root, settings, owner, origin, calls, logs, cookie }
}

for (const skipAuth of [false, true]) test(`host guard and real CSRF admission with auth ${skipAuth ? "disabled" : "enabled"}`, async t => {
  const f = await fixture(t, skipAuth)
  const headers = { cookie: f.cookie, host: f.local }
  const payload = { origin: f.origin, credentials: { username: "ephemeral-user", password: "ephemeral-password" } }
  for (const path of ["/api/opencode-servers", "/%61pi/opencode-servers", "/api/%6fpencode-servers"]) {
    for (const extra of [
      { origin: "https://foreign.test" }, { origin: "null" }, { origin: `http://${f.local}/` },
      { origin: "http://[invalid" }, { host: "rebound.attacker.test" },
      { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { "sec-fetch-site": "invalid" },
    ]) {
      const result = await f.app.inject({ method: "POST", url: `${path}/probe`, headers: { ...headers, ...extra }, payload, remoteAddress: "127.0.0.1" })
      assert.equal(result.statusCode, 403, JSON.stringify(extra)); assert.equal(result.headers["cache-control"], "no-store")
    }
    assert.equal((await f.app.inject({ method: "POST", url: `${path}/probe`, headers, payload, remoteAddress: "192.168.1.7" })).statusCode, 403)
  }
  assert.equal(f.calls.length, 0)
  const unauthenticated = await f.app.inject({ method: "GET", url: "/api/opencode-servers", headers: { host: f.local }, remoteAddress: "127.0.0.1" })
  assert.equal(unauthenticated.statusCode, skipAuth ? 200 : 401)
  for (const origin of [undefined, `http://${f.local}`, "http://localhost:3000"]) {
    const result = await f.app.inject({ method: "POST", url: "/api/opencode-servers/probe", headers: { ...headers, ...(origin ? { origin } : {}) }, payload, remoteAddress: "127.0.0.1" })
    assert.equal(result.statusCode, 200, result.body)
    assert.equal(result.json().version, "99.0.0")
    assert.equal(result.headers["www-authenticate"], undefined)
    assert.doesNotMatch(result.body, /ephemeral-|private|pid|urls/)
  }
  const actual = await send(f.local, "/api/opencode-servers/probe", "POST", { cookie: f.cookie }, payload)
  assert.equal(actual.status, 200, actual.body)
  assert.equal(JSON.parse(actual.body).version, "99.0.0")
  for (const origin of [`http://localhost:${f.local.split(":")[1]}`, `http://${f.local}`]) {
    assert.equal((await f.app.inject({ url: "/api/opencode-servers", headers: { ...headers, origin, "sec-fetch-site": "same-origin" }, remoteAddress: "127.0.0.1" })).statusCode, 200)
  }
  assert.equal((await f.app.inject({ url: "/api/test/echo", headers, remoteAddress: "127.0.0.1" })).statusCode, 200)
})

test("administrative GET projects live credential and connection owners with zero native work", async t => {
  const f = await fixture(t), headers = { cookie: f.cookie, host: f.local }
  const disk = readFileSync(join(f.root, "config.yaml"), "utf8")
  f.settings.getOpenCodeServerCredentials().readForConnection = async () => { assert.fail("GET must not read secrets") }
  const get = () => f.app.inject({ method: "GET", url: "/api/opencode-servers", headers, remoteAddress: "127.0.0.1" })
  let result = await get()
  assert.equal(result.statusCode, 200, result.body)
  assert.equal(result.json().servers[0].id, "local-shared")
  assert.deepEqual(result.json().servers[1], { kind: "explicit", id: "saved", label: "Saved", origin: f.origin, hasCredentials: true, needsCredentials: false, state: "unknown" })
  assert.deepEqual(result.json().limits, { explicitActiveTargets: 4, reservedLocalTargets: 1, activeExplicitTargets: 0 })
  await f.settings.getOpenCodeServerCredentials().clear("saved")
  result = await get(); assert.equal(result.json().servers[1].hasCredentials, false)
  f.owner.disconnect("saved")
  result = await get(); assert.equal(result.json().servers[1].state, "disconnected")
  assert.equal(f.calls.length, 0); assert.equal(readFileSync(join(f.root, "config.yaml"), "utf8"), disk)
  assert.doesNotMatch(result.body, /saved-user|saved-password|private|pid|binary/)
  for (const [url, payload] of [["/api/storage/config", { server: { opencodeServers: [] } }], ["/api/storage/config/server", { opencodeServers: [] }]] as const) {
    const response = await f.app.inject({ method: "PATCH", url, headers, payload, remoteAddress: "127.0.0.1" })
    assert.equal(response.statusCode, 400)
  }
  assert.equal(readFileSync(join(f.root, "config.yaml"), "utf8"), disk)
})

test("paired ingress cannot administer even with valid Origin and encoded route; generic PATCH stays closed", async t => {
  const f = await fixture(t)
  const pair = await send(f.target(), "/api/remote-control/pair", "POST", { host: FAKE_TUNNEL_HOST, origin: `https://${FAKE_TUNNEL_HOST}` }, { code: f.code })
  assert.equal(pair.status, 200, pair.body)
  const cookie = pair.headers["set-cookie"]![0]!.split(";")[0]!
  for (const path of ["/api/opencode-servers", "/%61pi/opencode-servers", "/api/%6fpencode-servers", "/api/opencode-servers/probe"]) {
    const response = await send(f.target(), path, "POST", { host: FAKE_TUNNEL_HOST, cookie, origin: `https://${FAKE_TUNNEL_HOST}` }, { origin: f.origin })
    assert.equal(response.status, 404, path)
  }
  for (const [url, payload] of [["/api/storage/config", { server: { opencodeServers: [] } }], ["/api/storage/config/server", { opencodeServers: [] }]] as const) {
    const response = await send(f.target(), url, "PATCH", { host: FAKE_TUNNEL_HOST, cookie, origin: `https://${FAKE_TUNNEL_HOST}` }, payload)
    assert.equal(response.status, 400)
  }
  assert.equal(f.calls.length, 0)
})

test("admin URL/body/header/parser/error diagnostics are redacted completely, including invalid encoded paths", async t => {
  const f = await fixture(t), sentinel = "sensitiveSentinel83"
  const headers = { host: f.local, cookie: f.cookie, authorization: sentinel, username: sentinel }
  for (const url of [`/api/opencode-servers/probe?${sentinel}=${sentinel}`, `/api/opencode-servers/${sentinel}`, `/%61pi/opencode-servers/%E0%A4%A?${sentinel}`]) {
    const response = await f.app.inject({ method: "POST", url, headers, payload: { origin: `https://${sentinel}:${sentinel}@invalid.test`, username: sentinel, password: sentinel }, remoteAddress: "127.0.0.1" })
    assert.doesNotMatch(response.body, new RegExp(sentinel)); assert.equal(response.headers["cache-control"], "no-store")
  }
  const parser = await f.app.inject({ method: "POST", url: "/api/opencode-servers/probe", headers: { ...headers, "content-type": "application/json" }, payload: `{"${sentinel}":`, remoteAddress: "127.0.0.1" })
  assert.equal(parser.statusCode, 400); assert.doesNotMatch(parser.body, new RegExp(sentinel))
  assert.doesNotMatch(f.logs.join("\n"), new RegExp(sentinel))
  assert.equal(f.calls.length, 0)
})

test("every failed administrative boundary precedes DNS, registry writes and secret access", async t => {
  const f = await fixture(t)
  let resolutions = 0
  const mocked = t.mock.method(dns, "lookup", async () => { resolutions++; throw new Error("unexpected fixture DNS") })
  syncBuiltinESMExports()
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports() })
  f.settings.getOpenCodeServerCredentials().readForConnection = async () => { assert.fail("candidate must not read stored credentials") }
  f.settings.getOpenCodeServerCredentials().set = async () => { assert.fail("candidate must not store credentials") }
  const before = readFileSync(join(f.root, "config.yaml"), "utf8")
  for (const headers of [
    { host: f.local }, { host: "rebound.attacker.invalid", cookie: f.cookie, origin: "https://rebound.attacker.invalid" },
    { host: f.local, cookie: f.cookie, origin: "https://foreign.invalid" },
  ]) {
    assert.ok((await f.app.inject({ method: "POST", url: "/api/opencode-servers/probe", headers, payload: { origin: "https://must-not-resolve.invalid" }, remoteAddress: "127.0.0.1" })).statusCode >= 400)
  }
  for (const origin of ["https://sentinel:sentinel@private.invalid", "https://private.invalid/path", "https://private.invalid?", "https://private.invalid#", "malformed"]) {
    const result = await f.app.inject({ method: "POST", url: "/api/opencode-servers/probe", headers: { host: f.local, cookie: f.cookie }, payload: { origin }, remoteAddress: "127.0.0.1" })
    assert.equal(result.statusCode, 400)
  }
  assert.equal(resolutions, 0); assert.equal(f.calls.length, 0)
  assert.equal(readFileSync(join(f.root, "config.yaml"), "utf8"), before)
})

test("GET distinguishes connecting, admitted, offline-retained and disconnected owners without another native read", async t => {
  const f = await fixture(t), credentials = f.settings.getOpenCodeServerCredentials()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const original = credentials.readForConnection.bind(credentials)
  credentials.readForConnection = async id => { await held; return original(id) }
  const pending = f.owner.connect("saved")
  const get = () => f.app.inject({ url: "/api/opencode-servers", headers: { host: f.local, cookie: f.cookie }, remoteAddress: "127.0.0.1" })
  assert.equal((await get()).json().servers[1].state, "connecting")
  assert.equal(f.calls.length, 0)
  release(); await pending
  const count = f.calls.length
  assert.equal((await get()).json().servers[1].state, "connected")
  f.owner.invalidateServer("saved")
  const offline = (await get()).json()
  assert.equal(offline.servers[1].state, "admitted_offline")
  assert.equal(offline.limits.activeExplicitTargets, 1)
  assert.equal(f.calls.length, count)
  f.owner.disconnect("saved")
  assert.equal((await get()).json().servers[1].state, "disconnected")
  assert.equal(f.calls.length, count)
})

test("closing the real HTTP observer cancels a stalled probe and releases its lane", async t => {
  const f = await fixture(t)
  let abandonedDispatches = 0
  const upstream = createServer((request, response) => {
    abandonedDispatches++; assert.equal(request.method, "GET"); assert.equal(request.url, "/openapi.json")
    response.writeHead(200); response.write("{")
  })
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening")
  t.after(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) })
  const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
  const arrived = once(upstream, "request")
  const request = httpRequest(`http://${f.local}/api/opencode-servers/probe`, { method: "POST", headers: { cookie: f.cookie, "content-type": "application/json" } })
  const clientErrors: string[] = [], upstreamErrors: string[] = []
  request.on("error", error => clientErrors.push((error as NodeJS.ErrnoException).code ?? "unknown"))
  f.settings.getOpenCodeServerCredentials().readForConnection = async () => { assert.fail("probe must not read saved secrets") }
  f.settings.getOpenCodeServerCredentials().set = async () => { assert.fail("probe must not write saved secrets") }
  request.end(JSON.stringify({ origin, credentials: { username: "closed-user", password: "closed-password" } }))
  const [nativeRequest] = await arrived
  const closed = new Promise<void>((resolve, reject) => {
    const error = (value: NodeJS.ErrnoException) => {
      upstreamErrors.push(value.code ?? "unknown")
      if (value.code !== "ECONNRESET") reject(value)
    }
    nativeRequest.socket.on("error", error)
    nativeRequest.socket.once("close", () => { nativeRequest.socket.off("error", error); resolve() })
  })
  request.destroy(); await closed
  await delay(10)
  const replacement = await send(f.local, "/api/opencode-servers/probe", "POST", { cookie: f.cookie }, { origin: f.origin })
  assert.equal(replacement.status, 200, replacement.body)
  assert.equal(JSON.parse(replacement.body).version, "99.0.0")
  assert.equal(abandonedDispatches, 1)
  assert.deepEqual(f.calls, ["GET /openapi.json", "GET /api/info"])
  assert.ok(upstreamErrors.every(code => code === "ECONNRESET"))
  assert.ok(clientErrors.every(code => code === "ECONNRESET"))
  assert.equal(f.owner.activeExplicitTargets, 0)
  assert.doesNotMatch(f.logs.join("\n"), /closed-user|closed-password/)
})

test("upstream authentication and malformed contract return fixed diagnostics instead of CodeNomad login or secret echoes", async t => {
  const f = await fixture(t)
  let auth = true
  const server = createServer((_request, response) => {
    response.writeHead(auth ? 401 : 200, { "www-authenticate": "Basic realm=upstream-secret", "set-cookie": "upstream-secret", "content-type": "application/json" })
    response.end("ephemeral-password upstream-secret malformed JSON")
  })
  server.listen(0, "127.0.0.1"); await once(server, "listening")
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  for (const code of ["auth", "missing_contract"]) {
    const response = await send(f.local, "/api/opencode-servers/probe", "POST", { cookie: f.cookie }, { origin, credentials: { username: "ephemeral-user", password: "ephemeral-password" } })
    assert.equal(response.status, 200, response.body)
    assert.deepEqual(JSON.parse(response.body).diagnostic, { code, phase: "contract" })
    assert.equal(response.headers["www-authenticate"], undefined)
    assert.equal(response.headers["set-cookie"], undefined)
    assert.equal(response.headers.location, undefined)
    assert.doesNotMatch(response.body, /ephemeral-user|ephemeral-password|upstream-secret|malformed JSON/)
    auth = false
  }
  assert.doesNotMatch(f.logs.join("\n"), /ephemeral-user|ephemeral-password|upstream-secret|malformed JSON/)
})

test("candidate probe preserves an active connection and credentials; a registered probe owns the same lane", async t => {
  const f = await fixture(t), captured = await f.owner.connect("saved")
  const admitted: string[][] = []
  f.owner.observeAdmitted(ids => admitted.push([...ids]))
  const response = await send(f.local, "/api/opencode-servers/probe", "POST", { cookie: f.cookie }, { origin: f.origin, credentials: { username: "ephemeral-user", password: "ephemeral-password" } })
  assert.equal(response.status, 200, response.body)
  assert.equal(JSON.parse(response.body).version, "99.0.0")
  assert.equal(f.owner.existingForServer("saved"), captured); captured.assertCurrent()
  assert.equal(f.owner.activeExplicitTargets, 1)
  assert.deepEqual(admitted, [["saved"]])
  const credentials = f.settings.getOpenCodeServerCredentials()
  assert.equal(await credentials.readForConnection("saved"), JSON.stringify({ username: "saved-user", password: "saved-password" }))
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), original = credentials.readForConnection.bind(credentials)
  credentials.readForConnection = async id => { await held; return original(id) }
  const registered = f.owner.probe("saved"), calls = f.calls.length
  const busy = await send(f.local, "/api/opencode-servers/probe", "POST", { cookie: f.cookie }, { origin: f.origin })
  assert.equal(busy.status, 409); assert.equal(JSON.parse(busy.body).code, "probe_busy")
  assert.equal(f.calls.length, calls)
  release(); await registered
  assert.equal(f.owner.existingForServer("saved"), captured); captured.assertCurrent()
  assert.deepEqual(admitted, [["saved"]])
})

for (const initial of ["connected", "connecting", "admitted_offline"] as const) {
  test(`GET purely projects ${initial} reservation against current origin metadata`, async t => {
    const f = await fixture(t), credentials = f.settings.getOpenCodeServerCredentials()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve }), read = credentials.readForConnection.bind(credentials)
    if (initial === "connecting") credentials.readForConnection = async id => { await held; return read(id) }
    const pending = f.owner.connect("saved"); void pending.catch(() => {})
    t.after(async () => { release(); await pending.catch(() => {}) })
    const captured = initial === "connecting" ? undefined : await pending
    if (initial === "admitted_offline") f.owner.invalidateServer("saved")
    const get = () => f.app.inject({ url: "/api/opencode-servers", headers: { host: f.local, cookie: f.cookie }, remoteAddress: "127.0.0.1" })
    assert.equal((await get()).json().servers[1].state, initial)
    const admissions: string[][] = []
    f.owner.observeAdmitted(ids => admissions.push([...ids]))
    assert.equal(f.owner.administrativeState("saved", "http://127.0.0.1:1"), "unknown", "a retained summary from a different origin cannot claim this slot")
    const config = join(f.root, "config.yaml"), original = readFileSync(config, "utf8")
    const replaced = JSON.stringify({ server: { opencodeServers: [{ kind: "explicit", id: "saved", label: "B", origin: "http://127.0.0.1:1" }] } })
    writeFileSync(config, replaced)
    credentials.readForConnection = async () => { assert.fail("GET must not read secrets") }
    const count = f.calls.length, signal = (captured as { signal?: AbortSignal } | undefined)?.signal, wasAborted = signal?.aborted
    for (let repeat = 0; repeat < 2; repeat++) {
      const response = await get()
      assert.equal(response.statusCode, 200, response.body)
      assert.equal(response.json().servers[1].state, "unknown")
      assert.equal(response.json().servers[1].hasCredentials, false)
      assert.equal(response.json().limits.activeExplicitTargets, 1)
      assert.equal(signal?.aborted, wasAborted)
      assert.deepEqual(admissions, [initial === "connecting" ? [] : ["saved"]])
      assert.equal(f.calls.length, count); assert.equal(readFileSync(config, "utf8"), replaced)
    }
    writeFileSync(config, original)
    assert.equal((await get()).json().servers[1].state, initial)
    assert.equal(f.owner.activeExplicitTargets, 1)
    if (initial === "connected") {
      writeFileSync(config, replaced)
      await assert.rejects(captured!.fetch(`${f.origin}/api/info`), { code: "stale_connection" })
      assert.equal(signal?.aborted, true); assert.equal(f.owner.activeExplicitTargets, 0)
      assert.equal(f.calls.length, count)
    }
  })
}

test("privacy recognizes encoded administrative separators without granting routed authority", async t => {
  const f = await fixture(t), user = "encodedSyntheticUser53", password = "encodedSyntheticPass71"
  const forbidden = new RegExp(`${user}|${password}`), headers = { cookie: f.cookie, authorization: user, username: password }
  const candidate = { origin: f.origin, credentials: { username: user, password } }
  const profiles = readFileSync(join(f.root, "config.yaml"), "utf8"), admissions: string[][] = []
  f.owner.observeAdmitted(ids => admissions.push([...ids]))
  f.settings.getOpenCodeServerCredentials().readForConnection = async () => { assert.fail("encoded target must not read secrets") }
  f.settings.getOpenCodeServerCredentials().set = async () => { assert.fail("encoded target must not write secrets") }
  for (const path of ["/api/opencode-servers%2Fprobe", "/api/opencode-servers%2fprobe", "/api%2Fopencode-servers/probe", `/api/opencode-servers%3B${user}`,
    `/api/opencode-servers/probe%2F${user}`, "/api%252Fopencode-servers/probe", "/api%25252Fopencode-servers/probe", "/api/opencode-servers%ZZ", "/api/opencode-servers/%FF"]) {
    const target = `${path}?${user}=${password}`, start = f.logs.length
    const response = await send(f.local, target, "POST", headers, candidate)
    assert.ok(response.status === 400 || response.status === 404 || (response.status === 200 && response.headers["content-type"]?.includes("text/html")), response.body)
    assert.equal(response.headers["cache-control"], "no-store")
    assert.doesNotMatch(response.body, forbidden)
    assert.equal(isOpenCodeServerAdminTarget(target), true, target)
    assert.doesNotMatch(f.logs.slice(start).join("\n"), forbidden, target)
    assert.equal(f.calls.length, 0); assert.equal(f.owner.activeExplicitTargets, 0); assert.deepEqual(admissions, [[]])
    assert.equal(readFileSync(join(f.root, "config.yaml"), "utf8"), profiles)
    const positive = await send(f.local, "/api/opencode-servers", "GET", { cookie: f.cookie }, undefined)
    assert.equal(positive.status, 200)
  }
  const ordinary = await f.app.inject({ method: "POST", url: "/api/auth/login", headers: { "content-type": "application/json" }, payload: '{"ordinary":' })
  const native = Fastify({ logger: false }); native.post("/api/auth/login", () => ({ ok: true }))
  try {
    const expected = await native.inject({ method: "POST", url: "/api/auth/login", headers: { "content-type": "application/json" }, payload: '{"ordinary":' })
    assert.equal(ordinary.statusCode, expected.statusCode); assert.deepEqual(ordinary.json(), expected.json())
  } finally { await native.close() }
})
