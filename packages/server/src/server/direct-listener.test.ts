import assert from "node:assert/strict"
import test from "node:test"
import os from "node:os"
import fs from "node:fs"
import path from "node:path"
import type { HTTPMethods } from "fastify"
import { startRemoteSurface } from "../remote-control/test-support/surface"
import { parseAllowedOrigins } from "./direct-origin"
import { PROXIED_HTTP_METHODS } from "./proxied-http-methods"
import { backendAdmissionFixture, backendAuthorityHeader, backendBootstrap, assertServerCapabilities, assertPrivateBackendReply } from "../remote-control/test-support/backend-admission"

const own = "http://localhost:0" // advertised origin in the real application fixture
const trusted = "https://ui.example.test"
const foreign = "https://other.example.test"
const lan = "192.0.2.20"

test("multi-backend admission: native local probe keeps its originless caller contract", async t => {
  const f = await backendAdmissionFixture(t, false)
  const { app, authManager } = await startRemoteSurface(t, { settings: f.settings })
  const cookie = `${authManager.getCookieName()}=${authManager.createSession("codenomad").id}`
  const response = await app.inject({ method: "POST", url: "/api/remote-servers/probe",
    headers: { cookie }, payload: { baseUrl: f.remotes[0]!.origin } })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().ok, true)
})

for (const reason of ["flag-off", "https-proxy-flag-off", "http-proxy-flag-off", "missing-origin", "foreign-origin", "server-request"] as const) {
  test(`server-profile persistence admission: direct ${reason} cannot patch or delete saved profiles`, async t => {
    const f = await backendAdmissionFixture(t, !reason.endsWith("flag-off"))
    const origin = reason === "https-proxy-flag-off" ? trusted : "http://lan.example.test"
    const peer = reason.includes("-proxy-") ? "127.0.0.1" : lan
    const { app, authManager } = await startRemoteSurface(t, { settings: f.settings, allowedOrigins: [origin] })
    const cookie = `${authManager.getCookieName()}=${authManager.createSession("codenomad").id}`
    const headers: Record<string, string> = { cookie }
    if (reason !== "missing-origin") headers.origin = reason === "foreign-origin" ? foreign : origin
    if (reason === "server-request") headers["x-codenomad-server-request"] = "1"
    const stateFile = path.join(f.directory, "state.yaml")
    const before = fs.readFileSync(stateFile, "utf8")
    const snapshot = structuredClone(f.settings.getDoc("state"))
    for (const [url, payload] of [
      ["/api/storage/state/ui", { remoteServers: [] }],
      ["/api/storage/state/ui", { remoteServers: null }],
      ["/api/storage/state", { ui: { remoteServers: [] } }],
      ["/api/storage/state", { ui: { remoteServers: null } }],
      ["/api/storage/state", { ui: null }],
    ] as const) {
      const result = await app.inject({ method: "PATCH", url, remoteAddress: peer, headers, payload })
      assert.equal(fs.readFileSync(stateFile, "utf8"), before, `${reason} ${url}: persisted a refused profile change`)
      assert.deepEqual(f.settings.getDoc("state"), snapshot, `${reason} ${url}: changed cached state`)
      assert.ok([401, 403, 404].includes(result.statusCode), `${reason} ${url}: ${result.statusCode} ${result.body}`)
    }
    if (reason.endsWith("flag-off")) assertServerCapabilities((await app.inject({ url: "/api/meta", remoteAddress: peer, headers })).json(), false, false)
    assert.equal(f.io(), 0)
  })
}

for (const origin of ["http://lan.example.test", trusted]) {
  test(`server-profile persistence admission: enabled direct ${origin} may manage saved profiles`, async t => {
    const f = await backendAdmissionFixture(t)
    const { app, authManager } = await startRemoteSurface(t, { settings: f.settings, allowedOrigins: [origin] })
    const cookie = `${authManager.getCookieName()}=${authManager.createSession("codenomad").id}`
    const remoteServers = [{ id: "managed", baseUrl: f.remotes[0]!.origin, skipTlsVerify: true, ssh: { host: "fixture-host" } }]
    for (const [url, payload] of [
      ["/api/storage/state/ui", { remoteServers }],
      ["/api/storage/state", { ui: { remoteServers } }],
    ] as const) {
      const result = await app.inject({ method: "PATCH", url, remoteAddress: lan, headers: { cookie, origin }, payload })
      assert.equal(result.statusCode, 200, result.body)
      assert.deepEqual(f.settings.getOwner("state", "ui").remoteServers, remoteServers)
    }
    const deleted = await app.inject({ method: "PATCH", url: "/api/storage/state", remoteAddress: lan,
      headers: { cookie, origin }, payload: { ui: null } })
    assert.equal(deleted.statusCode, 200, deleted.body)
    assert.equal(f.settings.getOwner("state", "ui").remoteServers, undefined)
    assert.equal(f.io(), 0)
  })
}

