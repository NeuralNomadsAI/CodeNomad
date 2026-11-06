import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import https from "node:https"
import { once } from "node:events"
import test, { type TestContext } from "node:test"
import type { RemoteTunnel } from "@codenomad/remote-tunnel"
import { RemoteServerBrowseManager } from "./browse-manager"
import { CodeNomadServerClient } from "./client"
import { startFakeCodeNomad } from "./test-support/fake-codenomad"
import { startRemoteSurface } from "../remote-control/test-support/surface"
import { resolveHttpsOptions } from "../server/tls"
import { SERVER_PAIR_PATH } from "../remote-control/server-pairing"
import { createLogger } from "../logger"
import { redactSecrets } from "../server/request-logging"

const logger = createLogger({ level: "silent" } as never)
function directory(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-server-pair-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
function tls(t: TestContext) {
  return resolveHttpsOptions({ enabled: true, configDir: directory(t), host: "localhost", logger })!.httpsOptions
}

test("real TLS tunnel exchange verifies status, persists only the device, browses after restart and clears revocation", async t => {
  const tlsOptions = tls(t)
  const requests: { path: string; headers: http.IncomingHttpHeaders }[] = []
  const f = await startRemoteSurface(t, { browse: true, openTunnel: async options => {
    const [hostname, port] = options.target.split(":")
    const server = https.createServer(tlsOptions, (request, response) => {
      requests.push({ path: request.url!, headers: { ...request.headers } })
      const proxy = http.request({ hostname, port, path: request.url, method: request.method, headers: request.headers }, upstream => {
        response.writeHead(upstream.statusCode!, upstream.headers)
        upstream.pipe(response)
      })
      proxy.on("error", () => response.destroy())
      request.pipe(proxy)
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const host = `127.0.0.1:${(server.address() as { port: number }).port}`
    let resolveClosed!: (error: string | undefined) => void
    const closed = new Promise<string | undefined>(resolve => { resolveClosed = resolve })
    return { url: `https://${host}`, hostname: host, status: () => ({ state: "connected", connections: 0 }), closed,
      close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); resolveClosed(undefined) } } satisfies RemoteTunnel
  } })
  const dir = directory(t)
  const origin = new URL(f.pairing.url).origin
  const profiles = [{ id: "saved", baseUrl: origin, skipTlsVerify: false }]
  const settings = { getOwner: () => ({ remoteServers: profiles }), configYamlPathForAuthority: () => path.join(dir, "config.yaml") }
  const manager = new RemoteServerBrowseManager(settings)
  t.after(() => manager.close())
  await assert.rejects(manager.connect("saved", { pairingLink: f.pairing.url }), { code: "tls" })
  assert.equal(requests.length, 0)
  profiles[0]!.skipTlsVerify = true
  assert.deepEqual(await manager.connect("saved", { pairingLink: f.pairing.url }), { ok: true })
  assert.deepEqual(requests.map(request => request.path), [SERVER_PAIR_PATH, "/api/auth/status"])
  const exchange = requests[0]!.headers
  for (const name of ["origin", "cookie", "authorization", "proxy-authorization", "referer", "sec-fetch-mode", "sec-fetch-site"]) assert.equal(exchange[name], undefined, name)
  assert.equal(exchange["x-codenomad-server-pairing"], "1")
  const device = f.manager.devices()[0]!
  assert.equal(device.name, `CodeNomad · ${os.hostname()}`.slice(0, 80))
  const file = path.join(dir, "remote-server-credentials.json")
  const stored = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.deepEqual(Object.keys(stored.servers.saved.secret).sort(), ["cookie", "kind"])
  assert.equal(stored.servers.saved.origin, origin)
  assert.equal(stored.servers.saved.secret.kind, "device")
  assert.match(stored.servers.saved.secret.cookie, /^__Host-codenomad_device=[A-Za-z0-9_-]{43}$/)
  assert(!fs.readFileSync(file, "utf8").includes(f.code))
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const browse = await manager.browse("saved", {})
  assert.equal(browse.listing.metadata.currentPath, "/srv")
  assert(!JSON.stringify(browse).includes(stored.servers.saved.secret.cookie))
  manager.close()
  const next = new RemoteServerBrowseManager(settings)
  t.after(() => next.close())
  assert.equal((await next.browse("saved", {})).listing.metadata.currentPath, "/srv")
  assert(requests.every(request => request.headers.origin === undefined))
  assert.equal(requests.filter(request => request.path === SERVER_PAIR_PATH).length, 1)
  assert(f.manager.revokeDevice(device.id))
  await assert.rejects(next.browse("saved", {}), { code: "auth" })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { servers: {} })
  await assert.rejects(next.browse("saved", {}), { code: "needs_credentials" })
  assert.deepEqual(await next.connect("saved", { pairingLink: f.manager.createPairing().url }), { ok: true })
  await next.forget("saved")
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { servers: {} })
  assert.deepEqual(redactSecrets({ credential: "private", pairingLink: f.pairing.url }), { credential: "<redacted>", pairingLink: "<redacted>" })
})

