import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { once } from "node:events"
import fs from "node:fs"
import http, { type IncomingHttpHeaders } from "node:http"
import https from "node:https"
import type { Socket } from "node:net"
import os from "node:os"
import path from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import test, { type TestContext } from "node:test"
import Fastify from "fastify"
import pino from "pino"
import { RemoteServerBrowseManager } from "./browse-manager"
import { RemotePreviewCapabilities } from "./preview-capabilities"
import { RELAY_AUTHORITY_HEADER as AUTHORITY, RELAY_BOOTSTRAP } from "./relay-authority"
import { registerRemotePreviewCapabilityRoutes } from "../server/routes/remote-preview-capabilities"
import { registerBackendRelayRoutes } from "../server/routes/backend-relay"
import { RemoteIngress } from "../remote-control/ingress"
import { startRemoteSurface } from "../remote-control/test-support/surface"
import type { openSshForward } from "./ssh"
import { resolveHttpsOptions } from "../server/tls"

const TOKEN = "11111111-1111-4111-8111-111111111111"
const logger = pino({ level: "silent" })
const bounded = <T>(value: Promise<T>) => Promise.race([value, new Promise<never>((_, reject) => {
  const timer = setTimeout(() => reject(new Error("Timed out")), 5000)
  timer.unref()
  void value.finally(() => clearTimeout(timer)).catch(() => {})
})])

async function remote(t: TestContext, label: string, application = false, tls?: https.ServerOptions) {
  const requests: { path: string; headers: IncomingHttpHeaders }[] = []
  const sockets = new Set<Socket>()
  const httpStreams = new Set<http.ServerResponse>()
  const wsStreams = new Set<Socket>()
  let live = true
  let identity = label
  const listener: http.RequestListener = async (request, reply) => {
    const url = request.url!
    requests.push({ path: url, headers: request.headers })
    if (url === "/api/meta") return reply.end(JSON.stringify({ serverId: identity }))
    if (url === "/api/auth/status") return reply.end(JSON.stringify({ authenticated: true }))
    if (url === "/api/auth/login") { request.resume(); reply.setHeader("set-cookie", "private=identity; HttpOnly"); return reply.end("{}") }
    if (url === "/api/previews") {
      let body = ""
      for await (const chunk of request) body += chunk
      live = true
      return reply.end(JSON.stringify({ token: TOKEN, sessionId: JSON.parse(body).sessionId, targetUrl: "http://app.invalid/start",
        proxyUrl: `/previews/${TOKEN}/start`, createdAt: new Date().toISOString() }))
    }
    if (url === `/api/previews/${TOKEN}` && request.method === "DELETE") { live = false; return reply.writeHead(204).end() }
    if (!live || !application && !url.startsWith(`/previews/${TOKEN}/`)) return reply.writeHead(404).end()
    reply.setHeader("set-cookie", "appCookie=must-stay-private; HttpOnly")
    if (url.endsWith("/redirect")) return reply.writeHead(302, { location: `/previews/${TOKEN}/next` }).end()
    if (url.endsWith("/foreign-redirect")) return reply.writeHead(302, { location: "http://127.0.0.1:1/api/backends/other" }).end()
    reply.setHeader("content-type", "text/plain")
    if (url.endsWith("/stream")) {
      httpStreams.add(reply)
      reply.once("close", () => httpStreams.delete(reply))
      reply.write(label)
      return
    }
    reply.end(`${label}:${url}`)
  }
  const server = tls ? https.createServer(tls, listener) : http.createServer(listener)
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)) })
  server.on("upgrade", (request, socket: Socket) => {
    requests.push({ path: request.url!, headers: request.headers })
    if (!live || request.url !== (application ? "/ws" : `/previews/${TOKEN}/ws`)) return socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSet-Cookie: appCookie=secret\r\n\r\n`)
    wsStreams.add(socket)
    socket.once("close", () => wsStreams.delete(socket))
    socket.once("end", () => socket.end())
    socket.on("data", chunk => {
      // One short, masked text frame is enough to qualify this real echo channel.
      assert.equal(chunk[0], 0x81)
      assert.ok(chunk[1]! & 0x80)
      const size = chunk[1]! & 0x7f
      const body = Buffer.from(chunk.subarray(6, 6 + size))
      for (let i = 0; i < body.length; i++) body[i] = body[i]! ^ chunk[2 + i % 4]!
      socket.write(Buffer.concat([Buffer.from([0x81, body.length]), body]))
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return { origin: `${tls ? "https" : "http"}://127.0.0.1:${(server.address() as { port: number }).port}`, requests,
    changeIdentity: () => { identity = `${label}-replacement` },
    streamsClosed: () => Promise.all([...httpStreams, ...wsStreams].map(stream => new Promise<void>(resolve => stream.once("close", resolve)))) }
}

