import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { request as httpRequest } from "node:http"
import { test, type TestContext } from "node:test"
import Fastify from "fastify"
import { RemoteServerBrowseManager } from "./browse-manager"
import { startFakeCodeNomad } from "./test-support/fake-codenomad"
import { registerRemoteServerBrowseRoutes } from "../server/routes/remote-server-browse"
import { registerRemoteControlRoutes } from "../server/routes/remote-control"
import { RemoteIngress } from "../remote-control/ingress"
import { gateRemoteRequest } from "../remote-control/gate"
import { normalizeExplicitOrigin } from "../opencode/servers/endpoint"
import { createExplicitTransport } from "../opencode/servers/transport"
import { resolveHttpsOptions } from "../server/tls"
import type { Logger } from "../logger"
import type { RemoteControlManager } from "../remote-control/manager"
import { redactSecrets } from "../server/request-logging"
import { relayedFolderListing } from "./folders"

test("Windows drive roots stay navigable and cannot be selected as physical folders", () => {
  const value = relayedFolderListing({ entries: [{ name: "C:", path: "C:/", type: "directory" }],
    metadata: { scope: "unrestricted", pathKind: "drives", currentPath: "__windows_drives__", displayPath: "This computer", rootPath: "", homePath: "C:/Users/test" } })
  assert.equal(value.metadata.pathKind, "drives")
  assert.equal(value.entries[0].path, "C:/")
})

function directory(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-browse-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function fixture(t: TestContext, options: Parameters<typeof startFakeCodeNomad>[0] = {}) {
  const dir = directory(t)
  const remote = await startFakeCodeNomad(options)
  t.after(() => remote.close())
  const profiles = [{ id: "saved", baseUrl: remote.origin, skipTlsVerify: false }]
  const settings = { getOwner: () => ({ remoteServers: profiles }), configYamlPathForAuthority: () => path.join(dir, "config.yaml") }
  const manager = new RemoteServerBrowseManager(settings)
  const app = Fastify()
  let origin = ""
  registerRemoteServerBrowseRoutes(app, { manager, getSelfOrigins: () => new Set([origin]) })
  app.addHook("onClose", async () => manager.close())
  origin = await app.listen({ host: "127.0.0.1", port: 0 })
  t.after(() => app.close())
  const call = (action: string, body: unknown = {}, id = "saved", headers = { origin }) => app.inject({
    method: "POST", url: `/api/remote-servers/${id}/${action}`, headers, payload: body as object,
  })
  return { dir, remote, profiles, settings, manager, app, origin, call,
    connect: () => call("connect", { username: "codenomad", password: "remote-password" }) }
}

test("unpaired Remote Control status requests credentials without attempting password login", async t => {
  const f = await fixture(t)
  f.remote.state.overrides.set('/api/auth/status', { status: 200, body: { authenticated: false, pairingRequired: true } })
  for (let i = 0; i < 2; i++) assert.deepEqual((await f.call('browse')).json(), { error: 'needs_credentials' })
  assert.equal(f.remote.state.logins, 0)
  assert(f.remote.state.requests.every(request => request.path === '/api/auth/status' && request.headers.origin === undefined))
})

test("saved direct authentication, sanitized folders and recents, one reauthentication after expiry", async t => {
  const f = await fixture(t)
  const missing = await f.call("browse")
  assert.equal(missing.statusCode, 409)
  assert.deepEqual(missing.json(), { error: "needs_credentials" })
  const wrong = await f.call("connect", { username: "codenomad", password: "wrong" })
  assert.equal(wrong.statusCode, 409)
  assert.deepEqual(wrong.json(), { error: "auth" })
  assert.equal(fs.existsSync(path.join(f.dir, "remote-server-credentials.json")), false)
  assert.deepEqual((await f.connect()).json(), { ok: true })
  const body = (await f.call("browse")).json()
  assert.deepEqual(body.recents, [{ path: "/srv/projects/app", projectName: "App", lastAccessed: 42 }])
  assert.equal(body.listing.metadata.currentPath, "/srv/projects")
  assert.deepEqual(body.listing.entries, [{ name: "app", path: "/srv/projects/app", absolutePath: "/srv/projects/app", type: "directory" }])
  assert.equal(JSON.stringify(body).includes("must-not-leak"), false)
  const nested = (await f.call("browse", { path: "/srv/projects/folder &?#" })).json()
  assert.equal(nested.listing.metadata.currentPath, "/srv/projects/folder &?#")
  assert.equal(f.remote.state.logins, 2, "browse reuses the persisted successful session")
  const beforeExpiry = fs.readFileSync(path.join(f.dir, "remote-server-credentials.json"), "utf8")
  f.remote.restart()
  assert.equal((await f.call("browse")).statusCode, 200)
  assert.equal(f.remote.state.logins, 3)
  assert.notEqual(fs.readFileSync(path.join(f.dir, "remote-server-credentials.json"), "utf8"), beforeExpiry, "rotated session persists after expired-session reauthentication")
  assert(f.remote.state.requests.every(request => request.headers.origin === undefined), "never send Origin upstream")
  assert(f.remote.state.requests.every(request => ["/api/auth/login", "/api/auth/status", "/api/filesystem", "/api/storage/state/ui"].includes(request.path.split("?")[0]!)))
})

test("private successful credentials and sessions survive launches; failed replacement preserves identity; forget removes it", async t => {
  const f = await fixture(t)
  await f.connect()
  const file = path.join(f.dir, "remote-server-credentials.json")
  const saved = fs.readFileSync(file, "utf8")
  assert(saved.includes("remote-password"))
  assert(saved.includes("codenomad_session="))
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  await f.call("connect", { username: "codenomad", password: "wrong" })
  assert.equal(fs.readFileSync(file, "utf8"), saved)
  f.manager.close()
  const next = new RemoteServerBrowseManager(f.settings)
  t.after(() => next.close())
  assert.equal((await next.browse("saved", {})).listing.metadata.currentPath, "/srv/projects")
  assert.equal(f.remote.state.logins, 2, "persisted session avoids a launch login")
  await next.forget("saved")
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { servers: {} })
  await assert.rejects(next.browse("saved", {}), { code: "needs_credentials" })
})

