import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { afterEach, it } from "node:test"
import pino from "pino"
import type { FastifyInstance } from "fastify"
import type { SideCar } from "../../api-types"
import { AuthManager } from "../../auth/manager"
import { PreviewManager } from "../../previews/manager"
import { createHttpServer } from "../http-server"

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

const apps: FastifyInstance[] = []
const upstreams: http.Server[] = []
const upstreamSocketCleanups: Array<() => void> = []
const sockets: net.Socket[] = []
type UpstreamOptions = { cookies?: string[]; fragmented?: boolean; denied?: boolean; html?: string }

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy()
  // Proxied upgrades leave detached sockets that server.close() would wait on
  // forever; destroy every open connection deterministically before closing.
  for (const destroy of upstreamSocketCleanups.splice(0)) destroy()
  await Promise.all(apps.splice(0).map(async (app) => {
    app.server.closeAllConnections?.()
    await app.close()
  }))
  await Promise.all(upstreams.splice(0).map((upstream) => new Promise<void>((resolve, reject) => {
    upstream.closeAllConnections?.()
    upstream.close(() => resolve())
    upstream.on("error", reject)
  })))
})

/** A minimal SideCar upstream that completes WebSocket upgrades itself. */
async function startSideCarUpstream(options: UpstreamOptions = {}) {
  const upgrades: string[] = []
  const requests: http.IncomingHttpHeaders[] = []
  const received: Array<{ method: string; url: string; body: string }> = []
  const connections = new Set<net.Socket>()
  let connectionCount = 0
  const upstream = http.createServer((request, response) => {
    requests.push(request.headers)
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (chunk) => { body += chunk })
    request.on("end", () => {
      received.push({ method: request.method ?? "", url: request.url ?? "", body })
      if (options.cookies) response.setHeader("Set-Cookie", options.cookies)
      if (options.html !== undefined) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        response.end(options.html)
        return
      }
      response.writeHead(200, { "content-type": "application/json" })
      response.end("{\"ok\":true}")
    })
  })
  upstream.on("connection", (socket) => {
    connectionCount++
    connections.add(socket)
    socket.on("close", () => connections.delete(socket))
  })
  upstream.on("upgrade", (request, socket) => {
    upgrades.push(request.url ?? "")
    requests.push(request.headers)
    const key = String(request.headers["sec-websocket-key"] ?? "")
    const accept = crypto.createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64")
    const cookies = (options.cookies ?? []).map(value => `Set-Cookie: ${value}\r\n`).join("")
    if (options.denied) {
      socket.end(`HTTP/1.1 403 Forbidden\r\n${cookies}Connection: close\r\nContent-Length: 0\r\n\r\n`)
      return
    }
    const header = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${cookies}\r\n`
    if (options.fragmented) {
      const split = header.indexOf("Set-Cookie") + 4
      socket.write(header.slice(0, split))
      setImmediate(() => { if (!socket.destroyed) socket.write(header.slice(split)) })
    } else socket.write(header)
    // ponytail: fixture exchanges one short text frame; use a WS library for larger/fragmented messages.
    let bytes = Buffer.alloc(0)
    socket.on("data", chunk => {
      bytes = Buffer.concat([bytes, chunk])
      if (bytes.length < 6) return
      const length = bytes[1] & 127
      if (bytes.length < 6 + length) return
      const mask = bytes.subarray(2, 6)
      const payload = Buffer.from(bytes.subarray(6, 6 + length).map((value, i) => value ^ mask[i % 4]))
      socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]))
      bytes = bytes.subarray(6 + length)
    })
  })
  upstreams.push(upstream)
  upstreamSocketCleanups.push(() => { for (const socket of connections) socket.destroy() })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  return { port: (upstream.address() as net.AddressInfo).port, upgrades, requests, received, connectionCount: () => connectionCount }
}

/** Raw WebSocket handshake, like a browser's; resolves once the status line and headers arrived. */
function webSocketUpgrade(port: number, pathname: string, headers: Record<string, string>, exchange = false): Promise<{ status: number; head: string; echo?: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      const key = crypto.randomBytes(16).toString("base64")
      const lines = [
        `GET ${pathname} HTTP/1.1`,
        `Host: ${headers.host ?? "127.0.0.1"}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        ...Object.entries(headers).filter(([name]) => name !== "host").map(([name, value]) => `${name}: ${value}`),
        "", "",
      ]
      socket.write(lines.join("\r\n"))
    })
    sockets.push(socket)
    socket.setTimeout(4000, () => { reject(new Error(`WebSocket handshake timed out: ${pathname}`)) })
    let bytes = Buffer.alloc(0)
    let head = ""
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk])
      if (!head) {
        const end = bytes.indexOf("\r\n\r\n")
        if (end < 0) return
        head = bytes.toString("latin1", 0, end)
        bytes = bytes.subarray(end + 4)
        if (exchange && Number(head.split(" ")[1]) === 101) {
          const payload = Buffer.from("sidecar-origin-check")
          const mask = crypto.randomBytes(4)
          socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask,
            Buffer.from(payload.map((value, i) => value ^ mask[i % 4]))]))
        }
      }
      const status = Number(head.split(" ")[1])
      if (exchange && status === 101 && (bytes.length < 2 || bytes.length < 2 + (bytes[1] & 127))) return
      // Abort like a browser tab close: a FIN would leave the proxied
      // connection half-open and the servers would never finish closing.
      socket.resetAndDestroy()
      resolve({ status, head, ...(exchange && status === 101 ? { echo: bytes.subarray(2, 2 + (bytes[1] & 127)).toString() } : {}) })
    })
    socket.on("error", reject)
  })
}

