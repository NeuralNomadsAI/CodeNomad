import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { once } from "node:events"
import fs from "node:fs"
import http, { type IncomingHttpHeaders } from "node:http"
import https from "node:https"
import net, { type Socket } from "node:net"
import os from "node:os"
import test, { type TestContext } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import pino from "pino"
import { RELAY_AUTHORITY_HEADER as AUTHORITY, RELAY_BOOTSTRAP } from "../codenomad-servers/relay-authority"
import { PREVIEW_SANDBOX_FLAGS } from "../previews/sandbox"
import { resolveHttpsOptions } from "../server/tls"
import { PREVIEW_PREFIX as PREFIX, PREVIEW_TOKEN as TOKEN, previewRemoteSettings, startPreviewRemote } from "./test-support/preview-remotes"
import { FAKE_TUNNEL_HOST, startRemoteSurface } from "./test-support/surface"

type Channel = "RC" | "HTTPS" | "LAN"
type Reply = { status: number; headers: IncomingHttpHeaders; body: string }
type Options = { method?: string; headers?: Record<string, string | undefined>; body?: string }
// Unknown or revoked capabilities fall back to the host's ordinary unauthenticated refusal.
const refused = (reply: Reply, message?: string) => assert.ok([401, 403, 404].includes(reply.status), message ?? `refused, got ${reply.status}`)

function request(base: string, target: string, options: Options = {}, ca?: string): Promise<Reply> {
  const url = new URL(target, base)
  const headers = Object.fromEntries(Object.entries(options.headers ?? {}).filter(([, value]) => value !== undefined)) as Record<string, string>
  return new Promise((resolve, reject) => {
    const outgoing = (url.protocol === "https:" ? https : http).request(url, { method: options.method ?? "GET", ca, path: target, agent: false, headers }, response => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", chunk => { body += chunk })
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body }))
    })
    outgoing.on("error", reject)
    outgoing.end(options.body)
  })
}

type Live = { bytes: number; closed: boolean }
function stream(base: string, target: string, headers: Record<string, string>, ca?: string, upgrade = false): Promise<Live> {
  const url = new URL(target, base)
  const state: Live = { bytes: 0, closed: false }
  return new Promise((resolve, reject) => {
    const outgoing = (url.protocol === "https:" ? https : http).request(url, { ca, path: target, agent: false, headers: upgrade ? {
      ...headers, connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": randomBytes(16).toString("base64"), "sec-websocket-version": "13",
    } : headers }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`stream ${response.statusCode}`)); return }
      response.on("data", chunk => { state.bytes += chunk.length; resolve(state) })
      response.on("error", () => {})
      response.on("close", () => { state.closed = true })
    })
    outgoing.on("upgrade", (response, socket) => {
      assert.equal(response.headers["set-cookie"], undefined)
      socket.on("data", chunk => { state.bytes += chunk.length; resolve(state) })
      socket.on("error", () => {})
      socket.on("close", () => { state.closed = true })
    })
    outgoing.on("error", reject)
    outgoing.end()
  })
}

async function stopped(live: Live, label: string) {
  const deadline = Date.now() + 1800
  while (!live.closed && Date.now() < deadline) await delay(20)
  assert.equal(live.closed, true, `${label} closes within 1800 ms`)
}

async function alive(live: Live) {
  const before = live.bytes
  const deadline = Date.now() + 1800
  while (!live.closed && live.bytes === before && Date.now() < deadline) await delay(20)
  assert.equal(live.closed, false, "unrelated preview stays connected")
  assert.ok(live.bytes > before)
}

/** A TLS-terminating reverse proxy forwarding the public Host, including WebSocket upgrades. */
async function tlsProxy(t: TestContext, backend: string, options: https.ServerOptions) {
  const proxy = https.createServer(options, (incoming, response) => {
    const upstream = http.request(backend, { path: incoming.url, method: incoming.method, headers: incoming.headers }, reply => {
      response.writeHead(reply.statusCode!, reply.headers); reply.pipe(response)
      // Like a real proxy, an aborted upstream response aborts the client response.
      reply.once("close", () => { if (!reply.complete) response.destroy() })
    })
    upstream.on("error", error => response.destroy(error))
    incoming.pipe(upstream)
  })
  proxy.on("upgrade", (incoming, client: Socket, head) => {
    const target = new URL(backend)
    const upstream = net.connect(Number(target.port), target.hostname, () => {
      upstream.write(`${incoming.method} ${incoming.url} HTTP/1.1\r\n${Object.entries(incoming.headers).map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n`)
      upstream.write(head)
      upstream.pipe(client).pipe(upstream)
    })
    for (const socket of [upstream, client]) socket.on("error", () => { upstream.destroy(); client.destroy() })
    client.once("close", () => upstream.destroy())
    upstream.once("close", () => client.destroy())
  })
  proxy.listen(0, "127.0.0.1")
  await once(proxy, "listening")
  t.after(async () => { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())) })
  return `https://localhost:${(proxy.address() as { port: number }).port}`
}