test("link syntax and saved-origin fences reject before DNS or dispatch", async t => {
  const dir = directory(t)
  const origin = "https://does-not-resolve.invalid"
  const manager = new RemoteServerBrowseManager({ getOwner: () => ({ remoteServers: [{ id: "saved", baseUrl: origin }] }), configYamlPathForAuthority: () => path.join(dir, "config.yaml") })
  t.after(() => manager.close())
  const code = "a".repeat(32)
  for (const link of [
    `http://does-not-resolve.invalid/remote-pair#${code}`, `https://foreign.invalid/remote-pair#${code}`,
    `${origin}/remote-pair?query=1#${code}`, `${origin}/remote-pair?#${code}`, `${origin}/other#${code}`,
    `https://user@does-not-resolve.invalid/remote-pair#${code}`, `${origin}/x/../remote-pair#${code}`,
    `${origin}/remote-pair#short`, `${origin}/remote-pair#${code}%00`, `${origin}/remote-pair#${code}/`,
  ]) await assert.rejects(manager.connect("saved", { pairingLink: link }), { code: "pairing_expired" })
  assert.equal(fs.existsSync(path.join(dir, "remote-server-credentials.json")), false)
})

test("older endpoints and refused/malformed exchanges yield stable errors without credentials or ambient cookies", async t => {
  const remote = await startFakeCodeNomad({ tls: tls(t) })
  t.after(() => remote.close())
  const dir = directory(t)
  const manager = new RemoteServerBrowseManager({ getOwner: () => ({ remoteServers: [{ id: "saved", baseUrl: remote.origin, skipTlsVerify: true }] }), configYamlPathForAuthority: () => path.join(dir, "config.yaml") })
  t.after(() => manager.close())
  const link = `${remote.origin}/remote-pair#${"a".repeat(32)}`
  for (const [status, code] of [[403, "pairing_unavailable"], [404, "pairing_unavailable"], [405, "pairing_unavailable"], [400, "pairing_expired"], [401, "pairing_expired"], [410, "pairing_expired"], [429, "pairing_rate_limited"], [500, "unreachable"]] as const) {
    remote.state.overrides.set(SERVER_PAIR_PATH, { status, body: { credential: "must-not-leak" }, headers: { "set-cookie": "guest=ambient; Path=/" } })
    await assert.rejects(manager.connect("saved", { pairingLink: link }), { code })
  }
  for (const body of [null, { credential: "injected; cookie=x" }, { device: {}, credential: "x".repeat(43) }, { payload: "x".repeat(4096) }]) {
    remote.state.overrides.set(SERVER_PAIR_PATH, { status: 200, body, headers: { "set-cookie": "guest=ambient; Path=/" } })
    await assert.rejects(manager.connect("saved", { pairingLink: link }), { code: "unreachable" })
  }
  assert.equal(fs.existsSync(path.join(dir, "remote-server-credentials.json")), false)
  assert(remote.state.requests.every(request => request.path === SERVER_PAIR_PATH && !request.headers.origin && !request.headers.cookie && !request.headers["sec-fetch-mode"]))
  assert(remote.state.requests.every(request => JSON.parse(request.body).hostName === os.hostname()))
  const credential = "a".repeat(43)
  const device = { id: "12345678-1234-4123-8123-123456789012", name: "CodeNomad · test", createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() }
  remote.state.overrides.set(SERVER_PAIR_PATH, { status: 200, body: { credential, device }, headers: { "set-cookie": "guest=ambient; Path=/" } })
  remote.state.overrides.set("/api/auth/status", { status: 200, body: { authenticated: false }, headers: { "set-cookie": "guest=ambient; Path=/" } })
  await assert.rejects(manager.connect("saved", { pairingLink: link }), { code: "needs_credentials" })
  assert.equal(fs.existsSync(path.join(dir, "remote-server-credentials.json")), false, "even a well-formed exchange must authenticate before persistence")
  assert.equal(remote.state.requests.at(-1)!.headers.cookie, `__Host-codenomad_device=${credential}`)
  remote.state.overrides.set("/api/auth/status", { status: 200, body: { authenticated: true } })
  assert.deepEqual(await manager.connect("saved", { pairingLink: link }), { ok: true })
  remote.state.overrides.set("/api/auth/status", { status: 401, body: { error: "revoked" } })
  await assert.rejects(manager.connect("saved", {}), { code: "auth" })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "remote-server-credentials.json"), "utf8")), { servers: {} }, "a refused saved identity is cleared by connect as well as browse")
  // Pairing remains independent even when a client was constructed with an ambient session.
  const client = new CodeNomadServerClient(remote.origin, { kind: "session", cookie: "guest=existing" }, { skipTlsVerify: true })
  t.after(() => client.close())
  assert.deepEqual(await client.pair("a".repeat(32)), { kind: "device", cookie: `__Host-codenomad_device=${credential}` })
  assert.equal(remote.state.requests.at(-1)!.headers.cookie, undefined)
  remote.state.overrides.set(SERVER_PAIR_PATH, { status: 302, body: {}, headers: { location: "/api/auth/status" } })
  const beforeRedirect = remote.state.requests.length
  await assert.rejects(client.pair("a".repeat(32)), { code: "redirect" })
  assert.equal(remote.state.requests.length, beforeRedirect + 1)
})
