import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import dns from "node:dns"
import fs from "node:fs"
import http from "node:http"
import type { Socket } from "node:net"
import os from "node:os"
import path from "node:path"
import test, { type TestContext } from "node:test"
import pino from "pino"
import { AuthManager } from "../auth/manager"
import { RELAY_AUTHORITY_HEADER as AUTHORITY, RELAY_BOOTSTRAP } from "../codenomad-servers/relay-authority"
import { startFakeCodeNomad } from "../codenomad-servers/test-support/fake-codenomad"
import { EventBus } from "../events/bus"
import { PreviewManager } from "../previews/manager"
import { createHttpServer } from "../server/http-server"
import { readNetworkPolicy } from "../server/network-policy"
import { SideCarManager } from "../sidecars/manager"
import { RemoteDeviceRegistry } from "./devices"
import { RemoteIngress } from "./ingress"
import { RemoteControlManager } from "./manager"
import { FAKE_TUNNEL_HOST } from "./test-support/surface"

const PUBLIC = "https://code.example.test"
const REMOTE = `https://${FAKE_TUNNEL_HOST}`
const TOKEN = "11111111-1111-4111-8111-111111111111"
const logger = pino({ level: "silent" })
const PREFIX = "/api/backends/saved"

function send(source: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const url = new URL(source)
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    // Connect locally even for the isolated preview's per-capability hostname.
    const request = http.request({ hostname: "127.0.0.1", port: url.port, path: `${url.pathname}${url.search}`,
      method: options.method, agent: false, headers: { host: url.host, ...options.headers } }, response => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", chunk => { body += chunk })
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body }))
      response.on("error", reject)
    })
    request.setTimeout(5000, () => request.destroy(new Error("Request timed out")))
    request.on("error", reject)
    request.end(options.body)
  })
}