async function fixture(t: TestContext, channel: Channel, options: { multiBackend?: boolean; sessionIdleMs?: number; password?: null } = {}) {
  let logs = ""
  const logger = pino({ level: "trace" }, { write(chunk: string) { logs += chunk } })
  const remotes = [await startPreviewRemote(t, "A"), await startPreviewRemote(t, "B")]
  const { settings, directory } = previewRemoteSettings(t, remotes, logger, options.multiBackend)
  const publicOrigin = channel === "RC" ? `https://${FAKE_TUNNEL_HOST}` : channel === "HTTPS" ? "https://preview-ui.test" : "http://preview-lan.test"
  const surface = await startRemoteSurface(t, { settings, logger, bindHost: "0.0.0.0", allowedOrigins: [publicOrigin], sessionIdleMs: options.sessionIdleMs, password: options.password })
  const host = new URL(publicOrigin).host
  let base = `http://${surface.local}`
  let ca: string | undefined
  const session = () => `${surface.authManager.getCookieName()}=${surface.authManager.createSession("codenomad").id}`
  let cookie: string
  let deviceId: string | undefined
  if (channel === "RC") {
    base = `http://${surface.target()}`
    const paired = surface.manager.exchangePairing(surface.code, "phone")!
    cookie = `__Host-codenomad_device=${paired.token}`
    deviceId = paired.device.id
  } else if (channel === "HTTPS") {
    const tls = resolveHttpsOptions({ enabled: true, configDir: directory, host: "localhost", tlsSANs: "127.0.0.1,preview-ui.test", logger })!
    ca = fs.readFileSync(tls.caCertPath!, "utf8")
    base = await tlsProxy(t, base, tls.httpsOptions)
    cookie = session()
  } else {
    const lan = Object.values(os.networkInterfaces()).flat().find(address => address?.family === "IPv4" && !address.internal)
    assert.ok(lan, "a real non-loopback interface is required")
    base = `http://${lan.address}:${new URL(base).port}`
    cookie = session()
  }
  const ui = (target: string, init: Options = {}, as = cookie) =>
    request(base, target, { ...init, headers: { host, origin: publicOrigin, cookie: as, ...init.headers } }, ca)
  // Preview documents are opaque: their own requests carry no cookies and `Origin: null` or none.
  const content = (target: string, init: Options = {}) => request(base, target, { ...init, headers: { host, ...init.headers } }, ca)
  const live = (target: string, upgrade = false, headers: Record<string, string> = {}) =>
    stream(base, target, { host, ...(upgrade ? { origin: "null" } : {}), ...headers }, ca, upgrade)
  const proof = async (id: string, as = cookie) => {
    const meta = await ui(`/api/backends/${id}/api/meta`, { headers: { [AUTHORITY]: RELAY_BOOTSTRAP } }, as)
    assert.equal(meta.status, 200, meta.body)
    return String(meta.headers[AUTHORITY])
  }
  const issue = async (id: string, as = cookie) => ui(`/api/backends/${id}/preview-capabilities`, { method: "POST",
    headers: { [AUTHORITY]: await proof(id, as), "content-type": "application/json" }, body: JSON.stringify({ sessionId: "session", url: "http://app.invalid/start" }) }, as)
  const create = async (id = "A", as = cookie) => {
    const response = await issue(id, as)
    assert.equal(response.status, 200, response.body)
    return JSON.parse(response.body) as { token: string; capability: string; contentUrl: string }
  }
  const revoke = async (id: string, capability: string, as = cookie) => ui(`/api/backends/${id}/preview-capabilities/${capability}`,
    { method: "DELETE", headers: { [AUTHORITY]: await proof(id, as) } }, as)
  return { ...surface, remotes, base, host, cookie, deviceId, session, ui, content, live, proof, issue, create, revoke, logs: () => logs }
}