for (const origin of ["http://lan.example.test", trusted]) {
  test(`multi-backend admission: direct session ${origin} uses saved A/B without mixing raw IDs`, async t => {
    const f = await backendAdmissionFixture(t)
    const { app, authManager } = await startRemoteSurface(t, { settings: f.settings, allowedOrigins: [origin] })
    const cookie = `${authManager.getCookieName()}=${authManager.createSession("codenomad").id}`
    const headers = { cookie, origin }
    t.mock.method(os, "homedir", () => f.directory)
    const ssh = await app.inject({ url: "/api/remote-servers/ssh-hosts", remoteAddress: lan, headers })
    assert.equal(ssh.statusCode, 200, ssh.body)
    assert.deepEqual(ssh.json(), { hosts: ["fixture-host"] })
    const probe = await app.inject({ method: "POST", url: "/api/remote-servers/probe", remoteAddress: lan, headers,
      payload: { baseUrl: f.remotes[0]!.origin } })
    assert.equal(probe.statusCode, 200, probe.body)
    assert.equal(probe.json().ok, true)
    for (const id of ["A", "B"]) {
      for (const action of ["connect", "browse"]) {
        const result = await app.inject({ method: "POST", url: `/api/remote-servers/${id}/${action}`, remoteAddress: lan, headers, payload: {} })
        assert.equal(result.statusCode, 200, `${id}/${action}: ${result.body}`)
        assertPrivateBackendReply(result.body, result.headers)
      }
      const meta = await app.inject({ url: `/api/backends/${id}/api/meta`, remoteAddress: lan,
        headers: { ...headers, [backendAuthorityHeader]: backendBootstrap } })
      assert.equal(meta.statusCode, 200, meta.body)
      const proof = String(meta.headers[backendAuthorityHeader])
      assert.match(proof, /^[A-Za-z0-9_-]{43}$/)
      for (const provenance of [{ origin }, { referer: `${origin}/page`, "sec-fetch-site": "same-origin" }]) {
        const result = await app.inject({ url: `/api/backends/${id}/workspaces/same-workspace/instance/api/session/same-session`,
          remoteAddress: lan, headers: { cookie, ...provenance, [backendAuthorityHeader]: proof } })
        assert.equal(result.statusCode, 200, result.body)
        assert.equal(result.json().server, id)
        assertPrivateBackendReply(result.body, result.headers)
      }
      assert.equal((await app.inject({ method: "POST", url: `/api/remote-servers/${id}/forget`, remoteAddress: lan, headers, payload: {} })).statusCode, 200)
    }
    const meta = await app.inject({ url: "/api/meta", remoteAddress: lan, headers })
    assertServerCapabilities(meta.json(), true, origin.startsWith("https:"))
  })
}

test("multi-backend admission: LAN sensitive reads refuse missing or hostile provenance before IO", async t => {
  const f = await backendAdmissionFixture(t)
  const origin = "http://lan.example.test"
  const { app, authManager } = await startRemoteSurface(t, { settings: f.settings, allowedOrigins: [origin] })
  const cookie = `${authManager.getCookieName()}=${authManager.createSession("codenomad").id}`
  for (const extra of [{}, { origin: foreign }, { origin: "null" }, { referer: `${foreign}/page` },
    { origin: foreign, referer: `${origin}/page` },
    { "x-forwarded-for": "127.0.0.1", "x-forwarded-host": "localhost:0", "x-forwarded-proto": "https" },
    { origin, "x-codenomad-server-request": "1" }]) {
    const result = await app.inject({ url: "/api/backends/A/api/meta", remoteAddress: lan, headers: { cookie, ...extra } })
    assert.ok([401, 403, 404].includes(result.statusCode), `${JSON.stringify(extra)}: ${result.statusCode}`)
  }
  assert.equal(f.io(), 0)
})

test("multi-backend admission: LAN forbids password and pairing entry on connect and backend login", async t => {
  const f = await backendAdmissionFixture(t)
  const origin = "http://lan.example.test"
  const { app, authManager } = await startRemoteSurface(t, { settings: f.settings, allowedOrigins: [origin] })
  const cookie = `${authManager.getCookieName()}=${authManager.createSession("codenomad").id}`
  for (const url of ["/api/remote-servers/A/connect", "/api/backends/A/api/auth/login"]) {
    for (const payload of [{ username: "codenomad", password: "new-secret" }, { password: "" },
      { pairingLink: "https://remote.example.test/remote-pair#new-secret" }, { pairingLink: "" }]) {
      const result = await app.inject({ method: "POST", url, remoteAddress: lan, headers: { cookie, origin }, payload })
      assert.equal(result.statusCode, 403, `${url} ${JSON.stringify(payload)}: ${result.body}`)
      assert.deepEqual(result.json(), { error: "secret_entry_forbidden" })
    }
  }
  assert.equal(f.io(), 0)
})