async function fixture(t: TestContext, ssh = false) {
  const a = await remote(t, "A")
  const b = await remote(t, "B")
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "remote-preview-capabilities-"))
  const profiles = [
    { id: "a", baseUrl: ssh ? "http://remote.invalid:9898" : a.origin, ...(ssh ? { ssh: { host: "lab" } } : {}) },
    { id: "b", baseUrl: b.origin },
  ]
  const settings = { getOwner: () => ({ remoteServers: profiles }), configYamlPathForAuthority: () => path.join(directory, "config.yaml") }
  let forwardClosed = false
  let dieForward = () => {}
  const open: typeof openSshForward = (_host, _target, options) => {
    dieForward = () => options?.onExit?.()
    return { ready: Promise.resolve(Number(new URL(a.origin).port)), close: () => { forwardClosed = true } }
  }
  const manager = new RemoteServerBrowseManager(settings, open)
  const app = Fastify()
  let origin = ""
  registerRemotePreviewCapabilityRoutes(app, { manager, logger, getSelfOrigins: () => new Set([origin]) })
  registerBackendRelayRoutes(app, { manager, getSelfOrigins: () => new Set([origin]) })
  const ingress = new RemoteIngress((request, reply) => app.routing(request, reply))
  await app.listen({ host: "127.0.0.1", port: 0 })
  origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
  const ingressOrigin = `http://${await ingress.start()}`
  t.after(async () => {
    await ingress.stop()
    await app.close()
    manager.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const proofs: Record<string, string> = {}
  for (const id of ["a", "b"]) {
    const response = await manager.relay(id, "/api/meta", {}, RELAY_BOOTSTRAP)
    proofs[id] = response.headers.get(AUTHORITY)!
  }
  const call = (id: string, suffix = "", options: Parameters<typeof send>[1] = {}) => send(
    `${origin}/api/backends/${id}/preview-capabilities${suffix}`,
    { method: "POST", body: JSON.stringify({ sessionId: "session", url: "http://app.invalid/start" }),
      ...options, headers: { origin, [AUTHORITY]: proofs[id]!, "content-type": "application/json", ...options.headers } })
  const create = async (id = "a") => {
    const response = await call(id)
    assert.equal(response.status, 200, response.body)
    return JSON.parse(response.body) as { token: string; capability: string; contentUrl: string }
  }
  return { a, b, manager, app, origin, ingressOrigin, proofs, profiles, call, create, settings, open,
    forwardClosed: () => forwardClosed, dieForward: () => dieForward() }
}

function send(source: string, options: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
  const url = new URL(source)
  return bounded(new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port: url.port, path: `${url.pathname}${url.search}`,
      method: options.method, headers: { host: url.host, ...options.headers } }, response => {
      let body = ""
      response.on("data", chunk => { body += chunk })
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body }))
    })
    request.on("error", reject)
    request.end(options.body)
  }))
}