for (const channel of ["RC", "HTTPS", "LAN"] as const) {
  test(`${channel}: remote previews use host path capabilities with rewriting, streams and opaque isolation`, async t => {
    const f = await fixture(t, channel)
    const a = await f.create("A")
    const b = await f.create("B")
    assert.equal(a.token, b.token)
    for (const cap of [a, b]) {
      assert.notEqual(cap.capability, TOKEN)
      assert.equal(cap.contentUrl, `/previews/${cap.capability}/start`)
    }
    assert.notEqual(a.capability, b.capability)
    for (const [cap, label] of [[a, "A"], [b, "B"]] as const) {
      const publicPrefix = `/previews/${cap.capability}`
      const page = await f.content(cap.contentUrl)
      assert.equal(page.status, 200, page.body)
      assert.ok(page.body.includes(`${label}/start`))
      assert.ok(page.body.includes(`${publicPrefix}/app.js`) && page.body.includes(JSON.stringify(publicPrefix)))
      assert.equal(page.body.includes(TOKEN), false, "the remote token stays private")
      assert.equal(page.headers["content-security-policy"], `sandbox ${PREVIEW_SANDBOX_FLAGS}; frame-ancestors 'self'`)
      assert.equal(page.headers["referrer-policy"], "no-referrer")
      assert.equal(page.headers["set-cookie"], undefined)
      const script = await f.content(`${publicPrefix}/app.js`)
      assert.equal(script.body, `import "${publicPrefix}/dep.js"; window.label = "${label}"`)
      const fetched = await f.content(`${publicPrefix}/data?x=1`, { method: "POST", headers: { origin: "null", "content-type": "text/plain" }, body: "payload" })
      assert.deepEqual(JSON.parse(fetched.body), { label, page: "/data?x=1", method: "POST" })
      assert.equal(fetched.headers["access-control-allow-origin"], "null")
      const preflight = await f.content(`${publicPrefix}/data`, { method: "OPTIONS", headers: { origin: "null", "access-control-request-method": "PUT" } })
      assert.equal(preflight.status, 204)
      const redirect = await f.content(`${publicPrefix}/redirect`)
      assert.equal(redirect.status, 302)
      assert.equal(redirect.headers.location, `${publicPrefix}/next`)
      await alive(await f.live(`${publicPrefix}/events`))
      await alive(await f.live(`${publicPrefix}/ws`, true))
    }
    for (const entry of f.remotes) for (const seen of entry.requests.filter(seen => seen.path.startsWith("/previews/"))) {
      assert.ok(seen.path.startsWith(`${PREFIX}/`))
      for (const name of ["cookie", "authorization", AUTHORITY, "referer", "x-codenomad-server-request", "origin"]) assert.equal(seen.headers[name], undefined, name)
    }
    for (const secret of [a.capability, b.capability, f.cookie.split("=")[1]!]) assert.equal(f.logs().includes(secret), false, "logs keep registered templates only")
  })

  test(`${channel}: hostile preview requests are refused before remote content IO`, async t => {
    const f = await fixture(t, channel)
    const cap = await f.create("A")
    const publicPrefix = `/previews/${cap.capability}`
    const before = f.remotes[0]!.requests.length
    // Opaque documents reach no application API, relay or capability management.
    for (const target of ["/api/meta", "/api/backends/A/api/meta", `/api/backends/A/preview-capabilities/${cap.capability}`]) {
      assert.ok([401, 403, 404].includes((await f.content(target, { headers: { origin: "null" } })).status), target)
    }
    refused(await f.content(`${publicPrefix}/data`, { headers: { origin: "https://foreign.test" } }))
    refused(await f.content(`${publicPrefix}/sw.js`, { headers: { "service-worker": "script" } }))
    refused(await f.content(`${publicPrefix}/../../api/meta`))
    refused(await f.content(`${PREFIX}/start`), "the remote token is no host capability")
    const unknown = `${cap.capability[0] === "0" ? "1" : "0"}${cap.capability.slice(1)}`
    refused(await f.content(`/previews/${unknown}/start`))
    // The capability is bound to the channel and public Host that issued it.
    refused(await request(`http://${f.local}`, cap.contentUrl, { headers: { host: f.local } }))
    if (channel === "LAN") refused(await f.content(cap.contentUrl, { headers: { host: "other.test" } }))
    await assert.rejects(f.live(`${publicPrefix}/ws`, true, { origin: "https://foreign.test" }))
    assert.equal(f.remotes[0]!.requests.length, before)
    // Another principal can neither revoke it nor make it stop serving.
    const other = channel === "RC" ? `__Host-codenomad_device=${f.manager.exchangePairing(f.manager.createPairing().url.split("#")[1]!, "other")!.token}` : f.session()
    assert.equal((await f.revoke("A", cap.capability, other)).status, 404)
    assert.equal((await f.content(cap.contentUrl)).status, 200)
    assert.equal((await f.revoke("A", cap.capability)).status, 204)
    refused(await f.content(cap.contentUrl))
  })
}