test("multi-backend admission: direct HTTPS device works without Origin on reads and revocation defeats session fallback", async t => {
  const f = await backendAdmissionFixture(t)
  const { app, authManager, manager } = await startRemoteSurface(t, {
    settings: f.settings, allowedOrigins: [trusted],
    configureApp: app => app.addHook("onRequest", (request, _reply, done) => {
      const socket = request.raw.socket as unknown as { destroy?: () => void; emit(event: string): void }
      socket.destroy ??= () => socket.emit("close")
      done()
    }),
  })
  await manager.stop()
  const pairing = manager.createDirectPairing(trusted)
  const paired = await app.inject({ method: "POST", url: "/api/remote-control/pair", remoteAddress: lan,
    headers: { host: "ui.example.test", origin: trusted }, payload: { code: new URL(pairing.url).hash.slice(1) } })
  assert.equal(paired.statusCode, 200, paired.body)
  const deviceCookie = String(paired.headers["set-cookie"]).split(";")[0]!
  const session = `${authManager.getCookieName()}=${authManager.createSession("codenomad").id}`
  const headers = { host: "ui.example.test", cookie: `${deviceCookie}; ${session}` }
  for (const id of ["A", "B"]) {
    const meta = await app.inject({ url: `/api/backends/${id}/api/meta`, remoteAddress: lan,
      headers: { ...headers, [backendAuthorityHeader]: backendBootstrap } })
    assert.equal(meta.statusCode, 200, meta.body)
    const result = await app.inject({ url: `/api/backends/${id}/workspaces/same-workspace/instance/api/session/same-session`, remoteAddress: lan,
      headers: { ...headers, [backendAuthorityHeader]: String(meta.headers[backendAuthorityHeader]) } })
    assert.equal(result.statusCode, 200, result.body)
    assert.equal(result.json().server, id)
    assertPrivateBackendReply(result.body, result.headers)
  }
  const meta = await app.inject({ url: "/api/meta", remoteAddress: lan, headers })
  assertServerCapabilities(meta.json(), true, true)
  assert.equal(meta.json().localRequest, false)
  const before = f.io()
  for (const extra of [{ origin: foreign }, { origin: "null" }, { referer: `${foreign}/page` },
    { "x-codenomad-server-request": "1" }]) {
    const response = await app.inject({ url: "/api/backends/A/api/meta", remoteAddress: lan, headers: { ...headers, ...extra } })
    assert.ok([401, 403, 404].includes(response.statusCode), response.body)
  }
  manager.revokeDevice(paired.json().device.id)
  const refused = await app.inject({ url: "/api/backends/A/api/meta", remoteAddress: lan, headers })
  assert.equal(refused.statusCode, 401, refused.body)
  assert.equal(f.io(), before)
})

test("multi-backend admission: cached settings cannot override authoritative YAML or admit encoded and nested routes", async t => {
  const f = await backendAdmissionFixture(t)
  const origin = "http://lan.example.test"
  const { app, authManager } = await startRemoteSurface(t, { settings: f.settings, allowedOrigins: [origin] })
  const cookie = `${authManager.getCookieName()}=${authManager.createSession("codenomad").id}`
  const headers = { cookie, origin }
  f.settings.getOwner("config", "ui")
  const meta = await app.inject({ url: "/api/meta", remoteAddress: lan, headers })
  assertServerCapabilities(meta.json(), true, false)
  for (const url of ["/api/backends/A/api/backends/B/api/meta", "/api/backends/A/api/remote-%73ervers/probe",
    "/api/backends/A/preview-capabilities", "/api/%62ackends/A/api/meta"]) {
    const response = await app.inject({ url, remoteAddress: lan, headers })
    assert.ok([403, 404].includes(response.statusCode), `${url}: ${response.statusCode}`)
  }
  for (const value of [false, "true"]) {
    f.setEnabled(value)
    const response = await app.inject({ url: "/api/backends/A/api/meta", remoteAddress: lan, headers })
    assert.ok([403, 404].includes(response.statusCode), response.body)
    assertServerCapabilities((await app.inject({ url: "/api/meta", remoteAddress: lan, headers })).json(), false, false)
  }
  assert.equal(f.io(), 0)
})