test("revoked password retries once and clears private identity; profiles are resolved by ID", async t => {
  const f = await fixture(t)
  await f.connect()
  await f.call("browse")
  f.remote.state.password = "changed"
  f.remote.restart()
  const refused = await f.call("browse")
  assert.equal(refused.statusCode, 409)
  assert.deepEqual(refused.json(), { error: "auth" })
  assert.equal(f.remote.state.logins, 2)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, "remote-server-credentials.json"), "utf8")), { servers: {} })
  const before = f.remote.state.requests.length
  assert.deepEqual((await f.call("browse", {}, "missing")).json(), { error: "unknown_server" })
  await f.call("browse", { baseUrl: f.remote.origin })
  assert.equal(f.remote.state.requests.length, before)
  f.profiles[0]!.baseUrl = `${f.remote.origin}/api/auth/login`
  assert.deepEqual((await f.call("browse")).json(), { error: "unreachable" })
  assert.equal(f.remote.state.requests.length, before)
  assert.equal(normalizeExplicitOrigin("http://192.168.1.25:8080"), "http://192.168.1.25:8080")
})

test("anonymous direct servers need no secrets; removed and changed profiles cannot reuse credentials", async t => {
  const f = await fixture(t, { anonymous: true })
  assert.equal((await f.call("browse")).statusCode, 200)
  assert.equal((await f.call("connect")).statusCode, 200)
  assert.equal(fs.existsSync(path.join(f.dir, "remote-server-credentials.json")), false)
  f.profiles.splice(0)
  assert.deepEqual((await f.call("browse")).json(), { error: "unknown_server" })
})

test("forget endpoint deletes credentials and client; a changed origin never receives another profile's secret", async t => {
  const f = await fixture(t)
  await f.connect()
  await f.call("browse")
  assert.deepEqual((await f.call("forget")).json(), { ok: true })
  assert.deepEqual((await f.call("browse")).json(), { error: "needs_credentials" })
  await f.connect()
  const other = await startFakeCodeNomad()
  t.after(() => other.close())
  f.profiles[0]!.baseUrl = other.origin
  assert.deepEqual((await f.call("browse")).json(), { error: "needs_credentials" })
  assert(other.state.requests.every(request => !request.headers.cookie && !request.headers.authorization && !request.body))
  assert.equal(other.state.logins, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, "remote-server-credentials.json"), "utf8")), { servers: {} })
})