async function startServer(options: UpstreamOptions & { cookieName?: string; prefixMode?: SideCar["prefixMode"]; skipAuth?: boolean; allowedOrigins?: string[]; devServerUrl?: string } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-sidecar-proxy-"))
  const logger = pino({ level: "silent" })
  const authManager = new AuthManager({
    configPath: path.join(directory, "config.yaml"),
    username: "codenomad",
    password: "test-password",
    generateToken: false,
    cookieName: options.cookieName,
    dangerouslySkipAuth: options.skipAuth,
  }, logger)
  const { port, upgrades, requests, received, connectionCount } = await startSideCarUpstream(options)
  const sidecar: SideCar = {
    id: "fixture", kind: "port", name: "ttyd", port, insecure: true, prefixMode: options.prefixMode ?? "strip",
    status: "running", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }
  const publicBase = `/sidecars/${sidecar.id}`
  const sidecarManager = {
    async get(id: string) {
      return id === sidecar.id ? sidecar : undefined
    },
    buildProxyBasePath: (id: string) => `/sidecars/${encodeURIComponent(id)}`,
    buildTargetOrigin: (target: Pick<SideCar, "port" | "insecure">) => `http${target.insecure ? "" : "s"}://127.0.0.1:${target.port}`,
    buildTargetPath: (_id: string, incomingPath: string, search = "") => {
      if (sidecar.prefixMode === "preserve") return `${incomingPath}${search}`
      let stripped = incomingPath.startsWith(publicBase) ? incomingPath.slice(publicBase.length) : incomingPath
      if (!stripped.startsWith("/")) stripped = `/${stripped}`
      return `${stripped || "/"}${search}`
    },
  }
  const stub = new Proxy({}, { get: () => () => undefined }) as never
  const previewManager = new PreviewManager()
  const preview = previewManager.create("fixture", `http://127.0.0.1:${port}`)
  const { instance: app } = createHttpServer({
    bindHost: "127.0.0.1", bindPort: 0, defaultPort: 0, protocol: "http",
    workspaceManager: stub, settings: stub, fileSystemBrowser: stub, eventBus: stub,
    serverMeta: { localUrl: "http://localhost:0", eventsUrl: "/api/events", listeningMode: "local", localPort: 0, hostLabel: "test", workspaceRoot: directory, addresses: [] } as never,
    instanceStore: stub, speechService: stub, sidecarManager: sidecarManager as never, previewManager,
    clientConnectionManager: stub, remoteProxySessionManager: stub, yoloManager: stub,
    authManager, logger, nativeParent: stub, automationBridgeToken: "fixture-token",
    remoteControlManager: stub, uiStaticDir: directory,
    allowedOrigins: options.allowedOrigins, uiDevServerUrl: options.devServerUrl,
  })
  apps.push(app)
  await app.listen({ host: "127.0.0.1", port: 0 })
  const address = app.server.address()
  assert.ok(address && typeof address === "object")
  const session = authManager.createSession("codenomad")
  return {
    app,
    connectionCount,
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    cookie: `${authManager.getCookieName()}=${session.id}`,
    upgrades,
    requests,
    received,
    preview,
    cleanupDirectory: directory,
  }
}

