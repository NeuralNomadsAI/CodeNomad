import assert from "node:assert/strict"
import test from "node:test"
import type { HTTPMethods } from "fastify"
import { startRemoteSurface } from "../remote-control/test-support/surface"
import { parseAllowedOrigins } from "./direct-origin"
import { PROXIED_HTTP_METHODS } from "./proxied-http-methods"

const own = "http://localhost:0" // advertised origin in the real application fixture
const trusted = "https://ui.example.test"
const foreign = "https://other.example.test"
const lan = "192.0.2.20"

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
  assert.ok(login.headers["set-cookie"])
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