test("remote data is bounded and invalid recent entries are omitted without leaking upstream payloads", async t => {
  const f = await fixture(t)
  await f.connect()
  f.remote.state.recents[0]!.projectName = "x".repeat(1025)
  assert.deepEqual((await f.call("browse")).json().recents, [])
  f.remote.state.recents[0]!.projectName = "x".repeat(8 * 1024 * 1024)
  assert.deepEqual((await f.call("browse")).json(), { error: "unreachable" })
})

test("malformed remote metadata and entries always return stable sanitized errors", async t => {
  const f = await fixture(t)
  await f.connect()
  const listing = (await f.call("browse")).json().listing
  for (const body of [null, { ...listing, metadata: null }, { ...listing, metadata: { ...listing.metadata, rootPath: { password: "private" } } },
    { ...listing, entries: [{ type: "directory", name: "app", path: { cookie: "private" } }] }, { ...listing, entries: "private" }]) {
    f.remote.state.overrides.set("/api/filesystem", { status: 200, body })
    const response = await f.call("browse")
    assert.equal(response.statusCode, 502)
    assert.deepEqual(response.json(), { error: "unreachable" })
  }
})

test("unsuccessful login or redirected reads cannot replace persisted credentials or forward cookies", async t => {
  const f = await fixture(t)
  await f.connect()
  await f.call("browse")
  const file = path.join(f.dir, "remote-server-credentials.json")
  const saved = fs.readFileSync(file, "utf8")
  f.remote.state.overrides.set("/api/auth/login", { status: 401, body: { password: "must-not-leak" }, headers: { "set-cookie": "codenomad_session=failed-login; Path=/" } })
  const failed = await f.call("connect", { username: "codenomad", password: "wrong" })
  assert.equal(failed.statusCode, 409)
  assert.deepEqual(failed.json(), { error: "auth" })
  assert.equal(fs.readFileSync(file, "utf8"), saved)
  f.remote.state.overrides.delete("/api/auth/login")
  const other = await startFakeCodeNomad()
  t.after(() => other.close())
  f.remote.state.overrides.set("/api/filesystem", { status: 302, body: { cookie: "must-not-leak" }, headers: {
    location: `${other.origin}/api/filesystem`, "set-cookie": "codenomad_session=redirect-secret; Domain=foreign.test; Path=/",
  } })
  assert.deepEqual((await f.call("browse")).json(), { error: "unreachable" })
  assert.equal(fs.readFileSync(file, "utf8"), saved)
  assert.equal(other.state.requests.length, 0)
  f.remote.state.overrides.delete("/api/filesystem")
  assert.equal((await f.call("browse")).statusCode, 200)
  await f.call("forget")
  f.profiles.splice(0)
  assert.deepEqual((await f.call("browse")).json(), { error: "unknown_server" })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { servers: {} })
})

test("transport strips Origin, caller cookies and response cookies, and fences every dispatch to its bound origin", async t => {
  const remote = await startFakeCodeNomad()
  const other = await startFakeCodeNomad()
  t.after(() => remote.close())
  t.after(() => other.close())
  const captured: string[] = []
  remote.state.overrides.set("/api/auth/status", { status: 200, body: { authenticated: true }, headers: { "set-cookie": "private-session=value; Domain=foreign.test; Path=/" } })
  const transport = createExplicitTransport({ origin: remote.origin,
    headers: () => ({ Origin: remote.origin, cookie: "private-cookie=value" }), onSetCookie: values => captured.push(...values) })
  const response = await transport.fetch(`${remote.origin}/api/auth/status`, { headers: { origin: "http://foreign.test", cookie: "caller-cookie=value" } })
  assert.equal(response.headers.get("set-cookie"), null)
  await response.body?.cancel()
  assert.equal(captured.length, 1)
  assert.equal(remote.state.requests[0]!.headers.origin, undefined)
  assert.equal(remote.state.requests[0]!.headers.cookie, "private-cookie=value")
  await assert.rejects(transport.fetch(`${other.origin}/api/auth/status`), { code: "invalid_origin" })
  assert.equal(other.state.requests.length, 0)
  remote.state.overrides.set("/api/auth/status", { status: 302, body: {}, headers: { location: "/api/filesystem", "set-cookie": "private-session=redirected" } })
  await assert.rejects(transport.fetch(`${remote.origin}/api/auth/status`), { code: "redirect" })
  assert.equal(captured.length, 1, "even same-origin redirects do not rotate stored cookies")
  assert.equal(remote.state.requests.length, 2, "redirect is never followed")
})