async function fixture(t: TestContext, disabled: boolean, locked: boolean, skipAuth = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "multi-backend-network-policy-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const uiStaticDir = path.join(directory, "ui")
  fs.mkdirSync(uiStaticDir)
  fs.writeFileSync(path.join(uiStaticDir, "index.html"), "<title>Test UI</title>")
  const remote = await startFakeCodeNomad({ anonymous: true })
  t.after(() => remote.close())
  remote.state.overrides.set("/api/meta", { status: 200, body: { serverId: "remote-A", apiContract: 1 } })
  remote.state.overrides.set("/api/memory/settings", { status: 200, body: { enabled: true } })
  remote.state.overrides.set("/api/previews", { status: 200, body: {
    token: TOKEN, sessionId: "session", targetUrl: "http://app.invalid/start",
    proxyUrl: `/previews/${TOKEN}/start`, createdAt: new Date().toISOString(),
  } })
  remote.state.handlers.set(`/previews/${TOKEN}/start`, (_request, reply) => reply.end("isolated remote content"))
  remote.state.handlers.set("/ordinary", (_request, reply) => reply.end("ordinary local preview"))
  remote.state.handlers.set("/sidecar", (_request, reply) => reply.end("direct HTTPS SideCar"))
  remote.state.handlers.set("/assets/probe.json", (_request, reply) => reply.end("ordinary preview asset"))
  remote.state.handlers.set(`/previews/${TOKEN}/assets/probe.json`, (_request, reply) => reply.end("isolated remote asset"))

  const policy = readNetworkPolicy({
    ...(disabled ? { CODENOMAD_REMOTE_CONTROL: "disabled" } : {}),
    ...(locked ? { CODENOMAD_LOCKED_HOST: "127.0.0.1" } : {}),
  })
  const config = path.join(directory, "config.yaml")
  const settings = {
    multiBackendEnabled: () => false,
    getOwner: () => ({ remoteServers: [{ id: "saved", baseUrl: remote.origin }] }),
    configYamlPathForAuthority: () => config,
    serverFlag: (key: string) => key === "sidecarsOverDirectHttps",
  }
  const stub = new Proxy({}, { get: () => () => undefined }) as never
  const authManager = new AuthManager({
    configPath: config, username: "codenomad", password: "local-password", generateToken: false,
    dangerouslySkipAuth: skipAuth,
  }, logger)
  const registry = new RemoteDeviceRegistry(path.join(directory, "devices.json"))
  // A persisted launch choice and device must not override administrator disable.
  registry.setStartsOnLaunch(true)
  const previewManager = new PreviewManager()
  let app: ReturnType<typeof createHttpServer>["instance"]
  let previewUpgrade: ReturnType<typeof createHttpServer>["previewUpgrade"]
  let target = ""
  let opens = 0
  const manager = new RemoteControlManager({
    registry, logger, disabledByAdministrator: policy.remoteControlDisabled,
    directHttpsOrigins: () => [PUBLIC],
    router: () => (request, reply) => app.routing(request, reply),
    previewUpgrade: () => previewUpgrade,
    hasPreview: token => previewManager.get(token) !== undefined,
    openTunnel: async options => {
      opens++
      target = options.target
      let close!: () => void
      const closed = new Promise<undefined>(resolve => { close = () => resolve(undefined) })
      return { url: REMOTE, hostname: FAKE_TUNNEL_HOST, status: () => ({ state: "connected", connections: 0 }),
        closed, close: async () => close() }
    },
  })
  const meta = {
    localUrl: "http://127.0.0.1:0", eventsUrl: "/api/events", host: policy.lockedHost ?? "0.0.0.0",
    listeningMode: "all", listeningLocked: locked, localPort: 0, hostLabel: "test", workspaceRoot: directory, addresses: [],
  }
  const sidecar = { id: "fixture", kind: "port", name: "fixture", port: Number(new URL(remote.origin).port),
    insecure: true, prefixMode: "strip", status: "running" }
  let sidecarTarget = `${remote.origin}/sidecar`
  const server = createHttpServer({
    bindHost: policy.lockedHost ?? "0.0.0.0", bindPort: 0, defaultPort: 0, protocol: "http",
    allowedOrigins: [PUBLIC], serverMeta: meta as never,
    workspaceManager: stub, settings: settings as never, fileSystemBrowser: stub, eventBus: new EventBus(),
    instanceStore: stub, speechService: stub, clientConnectionManager: stub, remoteProxySessionManager: stub,
    nativeParent: stub, authManager, previewManager, remoteControlManager: manager,
    sidecarManager: {
      get: async () => sidecar, buildProxyBasePath: () => "/sidecars/fixture",
      buildTargetOrigin: () => SideCarManager.prototype.buildTargetOrigin(sidecar),
      buildTargetPath: () => new URL(sidecarTarget).pathname,
    } as never,
    logger, automationBridgeToken: "test-bridge", uiStaticDir,
  })
  app = server.instance
  app.addHook("onRequest", (request, _reply, done) => {
    const socket = request.raw.socket as unknown as { destroy?: () => void; emit(event: string): void }
    socket.destroy ??= () => socket.emit("close")
    done()
  })
  previewUpgrade = server.previewUpgrade
  const started = await server.start()
  // Match production's publication of the actual bound origin.
  const origin = `http://127.0.0.1:${started.port}`
  meta.localUrl = origin
  const cookie = `${authManager.getCookieName()}=${authManager.createSession("codenomad").id}`
  t.after(async () => { await manager.shutdown(); await server.stop() })
  let device = ""
  if (!disabled) {
    const { pairing } = await manager.start()
    const response = await send(`http://${target}/api/remote-control/pair`, {
      method: "POST", headers: { host: FAKE_TUNNEL_HOST, origin: REMOTE, "content-type": "application/json" },
      body: JSON.stringify({ code: new URL(pairing.url).hash.slice(1) }),
    })
    assert.equal(response.status, 200, response.body)
    device = String(response.headers["set-cookie"]).split(";")[0]!
  } else {
    // Exercise physical ingress marking without starting a policy-forbidden tunnel.
    const ingress = new RemoteIngress((request, reply) => app.routing(request, reply))
    target = await ingress.start()
    t.after(() => ingress.stop())
  }
  const call = (pathname: string, options: Parameters<typeof send>[1] = {}) => send(`${origin}${pathname}`, {
    ...options, headers: { origin, cookie, ...options.headers },
  })
  const admitted = await call(`${PREFIX}/api/meta`, { headers: { [AUTHORITY]: RELAY_BOOTSTRAP } })
  assert.equal(admitted.status, 200, admitted.body)
  const proof = String(admitted.headers[AUTHORITY])
  assert.match(proof, /^[A-Za-z0-9_-]{43}$/)
  return { app, remote, manager, registry, previewManager, origin, cookie, proof, target, device, call, opens: () => opens,
    retargetSidecar: (url: string) => { sidecarTarget = url; sidecar.port = Number(new URL(url).port) } }
}