async function websocket(source: string, options: { origin?: string | null } = {}) {
  const url = new URL("/ws", source)
  return bounded(new Promise<{ socket: Socket; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port: url.port, path: url.pathname,
      headers: { host: url.host, origin: options.origin === null ? undefined : options.origin ?? url.origin, connection: "Upgrade", upgrade: "websocket",
        "sec-websocket-key": randomBytes(16).toString("base64"), "sec-websocket-version": "13", cookie: "ui=secret", authorization: "Basic secret" } })
    request.on("upgrade", (response, socket) => resolve({ socket, headers: response.headers }))
    request.on("response", response => { response.resume(); reject(new Error(`Upgrade ${response.statusCode}`)) })
    request.on("error", reject)
    request.end()
  }))
}

test("only the owning local UI can issue or revoke backend-generation capabilities", async t => {
  const f = await fixture(t)
  const before = f.a.requests.length
  for (const origin of ["null", "http://foreign.invalid", "http://known.preview.localhost", ""]) {
    assert.equal((await f.call("a", "", { headers: { origin } })).status, 403)
  }
  assert.equal((await send(`${f.ingressOrigin}/api/backends/a/preview-capabilities`, {
    method: "POST", headers: { origin: f.origin, [AUTHORITY]: f.proofs.a!, "content-type": "application/json" }, body: "{}",
  })).status, 403)
  for (const proof of ["", "x".repeat(43), f.proofs.b!, RELAY_BOOTSTRAP]) {
    assert.equal((await f.call("a", "", { headers: { [AUTHORITY]: proof } })).status, 404)
  }
  assert.equal(f.a.requests.length, before)
  const cap = await f.create()
  assert.notEqual(cap.capability, cap.token)
  assert.notEqual(cap.capability, f.proofs.a)
  for (const [id, capability, proof] of [["b", cap.capability, f.proofs.b!], ["a", TOKEN, f.proofs.a!], ["a", cap.capability, f.proofs.b!]]) {
    assert.equal((await f.call(id!, `/${capability}`, { method: "DELETE", body: undefined, headers: { [AUTHORITY]: proof! } })).status, 404)
  }
  assert.equal((await send(cap.contentUrl)).status, 200)
  assert.equal((await f.call("a", `/${cap.capability}`, { method: "DELETE", body: undefined })).status, 204)
  assert.equal((await send(cap.contentUrl)).status, 404)
})

test("isolated origins reserve every path and keep identical remote paths/tokens apart", async t => {
  const f = await fixture(t)
  const a = await f.create()
  const b = await f.create("b")
  assert.equal(a.token, b.token)
  assert.notEqual(new URL(a.contentUrl).origin, new URL(b.contentUrl).origin)
  for (const [cap, label] of [[a, "A"], [b, "B"]] as const) {
    for (const pathname of ["/", "/api/meta", "/api/backends/b/api/filesystem", `/previews/${TOKEN}/asset.js`, "/api/previews"]) {
      const response = await send(new URL(pathname, cap.contentUrl).href)
      assert.equal(response.status, 200)
      assert.match(response.body, new RegExp(`^${label}:`))
      assert.equal(response.headers["set-cookie"], undefined)
      assert.match(String(response.headers["content-security-policy"]), /^sandbox /)
    }
    assert.equal((await send(new URL("/api/backends", cap.contentUrl).href, { headers: { origin: f.origin } })).status, 404)
    const unknown = new URL(cap.contentUrl)
    unknown.hostname = `${TOKEN}.preview.localhost`
    assert.equal((await send(unknown.href)).status, 404)
    unknown.hostname = "127.0.0.1"
    assert.equal((await send(unknown.href)).status, 404)
  }
  const before = f.a.requests.length
  assert.equal((await send(`${f.origin}/api/backends/a/previews/${TOKEN}/start`, {
    headers: { origin: f.origin, [AUTHORITY]: f.proofs.a! },
  })).status, 404)
  assert.equal(f.a.requests.length, before)
})

