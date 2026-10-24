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
import type { PreviewSettings, SideCar } from "../../api-types"
import { AuthManager } from "../../auth/manager"
import { PreviewManager } from "../../previews/manager"
import { DEFAULT_PREVIEW_SETTINGS, previewDocumentSandbox } from "../../previews/policy"
import { createHttpServer } from "../http-server"

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

const apps: FastifyInstance[] = []
const upstreams: http.Server[] = []
const upstreamSocketCleanups: Array<() => void> = []
const sockets: net.Socket[] = []
type UpstreamOptions = {
  cookies?: string[]
  fragmented?: boolean
  denied?: boolean
  html?: boolean
  /** An empty string omits the header, like an upstream that never typed its body. */
  contentType?: string
  body?: string
  permissionsPolicy?: string
  featurePolicy?: string
  cacheControl?: string
  etag?: string
  expires?: string
  lastModified?: string
}

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
  const connections = new Set<net.Socket>()
  const upstream = http.createServer((request, response) => {
    requests.push(request.headers)
    if (options.cookies) response.setHeader("Set-Cookie", options.cookies)
    if (options.permissionsPolicy) response.setHeader("Permissions-Policy", options.permissionsPolicy)
    if (options.featurePolicy) response.setHeader("Feature-Policy", options.featurePolicy)
    if (options.cacheControl) response.setHeader("Cache-Control", options.cacheControl)
    if (options.etag) response.setHeader("ETag", options.etag)
    if (options.expires) response.setHeader("Expires", options.expires)
    if (options.lastModified) response.setHeader("Last-Modified", options.lastModified)
    const headers: http.OutgoingHttpHeaders = { "content-security-policy": "default-src *" }
    const contentType = options.contentType ?? (options.html ? "text/html" : "application/json")
    if (contentType) headers["content-type"] = contentType
    response.writeHead(200, headers)
    response.end(options.body ?? (options.html ? "<html><body>preview fixture</body></html>" : "{\"ok\":true}"))
  })
  upstream.on("connection", (socket) => {
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
  })
  upstreams.push(upstream)
  upstreamSocketCleanups.push(() => { for (const socket of connections) socket.destroy() })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  return { port: (upstream.address() as net.AddressInfo).port, upgrades, requests }
}

/** Raw WebSocket handshake, like a browser's; resolves once the status line and headers arrived. */
function webSocketUpgrade(port: number, pathname: string, headers: Record<string, string>): Promise<{ status: number; head: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      const key = crypto.randomBytes(16).toString("base64")
      const lines = [
        `GET ${pathname} HTTP/1.1`,
        "Host: 127.0.0.1",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        "", "",
      ]
      socket.write(lines.join("\r\n"))
    })
    sockets.push(socket)
    socket.setTimeout(4000, () => { reject(new Error(`WebSocket handshake timed out: ${pathname}`)) })
    let head = ""
    socket.on("data", (chunk) => {
      head += chunk.toString("latin1")
      const end = head.indexOf("\r\n\r\n")
      if (end < 0) return
      // Abort like a browser tab close: a FIN would leave the proxied
      // connection half-open and the servers would never finish closing.
      socket.resetAndDestroy()
      resolve({ status: Number(head.split(" ")[1]), head: head.slice(0, end) })
    })
    socket.on("error", reject)
  })
}