test("an RC-created ordinary preview cannot rebound into backend browsing, memory or preview management", async t => {
  const f = await fixture(t, false, true, true)
  const created = await send(`http://${f.target}/api/previews`, {
    method: "POST", headers: { host: FAKE_TUNNEL_HOST, origin: REMOTE, cookie: f.device, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "remote-device", url: f.origin }),
  })
  assert.equal(created.status, 200, created.body)
  const token = JSON.parse(created.body).token
  const before = f.remote.state.requests.length
  for (const [method, pathname] of [
    ["GET", `${PREFIX}/api/filesystem`],
    ["GET", `${PREFIX}/api/memory/settings`],
    ["POST", `${PREFIX}/preview-capabilities`],
  ] as const) {
    const response = await send(`http://${f.target}/previews/${token}${pathname}`, {
      method, headers: { host: FAKE_TUNNEL_HOST, [AUTHORITY]: f.proof, "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify({ sessionId: "session", url: "http://app.invalid/start" }) : undefined,
    })
    assert.equal(response.status, 404, `${pathname}: ${response.body}`)
    assert.equal(f.remote.state.requests.length, before, "a preview proxy must not manufacture local backend authority")
  }
})

async function capability(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await f.call(`${PREFIX}/preview-capabilities`, {
    method: "POST", headers: { [AUTHORITY]: f.proof, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "session", url: "http://app.invalid/start" }),
  })
  assert.equal(response.status, 200, response.body)
  return JSON.parse(response.body) as { capability: string; contentUrl: string }
}

function resolveCapability(t: TestContext, contentUrl: string) {
  const hostname = new URL(contentUrl).hostname
  const lookup = dns.lookup
  // Chromium resolves *.localhost internally; give the real Node proxy the same deterministic DNS.
  return t.mock.method(dns, "lookup", ((host: string, ...args: unknown[]) => {
    if (host !== hostname) return Reflect.apply(lookup, dns, [host, ...args])
    const callback = args.at(-1) as (...values: unknown[]) => void
    const options = args[0] as { all?: boolean } | undefined
    if (options?.all) callback(null, [{ address: "127.0.0.1", family: 4 }])
    else callback(null, "127.0.0.1", 4)
  }) as typeof dns.lookup)
}

test("an RC-created ordinary preview cannot rebound into an isolated remote capability origin", async t => {
  const f = await fixture(t, false, true)
  const cap = await capability(f)
  assert.equal((await send(cap.contentUrl)).body, "isolated remote content")
  resolveCapability(t, cap.contentUrl)
  const created = await send(`http://${f.target}/api/previews`, {
    method: "POST", headers: { host: FAKE_TUNNEL_HOST, origin: REMOTE, cookie: f.device, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "remote-device", url: cap.contentUrl }),
  })
  assert.equal(created.status, 200, created.body)
  const before = f.remote.state.requests.length
  const response = await send(`http://${f.target}/previews/${JSON.parse(created.body).token}${new URL(cap.contentUrl).pathname}`, {
    headers: { host: FAKE_TUNNEL_HOST },
  })
  assert.equal(response.status, 404, response.body)
  assert.equal(f.remote.state.requests.length, before, "remote preview content must retain its exclusive origin through ordinary proxies")
})

test("direct HTTPS SideCar opt-in cannot proxy an isolated remote capability origin", async t => {
  const f = await fixture(t, false, true)
  const cap = await capability(f)
  assert.equal((await send(cap.contentUrl)).body, "isolated remote content")
  f.retargetSidecar(cap.contentUrl)
  const before = f.remote.state.requests.length
  const response = await f.app.inject({ url: "/sidecars/fixture/", remoteAddress: "192.0.2.20",
    headers: { host: "code.example.test", origin: PUBLIC, cookie: f.cookie } })
  assert.equal(response.statusCode, 404, response.body)
  assert.equal(f.remote.state.requests.length, before)
})