it("SideCar WebSocket upgrades require the SameSite session cookie a same-origin frame sends", async () => {
  const server = await startServer()
  try {
    const anonymous = await webSocketUpgrade(server.port, "/sidecars/fixture/ws", {})
    assert.equal(anonymous.status, 401)

    // An opaque-origin frame is refused even with the session cookie, as over HTTP.
    const opaque = await webSocketUpgrade(server.port, "/sidecars/fixture/ws", { cookie: server.cookie, origin: "null" })
    assert.equal(opaque.status, 403)

    const authenticated = await webSocketUpgrade(server.port, "/sidecars/fixture/ws", { cookie: server.cookie })
    assert.equal(authenticated.status, 101)
    assert.match(authenticated.head, /^HTTP\/1\.1 101 Switching Protocols/i)
    assert.match(authenticated.head, /^upgrade: websocket$/im)
    // strip prefixMode drops the /sidecars/:id prefix before proxying upstream.
    assert.deepEqual(server.upgrades, ["/ws"])
  } finally {
    await fs.rm(server.cleanupDirectory, { recursive: true, force: true })
  }
})

it("non-local SideCar upgrades are refused even with a valid host session and spoofed forwarding headers", async () => {
  const server = await startServer()
  try {
    // A deterministic transport peer, as app.inject's remoteAddress for HTTP.
    server.app.server.prependListener("connection", socket => {
      Object.defineProperty(socket, "remoteAddress", { value: "192.0.2.20" })
    })
    for (const origin of [server.origin, undefined]) {
      const response = await webSocketUpgrade(server.port, "/sidecars/fixture/socket", {
        Cookie: server.cookie, ...(origin ? { Origin: origin } : {}), "X-Forwarded-For": "127.0.0.1",
      })
      assert.equal(response.status, 404)
      assert.equal(server.connectionCount(), 0)
    }
    assert.deepEqual(server.upgrades, [])
  } finally { await fs.rm(server.cleanupDirectory, { recursive: true, force: true }) }
})