async function startServer(options: UpstreamOptions & {
  cookieName?: string
  prefixMode?: SideCar["prefixMode"]
  preview?: PreviewSettings
  bindHost?: string
} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-sidecar-proxy-"))
  const logger = pino({ level: "silent" })
  const authManager = new AuthManager({
    configPath: path.join(directory, "config.yaml"),
    username: "codenomad",
    password: "test-password",
    generateToken: false,
    cookieName: options.cookieName,
  }, logger)
  const { port, upgrades, requests } = await startSideCarUpstream(options)
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
  const previewSettings = options.preview ?? DEFAULT_PREVIEW_SETTINGS
  // The preview proxy reads only this owner; every unrelated settings method is a no-op.
  const settings = new Proxy({
    getOwner: (kind: string, owner: string) =>
      kind === "config" && owner === "server" ? { preview: previewSettings } : {},
  }, { get: (target, property) => Reflect.get(target, property) ?? (() => undefined) }) as never
  const previewManager = new PreviewManager()
  const preview = previewManager.create("fixture", `http://127.0.0.1:${port}`)
  const { instance: app } = createHttpServer({
    bindHost: options.bindHost ?? "127.0.0.1", bindPort: 0, defaultPort: 0, protocol: "http",
    workspaceManager: stub, settings, fileSystemBrowser: stub, eventBus: stub,
    serverMeta: { localUrl: "http://app.example.com:8443", eventsUrl: "/api/events", host: "127.0.0.1", listeningMode: "local", localPort: 8443, hostLabel: "test", workspaceRoot: directory, addresses: [] } as never,
    instanceStore: stub, speechService: stub, sidecarManager: sidecarManager as never, previewManager,
    clientConnectionManager: stub, remoteProxySessionManager: stub, yoloManager: stub,
    authManager, logger, nativeParent: stub, automationBridgeToken: "fixture-token",
    remoteControlManager: stub, uiStaticDir: directory,
  })
  apps.push(app)
  await app.listen({ host: "127.0.0.1", port: 0 })
  const address = app.server.address()
  assert.ok(address && typeof address === "object")
  const session = authManager.createSession("codenomad")
  return {
    app,
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    cookie: `${authManager.getCookieName()}=${session.id}`,
    upgrades,
    requests,
    preview,
    cleanupDirectory: directory,
  }
}