test("the wildcard direct listener grants credentialed CORS only to self and configured origins", async t => {
  const { app, authManager } = await startRemoteSurface(t, { bindHost: "0.0.0.0", allowedOrigins: [trusted] })
  const session = authManager.createSession("codenomad")
  const cookie = `${authManager.getCookieName()}=${session.id}`
  for (const origin of [own, trusted, foreign, "null", "http://localhost:3000", "https://ui.example.test.evil.test"]) {
    const response = await app.inject({ url: "/api/auth/status", remoteAddress: lan, headers: { origin, cookie } })
    assert.equal(response.statusCode, origin === "null" ? 403 : 200)
    assert.equal(response.headers["access-control-allow-origin"], [own, trusted].includes(origin) ? origin : undefined)
    assert.notEqual(response.headers["access-control-allow-origin"], "*")
    const preflight = await app.inject({ method: "OPTIONS", url: "/api/test/mutate", remoteAddress: lan,
      headers: { origin, "access-control-request-method": "POST" } })
    assert.equal(preflight.headers["access-control-allow-origin"], [own, trusted].includes(origin) ? origin : undefined)
  }
  for (const value of ["*", "null", "https://ui.test/", "https://user:pass@ui.test", "https://*.ui.test", "file:///test"]) {
    assert.throws(() => parseAllowedOrigins(value), value)
  }
  assert.deepEqual(parseAllowedOrigins(` ${trusted},${own} `), [trusted, own])
})

test("direct mutations validate Origin then Referer, including login/logout and credential-free requests", async t => {
  let writes = 0
  const { app, authManager } = await startRemoteSurface(t, { allowedOrigins: [trusted],
    configureApp: app => { app.post("/api/test/mutate", async () => ({ writes: ++writes })) } })
  const cookie = `${authManager.getCookieName()}=${authManager.createSession("codenomad").id}`
  for (const headers of [{ origin: own }, { origin: trusted }, { referer: `${trusted}/page` }]) {
    const response = await app.inject({ method: "POST", url: "/api/test/mutate", remoteAddress: lan, headers: { cookie, ...headers } })
    assert.equal(response.statusCode, 200, response.body)
  }
  assert.equal(writes, 3)
  for (const headers of [{}, { origin: foreign }, { origin: "null" }, { referer: "invalid" },
    { referer: `${foreign}/page` }, { origin: foreign, referer: `${trusted}/page` }]) {
    for (const url of ["/api/test/mutate", "/api/auth/login", "/api/auth/logout"]) {
      const response = await app.inject({ method: "POST", url, remoteAddress: lan, headers: { cookie, ...headers } })
      assert.equal(response.statusCode, 403, `${url}: ${JSON.stringify(headers)}`)
    }
  }
  assert.equal(writes, 3)
  const unauthenticated = await app.inject({ method: "POST", url: "/api/test/mutate", remoteAddress: lan, headers: { origin: own } })
  assert.equal(unauthenticated.statusCode, 401)
  const login = await app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: lan, headers: { origin: own },
    payload: { username: "codenomad", password: "local-password" } })
  assert.equal(login.statusCode, 200)
  assert.match(String(login.headers["set-cookie"]), /(?:^|; )Max-Age=604800(?:;|$)/)
  const localNative = await app.inject({ method: "POST", url: "/api/test/mutate", headers: { cookie } })
  assert.equal(localNative.statusCode, 200)
})