test("host guard requires loopback AND exact self Origin even with no general authentication", async t => {
  const f = await fixture(t)
  for (const action of ["browse", "connect", "forget"]) {
    for (const origin of [undefined, "null", "http://foreign.test", "http://localhost:3000", "http://127.0.0.1:1"]) {
      const headers = origin ? { origin } : {}
      const response = await f.app.inject({ method: "POST", url: `/api/remote-servers/saved/${action}`, headers, payload: {} })
      assert.equal(response.statusCode, 403)
      assert.deepEqual(response.json(), { error: "auth" })
    }
    const lan = await f.app.inject({ method: "POST", url: `/api/remote-servers/saved/${action}`, remoteAddress: "192.168.1.8", headers: { origin: f.origin }, payload: {} })
    assert.equal(lan.statusCode, 403)
  }
  const ingress = new RemoteIngress((req, res) => f.app.server.emit("request", req, res))
  const target = await ingress.start()
  t.after(() => ingress.stop())
  for (const action of ["browse", "connect", "forget"]) {
    const response = await fetch(`http://${target}/api/remote-servers/saved/${action}`, {
      method: "POST", headers: { origin: f.origin, "content-type": "application/json", "x-forwarded-for": "127.0.0.1" }, body: "{}",
    })
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: "auth" })
  }
  assert.equal(f.remote.state.requests.length, 0, "refused before reading credentials or contacting the saved target")
  assert.equal(fs.existsSync(path.join(f.dir, "remote-server-credentials.json")), false)
})

test("invalid pairing links never dispatch; browser pairing preserves its Origin and direct-listener policy", async t => {
  const f = await fixture(t)
  assert.deepEqual((await f.call("connect", { pairingLink: "https://remote.test/remote-pair#secret" })).json(), { error: "pairing_expired" })
  assert.equal(f.remote.state.requests.length, 0)
  assert.deepEqual(redactSecrets({ pairingLink: "https://remote.test/remote-pair#secret", password: "secret" }), { pairingLink: "<redacted>", password: "<redacted>" })
  const app = Fastify()
  let exchanges = 0
  registerRemoteControlRoutes(app, { manager: { exchangePairing() { exchanges++; return null } } as unknown as RemoteControlManager })
  app.addHook("onRequest", (request, reply, done) => {
    if (!gateRemoteRequest(request, reply, { publicHost: () => "remote.test", authenticate: () => null, assignDevice() {}, servesPreview: () => false })) done()
  })
  await app.listen({ port: 0, host: "127.0.0.1" })
  t.after(() => app.close())
  const direct = await app.inject({ method: "POST", url: "/api/remote-control/pair", payload: { code: "secret" } })
  assert.equal(direct.statusCode, 404)
  const ingress = new RemoteIngress((req, res) => app.server.emit("request", req, res))
  const target = await ingress.start()
  t.after(() => ingress.stop())
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(`http://${target}/api/remote-control/pair`, {
      method: "POST", headers: { host: "remote.test", "content-type": "application/json" },
    }, response => { response.resume(); response.on("end", () => resolve(response.statusCode)) })
    request.on("error", reject)
    request.end(JSON.stringify({ code: "secret" }))
  })
  assert.equal(status, 403, "real gate refuses server-to-server pairing without Origin")
  assert.equal(exchanges, 0)
})

test("real HTTPS honors the saved certificate policy; TLS errors never expose details", async t => {
  const dir = directory(t)
  const logger = { info() {}, warn() {}, error() {}, child() { return logger } } as unknown as Logger
  const tls = resolveHttpsOptions({ enabled: true, configDir: dir, host: "localhost", logger })!
  const f = await fixture(t, { tls: tls.httpsOptions })
  assert.deepEqual((await f.connect()).json(), { error: "tls_error" })
  assert.equal(fs.existsSync(path.join(f.dir, "remote-server-credentials.json")), false)
  f.profiles[0]!.skipTlsVerify = true
  assert.deepEqual((await f.connect()).json(), { ok: true })
  assert.equal((await f.call("browse")).statusCode, 200)
  f.profiles[0]!.skipTlsVerify = false
  assert.deepEqual((await f.call("browse")).json(), { error: "tls_error" })
})

test("unreachable targets return a stable error, and manager shutdown cancels further work", async t => {
  const f = await fixture(t)
  await f.remote.close()
  assert.deepEqual((await f.connect()).json(), { error: "unreachable" })
  f.manager.close()
  assert.deepEqual((await f.call("browse")).json(), { error: "unreachable" })
})

