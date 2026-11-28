import assert from "node:assert/strict"
import os from "node:os"
import { test } from "node:test"
import { backendAdmissionFixture, backendAuthorityHeader, backendBootstrap } from "./test-support/backend-admission"
import { startRemoteSurface } from "./test-support/surface"

test("an authenticated HTTPS browser signs into a second saved password server, then browses and opens its project", async t => {
  const lan = Object.values(os.networkInterfaces()).flat().find(value => value?.family === "IPv4" && !value.internal)?.address
  if (!lan) return t.skip("a non-loopback IPv4 interface is required")
  const f = await backendAdmissionFixture(t)
  let opened = false
  const project = { id: "project-b", path: "/srv/app", status: "ready", proxyPath: "/workspaces/project-b/instance" }
  const destination = await startRemoteSurface(t, { bindHost: lan, browse: true, password: "destination-password",
    serverIdentity: { serverId: "password-b", apiContract: 1 },
    workspaceManager: {
      list: () => opened ? [project] : [],
      create: () => { opened = true; return { created: true, workspace: project } },
    },
  })
  const baseUrl = `http://${lan}:${new URL(`http://${destination.local}`).port}`
  const profiles = f.settings.getOwner("state", "ui").remoteServers as { id: string; baseUrl: string }[]
  f.settings.mergePatchOwner("state", "ui", { remoteServers: [profiles[0], { id: "B", baseUrl }] })
  const origin = "https://browser.example.test"
  const { app } = await startRemoteSurface(t, { settings: f.settings, allowedOrigins: [origin] })
  const options = { remoteAddress: "192.0.2.10", headers: { host: new URL(origin).host, origin } }
  const login = await app.inject({ ...options, method: "POST", url: "/api/auth/login", payload: {
    username: "codenomad", password: "local-password",
  } })
  assert.equal(login.statusCode, 200, login.body)
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!
  const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
    app.inject({ ...options, method: "POST", url, payload, headers: { ...options.headers, cookie, ...headers } })
  const get = (url: string, proof: string) =>
    app.inject({ ...options, url, headers: { ...options.headers, cookie, [backendAuthorityHeader]: proof } })
  assert.equal((await get("/api/backends/A/api/meta", backendBootstrap)).statusCode, 200)
  const browse = "/api/remote-servers/B/browse"
  const connect = "/api/remote-servers/B/connect"
  const before = await post(browse, {})
  assert.equal(before.statusCode, 409)
  assert.equal(before.json().error, "needs_credentials")
  const credentials = { username: "codenomad", password: "destination-password" }
  const validate = t.mock.method(destination.authManager, "validateLogin")
  const originless = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(credentials),
  })
  assert.equal(originless.status, 403, "the destination keeps its direct-listener CSRF check")
  await originless.body?.cancel()
  const refusal = await post(connect, credentials, { origin: "https://foreign.example.test" })
  assert.equal(refusal.statusCode, 403)
  assert.equal(validate.mock.callCount(), 0)
  const connected = await post(connect, credentials)
  assert.equal(connected.statusCode, 200, connected.body)
  assert.equal(connected.headers["set-cookie"], undefined)
  assert.equal(validate.mock.callCount(), 1)
  const listing = await post(browse, {})
  assert.equal(listing.statusCode, 200, listing.body)
  assert.equal(listing.json().listing.entries[0].path, project.path)
  const bootstrap = await get("/api/backends/B/api/meta", backendBootstrap)
  assert.equal(bootstrap.statusCode, 200, bootstrap.body)
  assert.equal(bootstrap.json().serverId, "password-b")
  const proof = String(bootstrap.headers[backendAuthorityHeader])
  const created = await post("/api/backends/B/api/workspaces", { path: project.path }, { [backendAuthorityHeader]: proof })
  assert.equal(created.statusCode, 201, created.body)
  const inventory = await get("/api/backends/B/api/workspaces", proof)
  assert.equal(inventory.statusCode, 200, inventory.body)
  assert.equal(inventory.json()[0].id, project.id)
  assert.equal(validate.mock.callCount(), 1, "later relay calls reuse the host's private session")
})