test("HTTP navigation and WebSocket echo use only the captured content destination, without cookies", async t => {
  const f = await fixture(t)
  const cap = await f.create()
  const response = await send(new URL("/redirect", cap.contentUrl).href, { headers: { cookie: "ui=secret", authorization: "Basic secret" } })
  assert.equal(response.status, 302)
  assert.equal(response.headers.location, `/previews/${TOKEN}/next`)
  assert.equal(response.headers["set-cookie"], undefined)
  assert.equal((await send(new URL(response.headers.location!, cap.contentUrl).href)).status, 200)
  assert.equal((await send(new URL("/foreign-redirect", cap.contentUrl).href)).status, 404)
  const ws = await websocket(cap.contentUrl)
  t.after(() => ws.socket.destroy())
  assert.equal(ws.headers["set-cookie"], undefined)
  const echoed = once(ws.socket, "data")
  ws.socket.write(Buffer.from([0x81, 0x82, 1, 2, 3, 4, 104 ^ 1, 105 ^ 2]))
  assert.deepEqual((await bounded(echoed))[0], Buffer.from([0x81, 2, 104, 105]))
  for (const request of f.a.requests.filter(request => request.path.startsWith("/previews/"))) {
    assert.equal(request.headers.cookie, undefined)
    assert.equal(request.headers.authorization, undefined)
    assert.equal(request.headers[AUTHORITY], undefined)
    assert.equal(request.headers["x-codenomad-server-request"], undefined)
  }
})

test("own-origin fetch preflights are capability-scoped and application headers survive without backend markers", async t => {
  const f = await fixture(t)
  const cap = await f.create()
  const source = new URL("/fetch", cap.contentUrl).href
  const before = f.a.requests.length
  const preflight = await send(source, { method: "OPTIONS", headers: {
    origin: new URL(source).origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-app",
  } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers["access-control-allow-origin"], new URL(source).origin)
  assert.equal(preflight.headers["access-control-allow-methods"], "POST")
  assert.equal(preflight.headers["access-control-allow-headers"], "content-type,x-app")
  assert.equal(preflight.headers["access-control-allow-credentials"], undefined)
  assert.equal(f.a.requests.length, before)
  assert.equal((await send(source, { method: "POST", body: "{}", headers: {
    origin: new URL(source).origin, "content-type": "application/json", "x-app": "kept",
    [AUTHORITY]: f.proofs.a!, "x-codenomad-server-request": "1", referer: cap.contentUrl, cookie: "ui=secret",
  } })).status, 200)
  const headers = f.a.requests.at(-1)!.headers
  assert.equal(headers["x-app"], "kept")
  for (const name of [AUTHORITY, "x-codenomad-server-request", "referer", "origin", "cookie"]) assert.equal(headers[name], undefined)
})

test("HTTP/preflights and WS reject null, foreign and missing upgrade origins before upstream dispatch", async t => {
  const f = await fixture(t)
  const cap = await f.create(), other = await f.create("b")
  const source = new URL("/data", cap.contentUrl).href
  const before = f.a.requests.length
  for (const origin of ["null", new URL(other.contentUrl).origin, f.origin]) {
    assert.equal((await send(source, { headers: { origin } })).status, 404)
    assert.equal((await send(source, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } })).status, 404)
    await assert.rejects(websocket(cap.contentUrl, { origin }))
  }
  await assert.rejects(websocket(cap.contentUrl, { origin: null }))
  assert.equal(f.a.requests.length, before)
  const own = await send(source, { headers: { origin: new URL(source).origin } })
  assert.equal(own.status, 200)
  assert.equal(own.headers["cross-origin-resource-policy"], "same-origin")
  assert.match(String(own.headers["content-security-policy"]), new RegExp(`frame-ancestors 'self' ${f.origin}`))
})