test("view sessions are fresh, cookie-free logins and leave the backend identity untouched", async t => {
  const f = await fixture(t)
  assert.deepEqual((await f.call("view-session")).json(), { error: "needs_credentials" })
  await f.connect()
  const file = path.join(f.dir, "remote-server-credentials.json")
  const before = fs.readFileSync(file, "utf8")
  const backendCookie = JSON.parse(before).servers.saved.secret.cookie
  const response = await f.call("view-session")
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers["cache-control"], "no-store")
  const { cookie } = response.json()
  assert.equal(cookie.origin, f.remote.origin)
  assert.equal(cookie.name, "codenomad_session")
  assert.notEqual(`${cookie.name}=${cookie.value}`, backendCookie)
  assert.equal(cookie.path, "/")
  assert.equal(cookie.httpOnly, true)
  assert.equal(cookie.secure, false)
  assert.equal(cookie.sameSite, "lax")
  assert.equal(f.remote.state.requests.at(-1)!.path, "/api/auth/login")
  assert.equal(f.remote.state.requests.at(-1)!.headers.cookie, undefined)
  assert.equal(response.body.includes("remote-password"), false)
  assert.equal(response.body.includes("password"), false)
  assert.equal(fs.readFileSync(file, "utf8"), before)
  assert.notEqual((await f.call("view-session")).json().cookie.value, cookie.value)
  f.remote.state.password = "changed"
  assert.deepEqual((await f.call("view-session")).json(), { error: "auth" })
  assert.equal(fs.readFileSync(file, "utf8"), before)
})

test("view-session uses the browse guard, including loopback ingress denial", async t => {
  const f = await fixture(t)
  for (const origin of [undefined, "null", "http://foreign.test"]) {
    assert.equal((await f.app.inject({ method: "POST", url: "/api/remote-servers/saved/view-session",
      headers: origin ? { origin } : {}, payload: {} })).statusCode, 403)
  }
  assert.equal((await f.app.inject({ method: "POST", url: "/api/remote-servers/saved/view-session",
    remoteAddress: "192.168.1.8", headers: { origin: f.origin }, payload: {} })).statusCode, 403)
  const ingress = new RemoteIngress((req, res) => f.app.server.emit("request", req, res))
  const target = await ingress.start()
  t.after(() => ingress.stop())
  const response = await fetch(`http://${target}/api/remote-servers/saved/view-session`, {
    method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: "{}",
  })
  assert.equal(response.status, 403)
  assert.equal(f.remote.state.requests.length, 0)
})

test("a view login admitted before profile retargeting never publishes its cookie", async t => {
  const f = await fixture(t)
  await f.connect()
  const file = path.join(f.dir, "remote-server-credentials.json")
  const before = fs.readFileSync(file, "utf8")
  let admitted!: () => void
  const admission = new Promise<void>(resolve => { admitted = resolve })
  let release!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  f.remote.state.handlers.set("/api/auth/login", async (_request, response) => {
    admitted()
    await released
    response.writeHead(200, { "set-cookie": "codenomad_session=private; Path=/; HttpOnly; SameSite=Lax" })
    response.end("{}")
  })
  const pending = f.call("view-session")
  // inject is lazy until consumed.
  const result = Promise.resolve(pending)
  await admission
  f.profiles[0]!.baseUrl = "http://127.0.0.1:1"
  release()
  assert.deepEqual((await result).json(), { error: "unreachable" })
  assert.equal(fs.readFileSync(file, "utf8"), before, "view-session never writes even when its authority is revoked")
})

test("view-session refuses redirects and preserves cookie expiry attributes", async t => {
  const f = await fixture(t)
  await f.connect()
  f.remote.state.overrides.set("/api/auth/login", { status: 200, body: {}, headers: {
    "set-cookie": "custom_session=dedicated; Path=/; HttpOnly; SameSite=Strict; Max-Age=120",
  } })
  const cookie = (await f.call("view-session")).json().cookie
  assert.equal(cookie.name, "custom_session")
  assert.equal(cookie.sameSite, "strict")
  assert(cookie.expires > Date.now() / 1000 + 100)
  const before = f.remote.state.requests.length
  f.remote.state.overrides.set("/api/auth/login", { status: 302, body: {}, headers: { location: "/api/auth/status" } })
  assert.deepEqual((await f.call("view-session")).json(), { error: "unreachable" })
  assert.equal(f.remote.state.requests.length, before + 1)
})