for (const skipAuth of [false, true]) {
  it(`SideCar WS enforces the shared source policy before any upstream connection (skip auth: ${skipAuth})`, async () => {
    const allowed = "https://ui.example.test:8443"
    const development = "http://localhost:3000"
    const server = await startServer({ skipAuth, allowedOrigins: [allowed], devServerUrl: development })
    try {
      const credentials: Record<string, string> = skipAuth ? {} : { cookie: server.cookie }
      const foreign = "http://localhost:1"
      const denied: Record<string, string>[] = [
        { origin: foreign }, { origin: "null" }, { origin: "not-an-origin" },
        { origin: `${server.origin}/path` }, { origin: `${allowed}, ${server.origin}` },
        { origin: "" }, { referer: `${foreign}/page` }, { referer: "malformed" },
        { origin: foreign, referer: `${server.origin}/page` },
        { origin: foreign, "x-forwarded-host": `localhost:${server.port}`, "x-forwarded-proto": "http" },
        // A loopback alias is same-origin only: a `localhost` page may belong to a sibling `[::1]` listener.
        { origin: `http://localhost:${server.port}` },
      ]
      for (const headers of denied) {
        for (const auth of skipAuth ? [{}] : [credentials, {}]) {
          const before = server.connectionCount()
          const response = await webSocketUpgrade(server.port, "/sidecars/fixture/ws", { ...auth, ...headers }, true)
          assert.equal(response.status, 403, JSON.stringify(headers))
          assert.equal(server.connectionCount(), before, "refuse before even opening an upstream TCP connection")
        }
      }
      const accepted: Record<string, string>[] = [
        { origin: server.origin }, { origin: `http://localhost:${server.port}`, host: `localhost:${server.port}` }, { origin: allowed }, { origin: development },
        {}, { referer: `${server.origin}/page` }, { referer: `${allowed}/page` },
        { origin: server.origin, referer: `${foreign}/page` },
      ]
      for (const headers of accepted) {
        const before = server.connectionCount()
        const response = await webSocketUpgrade(server.port, "/sidecars/fixture/ws", { ...credentials, ...headers }, true)
        assert.equal(response.status, 101, JSON.stringify(headers))
        assert.equal(response.echo, "sidecar-origin-check")
        assert.equal(server.connectionCount(), before + 1)
      }
      if (!skipAuth) {
        const anonymous: Record<string, string>[] = [{}, { origin: server.origin }, { origin: allowed }]
        for (const headers of anonymous) {
          const before = server.connectionCount()
          assert.equal((await webSocketUpgrade(server.port, "/sidecars/fixture/ws", headers)).status, 401)
          assert.equal(server.connectionCount(), before)
        }
        const logout = await server.app.inject({ method: "POST", url: "/api/auth/logout", headers: credentials })
        assert.equal(logout.statusCode, 200)
        const before = server.connectionCount()
        assert.equal((await webSocketUpgrade(server.port, "/sidecars/fixture/ws", { ...credentials, origin: allowed })).status, 401)
        assert.equal(server.connectionCount(), before)
      }
    } finally { await fs.rm(server.cleanupDirectory, { recursive: true, force: true }) }
  })
}

for (const prefixMode of ["strip", "preserve"] as const) {
  for (const cookieName of ["codenomad_session", "custom_session"]) {
    it(`filters application cookies in HTTP and WS both ways, retaining service cookies (${prefixMode}, ${cookieName})`, async () => {
      const safeCookies = ["service_login=a=b%2Fc; HttpOnly; Path=/", "theme=dark; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/"]
      const unsafe = [cookieName, "codenomad_session_123_456", "__Host-codenomad_device"]
      const server = await startServer({ prefixMode, cookieName, fragmented: true,
        cookies: [...safeCookies, ...unsafe.map(name => `${name}=injected; Path=/; HttpOnly`)] })
      try {
        const cookie = `${server.cookie}; service_login=a=b%2Fc; codenomad_session_123_456=sibling; __Host-codenomad_device=device; theme=dark`
        const response = await server.app.inject({ url: "/sidecars/fixture/token", headers: { cookie } })
        assert.equal(response.statusCode, 200)
        assert.deepEqual(response.headers["set-cookie"], safeCookies)
        const ws = await webSocketUpgrade(server.port, "/sidecars/fixture/ws", { cookie })
        assert.equal(ws.status, 101)
        for (const name of unsafe) assert.equal(ws.head.includes(`${name}=`), false)
        for (const value of safeCookies) assert.ok(ws.head.includes(value))
        assert.deepEqual(server.upgrades, [prefixMode === "strip" ? "/ws" : "/sidecars/fixture/ws"])
        assert.deepEqual(server.requests.map(headers => headers.cookie), ["service_login=a=b%2Fc; theme=dark", "service_login=a=b%2Fc; theme=dark"])
        assert.equal((await server.app.inject({ url: "/sidecars/fixture/token", headers: { cookie: "service_login=a=b%2Fc" } })).statusCode, 401)
      } finally { await fs.rm(server.cleanupDirectory, { recursive: true, force: true }) }
    })
  }
}