for (const action of ["close", "detach", "remove", "retarget", "forget", "shutdown"] as const) {
  test(`${action} revokes capability and cuts active HTTP and WebSocket streams`, async t => {
    const f = await fixture(t)
    const cap = await f.create()
    const url = new URL("/stream", cap.contentUrl)
    const response = await bounded(new Promise<http.IncomingMessage>((resolve, reject) => {
      http.get({ hostname: "127.0.0.1", port: url.port, path: url.pathname, headers: { host: url.host } }, resolve).on("error", reject)
    }))
    await bounded(once(response, "data"))
    const ws = await websocket(cap.contentUrl)
    const httpClosed = new Promise<void>(resolve => response.once("close", resolve))
    const wsClosed = new Promise<void>(resolve => ws.socket.once("close", () => resolve()))
    const upstreamClosed = f.a.streamsClosed()
    ws.socket.resume()
    if (action === "close") await f.call("a", `/${cap.capability}`, { method: "DELETE", body: undefined })
    if (action === "detach") await f.call("a", "", { method: "DELETE", body: undefined })
    if (action === "remove") { f.profiles.splice(0, 1); f.manager.reconcile() }
    if (action === "retarget") { f.profiles[0]!.baseUrl = f.b.origin; f.manager.reconcile() }
    if (action === "forget") await f.manager.forget("a")
    if (action === "shutdown") await f.app.close()
    await bounded(Promise.all([httpClosed, wsClosed, upstreamClosed]))
    if (action !== "shutdown") assert.equal((await send(cap.contentUrl)).status, 404)
    else await assert.rejects(send(cap.contentUrl))
  })
}

test("detach revokes across listeners but permits a fresh attachment under the retained backend proof", async t => {
  const f = await fixture(t)
  const other = new RemoteServerBrowseManager(f.settings, f.open)
  const previews = new RemotePreviewCapabilities(other, logger)
  t.after(async () => { await previews.close(); other.close() })
  const cap = await previews.create("a", f.proofs.a!, { sessionId: "second", url: "http://app.invalid/start" })
  await f.call("a", "", { method: "DELETE", body: undefined })
  assert.equal((await send(cap.contentUrl)).status, 404)
  const next = await f.create()
  assert.equal((await send(next.contentUrl)).status, 200)
  f.manager.assertProof("a", f.proofs.a)
})

test("SSH content HTTP/WS use the gated forward and retain the declared Host", async t => {
  const f = await fixture(t, true)
  const cap = await f.create()
  assert.equal((await send(cap.contentUrl)).status, 200)
  const ws = await websocket(cap.contentUrl)
  ws.socket.destroy()
  for (const request of f.a.requests) assert.equal(request.headers.host, "remote.invalid:9898")
  f.profiles[0]!.ssh!.host = "other"
  f.manager.reconcile()
  assert.equal(f.forwardClosed(), true)
  assert.equal((await send(cap.contentUrl)).status, 404)
})

test("a renewed SSH forward verifies remote identity before HTTP or WS content dispatch", async t => {
  const f = await fixture(t, true)
  const cap = await f.create()
  const ws = await websocket(cap.contentUrl)
  ws.socket.resume()
  const closed = new Promise<void>(resolve => ws.socket.once("close", () => resolve()))
  f.dieForward()
  f.a.changeIdentity()
  const before = f.a.requests.filter(request => request.path.startsWith("/previews/")).length
  const response = await send(cap.contentUrl)
  assert.equal(response.status, 404)
  await bounded(closed)
  assert.equal(f.a.requests.filter(request => request.path.startsWith("/previews/")).length, before)
  await assert.rejects(websocket(cap.contentUrl))
  assert.throws(() => f.manager.assertProof("a", f.proofs.a))
})

test("a replaced backend generation cannot reuse an old content capability", async t => {
  const f = await fixture(t)
  const cap = await f.create()
  await f.manager.forget("a")
  const nextProof = (await f.manager.relay("a", "/api/meta", {}, RELAY_BOOTSTRAP)).headers.get(AUTHORITY)!
  assert.notEqual(nextProof, f.proofs.a)
  const before = f.a.requests.length
  assert.equal((await f.call("a")).status, 404)
  assert.equal((await send(cap.contentUrl)).status, 404)
  assert.equal(f.a.requests.length, before)
  f.proofs.a = nextProof
  assert.equal((await send((await f.create()).contentUrl)).status, 200)
})