test("direct HTTPS SideCar opt-in cannot rebound into backend browsing or memory", async t => {
  const f = await fixture(t, false, true, true)
  const before = f.remote.state.requests.length
  for (const pathname of [`${PREFIX}/api/filesystem`, `${PREFIX}/api/memory/settings`]) {
    f.retargetSidecar(`${f.origin}${pathname}`)
    const response = await f.app.inject({ url: `/sidecars/fixture${pathname}`, remoteAddress: "192.0.2.20",
      headers: { host: "code.example.test", origin: PUBLIC, cookie: f.cookie, [AUTHORITY]: f.proof } })
    assert.equal(response.statusCode, 404, `${pathname}: ${response.body}`)
    assert.equal(f.remote.state.requests.length, before)
  }
})

for (const locked of [false, true]) test(`paired direct HTTPS devices retain only SideCar opt-in (locked=${locked})`, async t => {
  const f = await fixture(t, false, locked)
  const pairing = f.manager.createDirectPairing(PUBLIC)
  const paired = await f.app.inject({ method: "POST", url: "/api/remote-control/pair", remoteAddress: "192.0.2.20",
    headers: { host: "code.example.test", origin: PUBLIC }, payload: { code: new URL(pairing.url).hash.slice(1) } })
  assert.equal(paired.statusCode, 200, paired.body)
  const headers = { host: "code.example.test", origin: PUBLIC, cookie: String(paired.headers["set-cookie"]).split(";")[0]!,
    [AUTHORITY]: f.proof }
  const sidecar = await f.app.inject({ url: "/sidecars/fixture/", remoteAddress: "192.0.2.20", headers })
  assert.equal(sidecar.statusCode, 200, sidecar.body)
  assert.equal(sidecar.body, "direct HTTPS SideCar")
  const before = f.remote.state.requests.length
  for (const pathname of [`${PREFIX}/api/filesystem`, `${PREFIX}/api/memory/settings`, "/api/memory/settings"]) {
    assert.equal((await f.app.inject({ url: pathname, remoteAddress: "192.0.2.20", headers })).statusCode, 404, pathname)
  }
  assert.equal((await f.app.inject({ method: "POST", url: `${PREFIX}/preview-capabilities`,
    remoteAddress: "192.0.2.20", headers, payload: { sessionId: "session", url: "http://app.invalid/start" } })).statusCode, 404)
  assert.equal((await send(`http://${f.target}/sidecars/fixture/`, { headers: {
    host: FAKE_TUNNEL_HOST, origin: REMOTE, cookie: f.device,
  } })).status, 404, "the direct HTTPS opt-in never admits an ingress device")
  assert.equal(f.remote.state.requests.length, before)
})

function upgrade(source: string, headers: Record<string, string> = {}) {
  const url = new URL(source)
  return new Promise<number>((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port: url.port, path: `${url.pathname}${url.search}`, agent: false,
      headers: { host: url.host, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"), ...headers } })
    request.setTimeout(5000, () => request.destroy(new Error("Upgrade timed out")))
    request.on("response", response => { response.resume(); resolve(response.statusCode!) })
    request.on("upgrade", (response, socket) => { socket.destroy(); resolve(response.statusCode!) })
    request.on("error", reject)
    request.end()
  })
}

async function websocketApp(t: TestContext) {
  const upgrades: string[] = []
  const sockets = new Set<Socket>()
  const server = http.createServer((_request, reply) => reply.end("ordinary application"))
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)) })
  server.on("upgrade", (request, socket: Socket) => {
    upgrades.push(request.url!)
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.once("end", () => socket.end())
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, upgrades }
}

test("RC preview WebSockets admit ordinary apps but refuse capability and own-control rebounds before IO", async t => {
  const f = await fixture(t, false, true, true)
  const app = await websocketApp(t)
  const ordinary = f.previewManager.create("ordinary", app.origin)
  const headers = { host: FAKE_TUNNEL_HOST }
  assert.equal(await upgrade(`http://${f.target}/previews/${ordinary.token}/ws`, headers), 101)
  assert.deepEqual(app.upgrades, ["/ws"])

  const cap = await capability(f)
  const isolated = f.previewManager.create("isolated", cap.contentUrl)
  const lookup = resolveCapability(t, cap.contentUrl)
  const before = f.remote.state.requests.length
  assert.equal(await upgrade(`http://${f.target}/previews/${isolated.token}/ws`, headers), 404)
  assert.equal(lookup.mock.callCount(), 0, "refuse capability targets before DNS or a remote WebSocket attempt")
  assert.equal(f.remote.state.requests.length, before)

  const self = f.previewManager.create("self", f.origin)
  assert.equal(await upgrade(`http://${f.target}/previews/${self.token}${PREFIX}/api/events`, {
    ...headers, [AUTHORITY]: f.proof,
  }), 404)
  assert.equal(f.remote.state.requests.length, before)
})