test("LAN sessions use the bundled UI but cannot administer host-only routes, including encoded paths", async t => {
  const { app, authManager } = await startRemoteSurface(t)
  const cookie = `${authManager.getCookieName()}=${authManager.createSession("codenomad").id}`
  const headers = { cookie, origin: own, "x-forwarded-for": "127.0.0.1", "x-codenomad-remote-control": "0" }
  for (const url of ["/", "/api/meta", "/api/auth/status", "/api/remote-control/status", "/api/test/echo"]) {
    const response = await app.inject({ url, remoteAddress: lan, headers })
    assert.equal(response.statusCode, 200, `${url}: ${response.body}`)
    if (url.endsWith("echo")) assert.equal(response.json().loopbackPrivileges, false)
  }
  for (const [method, url] of [
    ["POST", "/api/auth/password"], ["POST", "/api/auth/password;x"], ["POST", "/api/auth/token"],
    ["GET", "/auth/token"], ["POST", "/api/remote-control/start"], ["POST", "/api/remote-%63ontrol/pairings"],
    ["DELETE", "/api/remote-control"], ["GET", "/api/remote-control/devices"],
    ["POST", "/api/remote-proxy/sessions"], ["POST", "/api/remote-servers/probe;x"],
    ["POST", "/api/opencode-plugin/automation"], ["GET", "/sidecars/example/"],
  ] as const) {
    const response = await app.inject({ method, url, remoteAddress: lan, headers })
    assert.equal(response.statusCode, 404, `${method} ${url}: ${response.body}`)
  }
  const lanStatus = await app.inject({ url: "/api/remote-control/status", remoteAddress: lan, headers })
  const registration = await app.inject({ method: "POST", url: "/api/sidecars", remoteAddress: lan, headers,
    payload: { name: "Fixture", port: 3000 } })
  assert.equal(registration.statusCode, 201, registration.body)
  for (const remoteAddress of [lan, "127.0.0.1"]) {
    const meta = await app.inject({ url: "/api/meta", remoteAddress, headers })
    assert.equal(meta.json().localRequest, remoteAddress === "127.0.0.1")
  }
  assert.equal(lanStatus.json().manageable, false)
  const localDevices = await app.inject({ url: "/api/remote-control/devices", headers: { cookie } })
  assert.equal(localDevices.statusCode, 200)
  const localStatus = await app.inject({ url: "/api/remote-control/status", headers: { cookie } })
  assert.notEqual(localStatus.json().manageable, false)
  const logout = await app.inject({ method: "POST", url: "/api/auth/logout", remoteAddress: lan, headers })
  assert.equal(logout.statusCode, 200)
  assert.match(String(logout.headers["set-cookie"]), /(?:^|; )Max-Age=0(?:;|$)/)
  const status = await app.inject({ url: "/api/auth/status", remoteAddress: lan, headers: { cookie } })
  assert.equal(status.json().authenticated, false)
})

test("skipping auth does not bypass direct listener origin or host restrictions", async t => {
  const { app } = await startRemoteSurface(t, { skipAuth: true })
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/logout", remoteAddress: lan, headers: { origin: foreign } })).statusCode, 403)
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/password", remoteAddress: lan, headers: { origin: own } })).statusCode, 404)
  assert.equal((await app.inject({ url: "/api/meta", remoteAddress: lan })).statusCode, 200)
})

test("extended proxy methods and over-long parameters retain direct admission checks", async t => {
  const { app, authManager } = await startRemoteSurface(t, {
    routes: app => { app.all("/api/test/proxy", async () => ({ ok: true })) },
  })
  const cookie = `${authManager.getCookieName()}=${authManager.createSession("codenomad").id}`
  for (const [method] of PROXIED_HTTP_METHODS) {
    for (const origin of [undefined, foreign, own]) {
      const response = await app.inject({ method: method as HTTPMethods, url: "/api/test/proxy", remoteAddress: lan,
        headers: { cookie, ...(origin ? { origin } : {}) } })
      assert.equal(response.statusCode, origin === own ? 200 : 403, `${method}: ${origin}`)
    }
    const sidecar = await app.inject({ method: method as HTTPMethods, url: "/sidecars/fixture/x", remoteAddress: lan,
      headers: { cookie, origin: own } })
    assert.equal(sidecar.statusCode, 404, method)
  }
  const long = "x".repeat(101)
  assert.equal((await app.inject({ method: "POST", url: `/sidecars/${long}/x`, remoteAddress: lan,
    headers: { cookie, origin: own } })).statusCode, 404)
  assert.equal((await app.inject({ method: "POST", url: `/api/workspaces/${long}`, remoteAddress: lan,
    headers: { cookie, origin: foreign } })).statusCode, 403)
})

test("a preview capability Host cannot authorize application routes that take precedence over its wildcard", async t => {
  const { app, previewManager } = await startRemoteSurface(t)
  const preview = previewManager.create("fixture", "http://127.0.0.1:1")
  const host = `${preview.token}.preview.localhost`
  for (const remoteAddress of [lan, "127.0.0.1"]) {
    for (const method of ["GET", "POST"] as const) {
      const response = await app.inject({ method, url: "/api/sidecars", remoteAddress, headers: { host } })
      assert.equal(response.statusCode, method === "POST" && remoteAddress === lan ? 403 : 401, response.body)
    }
    const meta = await app.inject({ url: "/api/meta", remoteAddress, headers: { host } })
    assert.equal(meta.statusCode, 401)
    const login = await app.inject({ method: "POST", url: "/api/auth/login", remoteAddress,
      headers: { host, origin: "null" }, payload: { username: "codenomad", password: "local-password" } })
    assert.equal(login.statusCode, 403)
    assert.equal(login.headers["access-control-allow-origin"], undefined)
  }
})