test("HTTPS content and WSS honor the saved TLS policy through an identity-gated SSH forward", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "preview-capability-tls-"))
  const tls = resolveHttpsOptions({ enabled: true, configDir: directory, host: "localhost", tlsSANs: "remote.test", logger })!
  const previous = getCACertificates()
  setDefaultCACertificates([...previous, fs.readFileSync(tls.caCertPath!, "utf8")])
  const backend = await remote(t, "TLS", false, tls.httpsOptions)
  const profiles = [{ id: "tls", baseUrl: "https://remote.test:9898", skipTlsVerify: false, ssh: { host: "tls-host" } }]
  const manager = new RemoteServerBrowseManager({
    getOwner: () => ({ remoteServers: profiles }), configYamlPathForAuthority: () => path.join(directory, "config.yaml"),
  }, () => ({ ready: Promise.resolve(Number(new URL(backend.origin).port)), close() {} }))
  const previews = new RemotePreviewCapabilities(manager, logger)
  t.after(async () => {
    setDefaultCACertificates(previous)
    await previews.close()
    manager.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const create = async () => {
    const proof = (await manager.relay("tls", "/api/meta", {}, RELAY_BOOTSTRAP)).headers.get(AUTHORITY)!
    return previews.create("tls", proof, { sessionId: "tls", url: "http://app.invalid/start" })
  }
  const cap = await create()
  assert.equal((await send(cap.contentUrl)).status, 200)
  const ws = await websocket(cap.contentUrl)
  ws.socket.destroy()
  for (const request of backend.requests) assert.equal(request.headers.host, "remote.test:9898")
  setDefaultCACertificates(previous)
  assert.equal((await send(cap.contentUrl)).status, 404)
  await assert.rejects(websocket(cap.contentUrl))
  profiles[0]!.skipTlsVerify = true
  manager.reconcile()
  assert.equal((await send(cap.contentUrl)).status, 404)
  const allowed = await create()
  assert.equal((await send(allowed.contentUrl)).status, 200)
  const allowedWs = await websocket(allowed.contentUrl)
  allowedWs.socket.destroy()
})

test("real remote CodeNomad HTTP/WS path proxies remain cookie-free", async t => {
  const app = await remote(t, "APP", true)
  const surface = await startRemoteSurface(t, { configureApp: instance => {
    instance.addHook("onSend", (request, _reply, payload, done) => {
      done(null, request.url === "/api/meta" ? JSON.stringify({ serverId: "real-backend" }) : payload)
    })
  } })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "real-preview-capability-"))
  const settings = { getOwner: () => ({ remoteServers: [{ id: "real", baseUrl: `http://${surface.local}` }] }),
    configYamlPathForAuthority: () => path.join(directory, "config.yaml") }
  const manager = new RemoteServerBrowseManager(settings)
  const previews = new RemotePreviewCapabilities(manager, logger)
  t.after(async () => { await previews.close(); manager.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  await manager.connect("real", { username: "codenomad", password: "local-password" })
  const proof = (await manager.relay("real", "/api/meta", {}, RELAY_BOOTSTRAP)).headers.get(AUTHORITY)!
  const cap = await previews.create("real", proof, { sessionId: "real", url: app.origin })
  const result = await send(cap.contentUrl, { headers: { cookie: "ui=secret" } })
  assert.equal(result.status, 200)
  assert.equal(result.body, "APP:/")
  assert.ok(app.requests.length > 0, "real remote preview proxy contacted the app")
  assert.equal(app.requests.at(-1)!.headers.cookie, undefined)
  assert.equal(result.headers["set-cookie"], undefined)
  const ws = await websocket(cap.contentUrl)
  t.after(() => ws.socket.destroy())
  const echoed = once(ws.socket, "data")
  ws.socket.write(Buffer.from([0x81, 0x82, 1, 2, 3, 4, 104 ^ 1, 105 ^ 2]))
  assert.deepEqual((await bounded(echoed))[0], Buffer.from([0x81, 2, 104, 105]))
  assert.ok(surface.previewManager.get(cap.token))
  previews.revoke(cap.capability)
})