test("SideCar WebSockets admit ordinary apps but refuse own-backend control targets", async t => {
  const f = await fixture(t, false, true, true)
  const app = await websocketApp(t)
  const headers = { host: "code.example.test", origin: PUBLIC, cookie: f.cookie, [AUTHORITY]: f.proof }
  f.retargetSidecar(`${app.origin}/ws`)
  assert.equal(await upgrade(`${f.origin}/sidecars/fixture/ws`, headers), 101)
  assert.deepEqual(app.upgrades, ["/ws"])
  f.retargetSidecar(`${f.origin}${PREFIX}/api/events`)
  const before = f.remote.state.requests.length
  assert.equal(await upgrade(`${f.origin}/sidecars/fixture${PREFIX}/api/events`, headers), 404)
  assert.equal(f.remote.state.requests.length, before)
})

test("Referer asset fallback preserves ordinary RC previews and refuses isolated capability origins", async t => {
  const f = await fixture(t, false, true)
  const ordinary = f.previewManager.create("ordinary", f.remote.origin)
  const headers = { host: FAKE_TUNNEL_HOST, cookie: f.device,
    referer: `${REMOTE}/previews/${ordinary.token}/page` }
  const asset = await send(`http://${f.target}/assets/probe.json`, { headers })
  assert.equal(asset.status, 200, asset.body)
  assert.equal(asset.body, "ordinary preview asset")
  const cap = await capability(f)
  const isolated = f.previewManager.create("isolated", cap.contentUrl)
  const lookup = resolveCapability(t, cap.contentUrl)
  const before = f.remote.state.requests.length
  const refused = await send(`http://${f.target}/assets/probe.json`, { headers: {
    ...headers, referer: `${REMOTE}/previews/${isolated.token}/page`,
  } })
  assert.equal(refused.status, 404, refused.body)
  assert.equal(lookup.mock.callCount(), 0, "fallback refuses capability targets before DNS")
  assert.equal(f.remote.state.requests.length, before)
})

test("Referer fallback cannot reinterpret an encoded own-backend control path", async t => {
  const f = await fixture(t, false, true, true)
  const preview = f.previewManager.create("self", f.origin)
  const before = f.remote.state.requests.length
  // The fallback uses the raw URL; the control boundary judges the routed path.
  assert.equal((await f.call("/%61pi/meta")).status, 200)
  const refused = await f.call("/%61pi/meta", { headers: {
    referer: `${f.origin}/previews/${preview.token}/page`, [AUTHORITY]: f.proof,
  } })
  assert.equal(refused.status, 404, refused.body)
  assert.equal(f.remote.state.requests.length, before)
})