test("session logout and password change revoke only that principal's HTTP and WS previews", async t => {
  const f = await fixture(t, "HTTPS", { password: null })
  await f.authManager.setPassword("initial-password")
  const other = f.session()
  const otherCap = await f.create("A", other)
  const otherStream = await f.live(`/previews/${otherCap.capability}/ws`, true)
  const mine = f.session()
  const cap = await f.create("A", mine)
  const events = await f.live(`/previews/${cap.capability}/events`)
  const ws = await f.live(`/previews/${cap.capability}/ws`, true)
  assert.equal((await f.ui("/api/auth/logout", { method: "POST" }, mine)).status, 200)
  await stopped(events, "logout HTTP")
  await stopped(ws, "logout WS")
  refused(await f.content(cap.contentUrl))
  await alive(otherStream)
  await f.authManager.setPassword("replacement-password")
  await stopped(otherStream, "password change WS")
  refused(await f.content(otherCap.contentUrl))
})

test("idle session expiry revokes a preview without another request", async t => {
  const f = await fixture(t, "LAN", { sessionIdleMs: 800 })
  const cap = await f.create("A")
  const ws = await f.live(`/previews/${cap.capability}/ws`, true)
  await stopped(ws, "expired WS")
  refused(await f.content(cap.contentUrl))
})

test("device revocation, the Web previews switch and Remote Control Stop revoke tunnel previews", async t => {
  const f = await fixture(t, "RC")
  const first = await f.create("A")
  const firstWs = await f.live(`/previews/${first.capability}/ws`, true)
  const firstHttp = await f.live(`/previews/${first.capability}/events`)
  assert.equal(f.manager.revokeDevice(f.deviceId!), true)
  await stopped(firstWs, "revoked WS")
  await stopped(firstHttp, "revoked HTTP")

  const second = `__Host-codenomad_device=${f.manager.exchangePairing(f.manager.createPairing().url.split("#")[1]!, "second")!.token}`
  const cap = await f.create("A", second)
  const events = await f.live(`/previews/${cap.capability}/events`)
  f.manager.setPreviewsAllowed(false)
  await stopped(events, "switch-off HTTP")
  refused(await f.content(cap.contentUrl))
  assert.equal((await f.issue("A", second)).status, 404, "creation follows the switch")
  f.manager.setPreviewsAllowed(true)
  const resumed = await f.create("A", second)
  const ws = await f.live(`/previews/${resumed.capability}/ws`, true)
  await f.manager.stop()
  await stopped(ws, "Stop WS")
})

test("Forget and owner deletion revoke only the affected server's previews", async t => {
  const f = await fixture(t, "LAN")
  const a = await f.create("A")
  const b = await f.create("B")
  const ws = await f.live(`/previews/${a.capability}/ws`, true)
  const other = await f.live(`/previews/${b.capability}/ws`, true)
  assert.equal((await f.ui("/api/remote-servers/A/forget", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 200)
  await stopped(ws, "Forget WS")
  refused(await f.content(a.contentUrl))
  await alive(other)
  assert.equal((await f.revoke("B", b.capability)).status, 204)
  await stopped(other, "owner close WS")
})

test("remote-client previews stay behind multiBackend", async t => {
  const f = await fixture(t, "LAN", { multiBackend: false })
  assert.equal((await f.ui("/api/backends/A/preview-capabilities", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404)
  assert.equal(f.remotes[0]!.requests.length, 0)
})