it("SideCar WebSocket upgrades require the SameSite session cookie a same-origin frame sends", async () => {
  const server = await startServer()
  try {
    const anonymous = await webSocketUpgrade(server.port, "/sidecars/fixture/ws", {})
    assert.equal(anonymous.status, 401)

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

const appPreviewSettings: PreviewSettings = { ...DEFAULT_PREVIEW_SETTINGS, originMode: "app" }
const customPreviewSettings: PreviewSettings = {
  ...DEFAULT_PREVIEW_SETTINGS,
  originMode: "custom",
  customOrigin: "http://preview.example.com",
}

it("path-proxied loopback HTML previews stay opaque under the default policy", async () => {
  const server = await startServer({ html: true })
  try {
    const response = await server.app.inject({
      url: server.preview.proxyUrl,
      headers: { origin: server.origin, cookie: `${server.cookie}; devkit_session=secret` },
    })
    assert.equal(response.statusCode, 200)
    // Exactly the injected policy: the target's own CSP is overridden.
    const csp = response.headers["content-security-policy"]
    assert.equal(csp, previewDocumentSandbox(false, DEFAULT_PREVIEW_SETTINGS.sandbox))
    assert.equal(String(csp).includes("allow-same-origin"), false)
    assert.equal(server.requests.at(-1)?.cookie, undefined)
  } finally {
    await fs.rm(server.cleanupDirectory, { recursive: true, force: true })
  }
})

it("app origin mode trusts loopback path-proxied documents", async () => {
  const server = await startServer({ html: true, preview: appPreviewSettings })
  try {
    const response = await server.app.inject({
      url: server.preview.proxyUrl,
      headers: { origin: server.origin, cookie: server.cookie },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers["content-security-policy"], previewDocumentSandbox(true, DEFAULT_PREVIEW_SETTINGS.sandbox))
  } finally {
    await fs.rm(server.cleanupDirectory, { recursive: true, force: true })
  }
})

it("custom origin mode trusts a preview only at its configured host", async () => {
  const server = await startServer({ html: true, preview: customPreviewSettings })
  try {
    const atCustomOrigin = await server.app.inject({
      url: server.preview.proxyUrl,
      headers: { host: "preview.example.com", origin: server.origin, cookie: server.cookie },
    })
    assert.equal(atCustomOrigin.statusCode, 200)
    assert.equal(atCustomOrigin.headers["content-security-policy"], previewDocumentSandbox(true, DEFAULT_PREVIEW_SETTINGS.sandbox))

    const atAppOrigin = await server.app.inject({
      url: server.preview.proxyUrl,
      headers: { host: "app.example.com:8443", origin: server.origin, cookie: server.cookie },
    })
    assert.equal(atAppOrigin.statusCode, 200)
    assert.equal(atAppOrigin.headers["content-security-policy"], previewDocumentSandbox(false, DEFAULT_PREVIEW_SETTINGS.sandbox))
  } finally {
    await fs.rm(server.cleanupDirectory, { recursive: true, force: true })
  }
})

it("path-proxied SVG, XML and untyped responses still carry the policy CSP", async () => {
  for (const contentType of ["image/svg+xml", "application/xml", ""]) {
    const server = await startServer({ contentType, body: "<svg xmlns=\"http://www.w3.org/2000/svg\" />" })
    try {
      const response = await server.app.inject({
        url: server.preview.proxyUrl,
        headers: { origin: server.origin, cookie: server.cookie },
      })
      assert.equal(response.statusCode, 200)
      assert.equal(
        response.headers["content-security-policy"],
        previewDocumentSandbox(false, DEFAULT_PREVIEW_SETTINGS.sandbox),
        `content-type: ${contentType || "<missing>"}`,
      )
    } finally {
      await fs.rm(server.cleanupDirectory, { recursive: true, force: true })
    }
  }
})

it("path-proxied non-document responses also carry the policy CSP", async () => {
  const server = await startServer()
  try {
    const response = await server.app.inject({
      url: server.preview.proxyUrl,
      headers: { origin: server.origin, cookie: `${server.cookie}; devkit_session=secret` },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers["content-security-policy"], previewDocumentSandbox(false, DEFAULT_PREVIEW_SETTINGS.sandbox))
    assert.equal(server.requests.at(-1)?.cookie, undefined)
  } finally {
    await fs.rm(server.cleanupDirectory, { recursive: true, force: true })
  }
})

it("configured sandbox capabilities appear exactly in the enforced CSP", async () => {
  const sandbox = { ...DEFAULT_PREVIEW_SETTINGS.sandbox, forms: false }
  const server = await startServer({ html: true, preview: { ...DEFAULT_PREVIEW_SETTINGS, originMode: "app", sandbox } })
  try {
    const response = await server.app.inject({
      url: server.preview.proxyUrl,
      headers: { origin: server.origin, cookie: server.cookie },
    })
    const csp = String(response.headers["content-security-policy"])
    assert.equal(csp, previewDocumentSandbox(true, sandbox))
    assert.match(csp, /allow-modals/)
    assert.doesNotMatch(csp, /allow-forms/)
  } finally {
    await fs.rm(server.cleanupDirectory, { recursive: true, force: true })
  }
})

it("target Permissions-Policy and Feature-Policy never reach the proxied document", async () => {
  const server = await startServer({ html: true, permissionsPolicy: "camera=()", featurePolicy: "camera 'none'" })
  try {
    const response = await server.app.inject({
      url: server.preview.proxyUrl,
      headers: { origin: server.origin, cookie: server.cookie },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers["permissions-policy"], undefined)
    assert.equal(response.headers["permissions-policy-report-only"], undefined)
    assert.equal(response.headers["feature-policy"], undefined)
  } finally {
    await fs.rm(server.cleanupDirectory, { recursive: true, force: true })
  }
})

it("referer fallback documents use the resolved app policy", async () => {
  const server = await startServer({ html: true, preview: appPreviewSettings })
  try {
    const response = await server.app.inject({
      url: "/fallback-document",
      headers: { origin: server.origin, cookie: server.cookie, referer: `${server.origin}${server.preview.proxyUrl}` },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers["content-security-policy"], previewDocumentSandbox(true, DEFAULT_PREVIEW_SETTINGS.sandbox))
    assert.equal(server.requests.at(-1)?.cookie, undefined)
  } finally {
    await fs.rm(server.cleanupDirectory, { recursive: true, force: true })
  }
})

it("custom origin mode leaves an app-origin referer fallback opaque", async () => {
  const server = await startServer({ html: true, preview: customPreviewSettings })
  try {
    const response = await server.app.inject({
      url: "/fallback-document",
      headers: { host: "app.example.com:8443", origin: server.origin, cookie: server.cookie, referer: `${server.origin}${server.preview.proxyUrl}` },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers["content-security-policy"], previewDocumentSandbox(false, DEFAULT_PREVIEW_SETTINGS.sandbox))
  } finally {
    await fs.rm(server.cleanupDirectory, { recursive: true, force: true })
  }
})

it("custom origin mode refuses the app's own origin from the stored policy", async () => {
  const server = await startServer({
    html: true,
    preview: { ...DEFAULT_PREVIEW_SETTINGS, originMode: "custom", customOrigin: "http://app.example.com:8443" },
  })
  try {
    const response = await server.app.inject({
      url: server.preview.proxyUrl,
      headers: { host: "app.example.com:8443", origin: server.origin, cookie: server.cookie },
    })
    assert.equal(response.statusCode, 200)
    // The app-origin resolve step degrades the custom mode, so the same Host
    // that would otherwise match stays opaque.
    assert.equal(response.headers["content-security-policy"], previewDocumentSandbox(false, DEFAULT_PREVIEW_SETTINGS.sandbox))
  } finally {
    await fs.rm(server.cleanupDirectory, { recursive: true, force: true })
  }
})

it("path-proxied responses are never cacheable with a stale origin tier", async () => {
  const server = await startServer({
    html: true,
    preview: appPreviewSettings,
    cacheControl: "public, max-age=600",
    etag: "\"preview-v1\"",
    expires: "Wed, 21 Oct 2037 07:28:00 GMT",
    lastModified: "Wed, 21 Oct 2026 07:28:00 GMT",
  })
  try {
    for (const url of [server.preview.proxyUrl, "/fallback-document"]) {
      const headers: Record<string, string> = { origin: server.origin, cookie: server.cookie }
      if (url === "/fallback-document") headers.referer = `${server.origin}${server.preview.proxyUrl}`
      const response = await server.app.inject({ url, headers })
      assert.equal(response.statusCode, 200, url)
      assert.equal(response.headers["cache-control"], "no-store", url)
      assert.equal(response.headers["pragma"], "no-cache", url)
      assert.equal(response.headers["expires"], undefined, url)
      assert.equal(response.headers["etag"], undefined, url)
      assert.equal(response.headers["last-modified"], undefined, url)
    }
  } finally {
    await fs.rm(server.cleanupDirectory, { recursive: true, force: true })
  }
})

it("capability-host preview responses keep the target cache headers", async () => {
  const server = await startServer({
    html: true,
    cacheControl: "public, max-age=600",
    etag: "\"preview-v1\"",
    lastModified: "Wed, 21 Oct 2026 07:28:00 GMT",
  })
  try {
    const response = await server.app.inject({
      url: "/",
      headers: { host: `${server.preview.token}.preview.localhost:${server.port}`, cookie: server.cookie },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers["content-security-policy"], undefined)
    assert.equal(response.headers["cache-control"], "public, max-age=600")
    assert.equal(response.headers["etag"], "\"preview-v1\"")
    assert.equal(response.headers["last-modified"], "Wed, 21 Oct 2026 07:28:00 GMT")
  } finally {
    await fs.rm(server.cleanupDirectory, { recursive: true, force: true })
  }
})

it("a custom preview origin cannot call authenticated app APIs", async () => {
  const server = await startServer({ html: true, preview: customPreviewSettings })
  try {
    const fromPreviewOrigin = await server.app.inject({
      url: "/api/meta",
      headers: { origin: "http://preview.example.com", cookie: server.cookie },
    })
    assert.equal(fromPreviewOrigin.statusCode, 403)

    const fromPreviewReferer = await server.app.inject({
      url: "/workspaces/example/files?path=.",
      headers: { referer: "http://preview.example.com/previews/fixture/", cookie: server.cookie },
    })
    assert.equal(fromPreviewReferer.statusCode, 403)

    const fromAppOrigin = await server.app.inject({
      url: "/api/meta",
      headers: { origin: server.origin, cookie: server.cookie },
    })
    assert.equal(fromAppOrigin.statusCode, 200)

    // The preview proxy itself remains reachable from the custom origin.
    const previewAtCustomOrigin = await server.app.inject({
      url: server.preview.proxyUrl,
      headers: { host: "preview.example.com", cookie: server.cookie },
    })
    assert.equal(previewAtCustomOrigin.statusCode, 200)
  } finally {
    await fs.rm(server.cleanupDirectory, { recursive: true, force: true })
  }
})

it("the broad non-loopback CORS allow explicitly excludes the custom preview origin", async () => {
  const server = await startServer({ preview: customPreviewSettings, bindHost: "0.0.0.0" })
  try {
    const previewOrigin = await server.app.inject({
      url: "/api/meta",
      headers: { origin: "http://preview.example.com", cookie: server.cookie },
    })
    assert.equal(previewOrigin.statusCode, 403)
    assert.equal(previewOrigin.headers["access-control-allow-origin"], undefined)

    const otherOrigin = await server.app.inject({
      url: "/api/meta",
      headers: { origin: "https://elsewhere.example", cookie: server.cookie },
    })
    assert.equal(otherOrigin.statusCode, 200)
    assert.equal(otherOrigin.headers["access-control-allow-origin"], "https://elsewhere.example")
  } finally {
    await fs.rm(server.cleanupDirectory, { recursive: true, force: true })
  }
})