// #1438: transport provenance; #1493: admin disable/listener lock; #1497: SideCar-only HTTPS opt-in.
for (const disabled of [false, true]) {
  for (const locked of [false, true]) {
    test(`multi-backend authority stays local (admin disabled=${disabled}, listener locked=${locked})`, async t => {
      const f = await fixture(t, disabled, locked)
      assert.equal(f.manager.status().previews, true, "ordinary local RC previews retain the host's enabled contract")
      assert.equal((await f.call("/api/meta")).body.includes('"listeningLocked":true'), locked)
      if (disabled) {
        await f.manager.resume()
        await assert.rejects(f.manager.start(), /disabled by the administrator/)
        for (const pathname of ["/api/remote-control/start", "/api/remote-control/pairings"]) {
          const response = await f.call(pathname, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
          assert.equal(response.status, 403, response.body)
          assert.equal(JSON.parse(response.body).code, "remote_control_disabled")
        }
        assert.equal(f.opens(), 0)
        assert.equal(f.registry.startsOnLaunch(), true, "administrator disable preserves the host's saved launch choice")
      } else {
        assert.equal(f.opens(), 1, "a listening lock alone does not disable RC")
        const local = f.previewManager.create("ordinary", `${f.remote.origin}/ordinary`)
        const response = await send(`http://${f.target}/previews/${local.token}/ordinary`, { headers: { host: FAKE_TUNNEL_HOST } })
        assert.equal(response.status, 200, response.body)
        assert.equal(response.body, "ordinary local preview")
      }

      const created = await f.call(`${PREFIX}/preview-capabilities`, {
        method: "POST", headers: { [AUTHORITY]: f.proof, "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "session", url: "http://app.invalid/start" }),
      })
      assert.equal(created.status, 200, created.body)
      const cap = JSON.parse(created.body) as { capability: string; contentUrl: string }
      const content = new URL(cap.contentUrl)
      assert.notEqual(content.port, new URL(f.origin).port, "the lock governs the ordinary listener, not the isolated content listener")
      assert.equal((await send(cap.contentUrl)).body, "isolated remote content")
      assert.equal((await f.call(`${PREFIX}/api/memory/settings`, { headers: { [AUTHORITY]: f.proof } })).status, 200)

      const before = f.remote.state.requests.length
      const boundaryPaths = [
        ["GET", `${PREFIX}/api/meta`], ["GET", "/api/backends/saved/api/memory/settings"],
        ["POST", `${PREFIX}/api/memory`], ["GET", "/api/memory/settings"], ["POST", "/api/memory"],
        ["POST", `${PREFIX}/preview-capabilities`], ["DELETE", `${PREFIX}/preview-capabilities/${cap.capability}`],
        ["GET", `${PREFIX}/previews/${TOKEN}/start`],
        ["POST", `${PREFIX}/api/previews`], ["GET", `${PREFIX}/api/backends/other/api/meta`],
      ] as const
      for (const [method, pathname] of boundaryPaths) {
        const response = await send(`http://${f.target}${pathname}`, {
          method, headers: { host: FAKE_TUNNEL_HOST, origin: REMOTE, cookie: f.device,
            [AUTHORITY]: f.proof, "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined,
        })
        assert.equal(response.status, disabled ? 421 : 404, `${method} ${pathname}: ${response.body}`)
      }
      // Knowing a valid content URL or relay proof cannot rebind RC to its exclusive origin.
      for (const origin of [REMOTE, PUBLIC, f.origin, "null"]) {
        assert.equal((await send(cap.contentUrl, { headers: { origin, cookie: f.device, [AUTHORITY]: f.proof } })).status, 404, origin)
      }
      assert.equal((await send(`http://${f.target}${content.pathname}`, {
        headers: { host: content.host, cookie: f.device, [AUTHORITY]: f.proof },
      })).status, 421)
      assert.equal(f.remote.state.requests.length, before, "refusals perform no upstream IO")

      const directHeaders = { host: "code.example.test", origin: PUBLIC, cookie: f.cookie, [AUTHORITY]: f.proof }
      const directMeta = await f.app.inject({ url: "/api/meta", remoteAddress: "192.0.2.20", headers: directHeaders })
      assert.equal(directMeta.statusCode, 200)
      assert.equal(directMeta.json().sidecarsAllowed, true)
      assert.equal(directMeta.json().localRequest, false)
      const sidecar = await f.app.inject({ url: "/sidecars/fixture/", remoteAddress: "192.0.2.20", headers: directHeaders })
      assert.equal(sidecar.statusCode, 200, sidecar.body)
      assert.equal(sidecar.body, "direct HTTPS SideCar")
      const afterSidecar = f.remote.state.requests.length
      for (const [method, pathname] of boundaryPaths) {
        const response = await f.app.inject({ method, url: pathname, remoteAddress: "192.0.2.20",
          headers: directHeaders, ...(method === "POST" ? { payload: {} } : {}) })
        assert.equal(response.statusCode, ["/api/memory", "/api/memory/settings"].includes(pathname) ? 403 : 404,
          `${method} ${pathname}: ${response.body}`)
      }
      assert.equal(f.remote.state.requests.length, afterSidecar, "SideCar opt-in grants no relay, memory or preview-management authority")
      assert.equal((await send(cap.contentUrl)).status, 200, "refused remote revocation preserves the local capability")
      assert.equal((await f.call(`${PREFIX}/preview-capabilities/${cap.capability}`, {
        method: "DELETE", headers: { [AUTHORITY]: f.proof },
      })).status, 204)
      assert.equal((await send(cap.contentUrl)).status, 404)
      if (disabled) assert.equal(f.opens(), 0, "local multi-backend preview use never reopens RC")
    })
  }
}