it("a rejected WebSocket handshake cannot overwrite the CodeNomad session either", async () => {
  const server = await startServer({ denied: true, cookies: ["codenomad_session=poison; Path=/", "service_login=expired; Path=/"] })
  try {
    const response = await webSocketUpgrade(server.port, "/sidecars/fixture/ws", { cookie: server.cookie })
    assert.equal(response.status, 403)
    assert.equal(response.head.includes("codenomad_session"), false)
    assert.ok(response.head.includes("service_login=expired"))
    assert.equal(server.requests[0].cookie, undefined)
  } finally { await fs.rm(server.cleanupDirectory, { recursive: true, force: true }) }
})

it("preview WebSocket capabilities keep working through the shared transport without forwarding cookies", async () => {
  const server = await startServer({ cookies: ["codenomad_session=poison; Path=/", "preview_cookie=value; Path=/"] })
  try {
    const cases: Record<string, string>[] = [{}, { cookie: `${server.cookie}; service=value`, origin: "null" }]
    for (const headers of cases) {
      const response = await webSocketUpgrade(server.port, `/previews/${server.preview.token}/ws`, headers)
      assert.equal(response.status, 101)
      assert.equal(response.head.toLowerCase().includes("set-cookie"), false)
    }
    assert.deepEqual(server.requests.map(request => request.cookie), [undefined, undefined])
    assert.deepEqual(server.upgrades, ["/ws", "/ws"])
  } finally { await fs.rm(server.cleanupDirectory, { recursive: true, force: true }) }
})

it("preview HTTP requests never forward the app's cookies to the previewed site", async () => {
  const server = await startServer({ cookies: ["codenomad_session=poison; Path=/", "preview_cookie=value; Path=/"] })
  try {
    const cookie = `${server.cookie}; service_login=secret`
    const token = server.preview.token
    // The path proxy, the per-token capability host and the session's root-relative asset fallback.
    for (const request of [
      { url: `/previews/${token}/page`, headers: { cookie } },
      { url: "/page", headers: { cookie, host: `${token}.preview.localhost` } },
      { url: "/assets/app.js", headers: { cookie, referer: `${server.origin}/previews/${token}/page` } },
    ]) {
      const response = await server.app.inject({ method: "GET", ...request })
      assert.equal(response.statusCode, 200, request.url)
      assert.equal(response.headers["set-cookie"], undefined, request.url)
    }
    assert.deepEqual(server.requests.map(request => request.cookie), [undefined, undefined, undefined])
  } finally { await fs.rm(server.cleanupDirectory, { recursive: true, force: true }) }
})

it("path previews stay opaque however they are opened, on every response type", async () => {
  const server = await startServer()
  try {
    const token = server.preview.token
    const sandbox = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads"
    for (const [request, isolated] of [
      [{ url: `/previews/${token}/data.json` }, true],
      [{ url: "/assets/app.js", headers: { cookie: server.cookie, referer: `${server.origin}/previews/${token}/page` } }, true],
      // The per-token host already has an origin of its own.
      [{ url: "/data.json", headers: { host: `${token}.preview.localhost` } }, false],
    ] as const) {
      const response = await server.app.inject({ method: "GET", ...request })
      assert.equal(response.statusCode, 200, request.url)
      assert.equal(response.headers["content-security-policy"], isolated ? sandbox : undefined, request.url)
      assert.equal(response.headers["referrer-policy"], isolated ? "same-origin" : undefined, request.url)
    }
  } finally { await fs.rm(server.cleanupDirectory, { recursive: true, force: true }) }
})

it("opaque-origin frames cannot reach SideCar routes while same-origin frames can", async () => {
  const server = await startServer()
  try {
    // A sandboxed iframe without allow-same-origin sends Origin: null and no cookies.
    const opaque = await server.app.inject({ method: "GET", url: "/sidecars/fixture/token", headers: { origin: "null" } })
    assert.equal(opaque.statusCode, 403)

    // A same-origin frame sends the app's own origin plus the session cookie.
    const sameOrigin = await server.app.inject({
      method: "GET", url: "/sidecars/fixture/token",
      headers: { origin: server.origin, cookie: server.cookie },
    })
    assert.equal(sameOrigin.statusCode, 200)
    assert.equal(sameOrigin.body, "{\"ok\":true}")
  } finally {
    await fs.rm(server.cleanupDirectory, { recursive: true, force: true })
  }
})

it("forwards a bodiless SideCar DELETE declaring JSON and still parses framed JSON bodies", async () => {
  const server = await startServer()
  try {
    const send = (options: { method: "DELETE" | "POST"; headers?: Record<string, string>; payload?: string }) => server.app.inject({
      url: "/sidecars/fixture/item", ...options, headers: { cookie: server.cookie, "content-type": "application/json", ...options.headers },
    })
    const bodiless = await send({ method: "DELETE" })
    assert.equal(bodiless.statusCode, 200, bodiless.body)
    assert.deepEqual(server.received.at(-1), { method: "DELETE", url: "/item", body: "" })
    // A framed body goes through Fastify's own JSON parser: empty and poisoned bodies are refused.
    assert.equal((await send({ method: "DELETE", headers: { "content-length": "0" } })).statusCode, 400)
    assert.equal((await send({ method: "POST", payload: "{\"__proto__\":{\"polluted\":true}}" })).statusCode, 400)
    const framed = await send({ method: "DELETE", payload: "{\"id\":1}" })
    assert.equal(framed.statusCode, 200, framed.body)
    assert.deepEqual(server.received.at(-1), { method: "DELETE", url: "/item", body: "{\"id\":1}" })
    assert.equal(server.received.length, 2)
  } finally { await fs.rm(server.cleanupDirectory, { recursive: true, force: true }) }
})

// Writes the request line raw, so the target reaches the server exactly as written; resolves with the
// response status once its head arrived (the upstream has recorded the request by then).
function rawGet(port: number, target: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write([
      `GET ${target} HTTP/1.1`, `Host: ${headers.host ?? `127.0.0.1:${port}`}`,
      ...Object.entries(headers).filter(([name]) => name !== "host").map(([name, value]) => `${name}: ${value}`), "", "",
    ].join("\r\n")))
    sockets.push(socket)
    let data = ""
    socket.on("data", (chunk) => {
      data += chunk
      if (!data.includes("\r\n\r\n")) return
      socket.destroy()
      resolve(Number(data.split(" ")[1]))
    })
    socket.on("error", reject)
  })
}

it("forwards SideCar and preview queries and percent-encoded paths with the bytes the client sent", async () => {
  const server = await startServer()
  try {
    const token = server.preview.token
    const entries: Array<{ prefix: string; headers: Record<string, string> }> = [
      { prefix: "/sidecars/fixture", headers: { cookie: server.cookie } },
      { prefix: `/previews/${token}`, headers: {} },
      { prefix: "", headers: { host: `${token}.preview.localhost:${server.port}` } },
    ]
    const queries = ["?q=50%", "?q=%FF", "?name=caf%E9", "?q=a%20b&next=%2Fhome"]
    const paths = [
      ["/100%25.json", "/100%25.json"], ["/50%25%20off.json", "/50%25%20off.json"],
      ["/@vite/client", "/@vite/client"], ["/a+b:c,d=e.js", "/a+b:c,d=e.js"], ["/caf%C3%A9.json", "/caf%C3%A9.json"],
    ]
    const expect = async (target: string, headers: Record<string, string>, forwarded: string) => {
      assert.equal(await rawGet(server.port, target, headers), 200, target)
      assert.equal(server.received.at(-1)?.url, forwarded, target)
    }
    for (const { prefix, headers } of entries) {
      for (const query of queries) await expect(`${prefix}/data.json${query}`, headers, `/data.json${query}`)
      for (const [path, forwarded] of paths) await expect(`${prefix}${path}`, headers, forwarded)
    }
    // A session's root-relative asset, resolved through the preview its Referer names.
    for (const query of queries) {
      await expect(`/assets/app.js${query}`, { cookie: server.cookie, referer: `${server.origin}/previews/${token}/page` }, `/assets/app.js${query}`)
    }
  } finally { await fs.rm(server.cleanupDirectory, { recursive: true, force: true }) }
})

it("rewrites previewed HTML read from the upstream body stream", async () => {
  const server = await startServer({ html: "<html><head><script src=\"/app.js\"></script></head><body>preview-marker</body></html>" })
  try {
    const token = server.preview.token
    for (const [request, script] of [
      [{ url: `/previews/${token}/page` }, `src="/previews/${token}/app.js"`],
      [{ url: "/page", headers: { host: `${token}.preview.localhost` } }, "src=\"/app.js\""],
    ] as const) {
      const response = await server.app.inject({ method: "GET", ...request })
      assert.equal(response.statusCode, 200, `${request.url} ${response.body}`)
      assert.match(String(response.headers["content-type"]), /^text\/html/, request.url)
      assert.ok(response.body.includes("preview-marker"), request.url)
      assert.ok(response.body.includes(script), request.url)
      assert.ok(response.body.indexOf("codenomad-preview-location") < response.body.indexOf(script), request.url)
    }
  } finally { await fs.rm(server.cleanupDirectory, { recursive: true, force: true }) }
})

it("relays other preview responses as the upstream body stream", async () => {
  const server = await startServer()
  try {
    const token = server.preview.token
    for (const request of [{ url: `/previews/${token}/data.json` }, { url: "/data.json", headers: { host: `${token}.preview.localhost` } }]) {
      const response = await server.app.inject({ method: "GET", ...request })
      assert.equal(response.statusCode, 200, request.url)
      assert.equal(response.body, "{\"ok\":true}", request.url)
    }
  } finally { await fs.rm(server.cleanupDirectory, { recursive: true, force: true }) }
})

it("forwards WebDAV, CalDAV and SEARCH methods with their bodies to SideCars and previews", async () => {
  const server = await startServer()
  try {
    const token = server.preview.token
    const methods = [
      ["PROPFIND", true], ["PROPPATCH", true], ["MKCOL", true], ["COPY", true], ["MOVE", true],
      ["LOCK", true], ["UNLOCK", false], ["SEARCH", true], ["REPORT", true], ["MKCALENDAR", true],
    ] as const
    for (const [method, hasBody] of methods) {
      for (const [url, headers] of [["/sidecars/fixture/dav", { cookie: server.cookie }], [`/previews/${token}/dav`, {}]] as const) {
        const response = await server.app.inject({
          method, url, ...(hasBody ? { headers: { ...headers, "content-type": "text/plain" }, payload: `${method} body` } : { headers }),
        })
        assert.equal(response.statusCode, 200, `${method} ${url} ${response.body}`)
        assert.equal(response.body, "{\"ok\":true}", `${method} ${url}`)
      }
    }
    assert.deepEqual(server.received, methods.flatMap(([method, hasBody]) =>
      [0, 1].map(() => ({ method, url: "/dav", body: hasBody ? `${method} body` : "" }))))
    // The instance proxy's own handler answers them as well; this fixture has no workspace.
    const instance = await server.app.inject({ method: "PROPFIND", url: "/workspaces/missing/instance/api/session", headers: { cookie: server.cookie } })
    assert.equal(instance.statusCode, 404)
    assert.deepEqual(instance.json(), { error: "Workspace not found" })
  } finally { await fs.rm(server.cleanupDirectory, { recursive: true, force: true }) }
})
