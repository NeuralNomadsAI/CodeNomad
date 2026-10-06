import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import { createServer as createHttpServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http"
import { createServer as createHttpsServer } from "node:https"
import { connect, type Socket } from "node:net"
import path from "node:path"
import { Readable } from "node:stream"
import { after, before, it } from "node:test"
import { AuthManager } from "../../../auth/manager"
import type { Logger } from "../../../logger"
import { PreviewManager } from "../../../previews/manager"
import { createHttpServer as createCodeNomadServer } from "../../http-server"

const directory = process.env.PREVIEW_SECURITY_DIRECTORY!
assert.ok(directory, "run through preview-security.test.ts with disposable certificates")
const certificates = JSON.parse(fs.readFileSync(path.join(directory, "certificates.json"), "utf8")) as Record<string, { key: string; cert: string }>
const logger = { child: () => logger, debug() {}, info() {}, warn() {}, error() {}, trace() {}, isLevelEnabled: () => false } as unknown as Logger
const previews = new PreviewManager()
const auth = new AuthManager({ configPath: path.join(directory, "config.yaml"), username: "test", password: "fixture-password-only", generateToken: false }, logger)
const session = auth.createSession("test")
const cookie = `${auth.getCookieName()}=${session.id}; harmless_app_cookie=fixture`
const credentials = { cookie, cookie2: "legacy_fixture_cookie=value", authorization: "Bearer fixture-only", "proxy-authorization": "Basic fixture-only" }
const seen: { url: string; headers: IncomingHttpHeaders; kind: string; socket: Socket }[] = []
const servers: ReturnType<typeof createHttpServer>[] = []
const sockets = new Set<Socket>()
const targets = new Map<string, string>()
const clientFrame = Buffer.from([0x81, 0x83, 1, 2, 3, 4, 0x60, 0x60, 0x60])
let echoInput = Buffer.alloc(0)
let markAbortStarted: ((socket: Socket) => void) | undefined
let blockedSource: Readable | undefined
const bulkFrames = Array.from({ length: 64 }, (_, index) => Buffer.concat([Buffer.from([0x82, 126, 0x80, 0]), Buffer.alloc(32_768, index)]))
let app: ReturnType<typeof createCodeNomadServer>
let port: number

function assertSanitized(headers: IncomingHttpHeaders) {
  for (const name of Object.keys(credentials)) assert.equal(headers[name], undefined, `${name} must never reach a preview`)
  assert.equal(headers["x-preview-test"], "preserved")
  assert.equal(headers["accept"], "application/json")
}

function waitForPeerClose(socket: Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onClose = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => {
      socket.off("close", onClose)
      reject(new Error("owned upstream peer did not close after cancellation"))
    }, 1000)
    // A reset is expected when cancelling while frames remain queued. Wait for
    // close, not events.once(), which rejects on the preceding ECONNRESET.
    socket.once("close", onClose)
  })
}

before(async () => {
  const handler = (kind: string) => async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    seen.push({ url: request.url!, headers: request.headers, kind, socket: request.socket })
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/final", "set-cookie": "untrusted=fixture; Path=/" }).end()
    } else if (request.url === "/absolute-redirect") {
      response.writeHead(302, { location: `${targets.get(kind)}/final` }).end()
    } else if (request.url === "/cross-origin-redirect") {
      response.writeHead(302, { location: `${targets.get("valid")}/final` }).end()
    } else if (request.url === "/safe-external-redirect") {
      response.writeHead(302, { location: "https://public-preview.invalid/final" }).end()
    } else if (request.url === "/relative-redirect/page") {
      response.writeHead(302, { location: "../../../final?keep=1#section" }).end()
    } else if (request.url === "/backslash-redirect") {
      response.writeHead(302, { location: targets.get("valid")!.replaceAll("/", "\\") + "\\final" }).end()
    } else if (request.url === "/refresh") {
      response.writeHead(200, { refresh: `0; url=${targets.get("valid")}/final` }).end()
    } else {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ url: request.url, headers: request.headers, method: request.method, body: Buffer.concat(chunks).toString() }))
    }
  }
  for (const kind of ["http", ...Object.keys(certificates)]) {
    const server = kind === "http" ? createHttpServer(handler(kind)) : createHttpsServer(certificates[kind], handler(kind))
    servers.push(server)
    server.on("connection", (socket) => {
      sockets.add(socket)
      socket.on("close", () => sockets.delete(socket))
      socket.on("error", () => {})
    })
    server.on("upgrade", (request, socket) => {
      // The owned peer acknowledges TCP EOF. Node's upgraded HTTP sockets are
      // half-open by default; retaining our fixture's write half is not a proxy
      // resource leak and would make remote-close assertions meaningless.
      socket.once("end", () => socket.end())
      seen.push({ url: request.url!, headers: request.headers, kind, socket: request.socket })
      const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
      const base = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n`
      const cookies = `Set-Cookie: ${auth.getCookieName()}=malicious; HttpOnly; Path=/\r\nsEt-CoOkIe: other=bad; Path=/\r\nSET-COOKIE2: legacy=bad\r\n`
      if (request.url === "/fragmented-ws") {
        socket.write(`${base}${cookies}\r`)
        setImmediate(() => socket.end("\nfixture-upgrade"))
      } else if (request.url === "/malicious-ws") {
        socket.end(`${base}${cookies}\r\nfixture-upgrade`)
      } else if (request.url === "/redirect-ws") {
        socket.end(`HTTP/1.1 302 Found\r\n${cookies}Location: ${targets.get("valid")}/socket\r\n\r\n`)
      } else if (request.url === "/oversized-ws") {
        socket.end(`${base}${cookies}X-Large: ${"x".repeat(17_000)}\r\n\r\n`)
      } else if (request.url === "/malformed-ws") {
        socket.end(`${base}${cookies} bad-folded: value\r\n\r\n`)
      } else if (request.url === "/incomplete-ws") {
        socket.end(`${base}${cookies}`)
      } else if (request.url === "/stall-ws") {
        socket.write(base)
      } else if (request.url === "/abort-ws") {
        socket.write(base)
        markAbortStarted?.(request.socket)
      } else if (request.url === "/close-ws") {
        socket.destroy()
      } else if (request.url === "/error-ws") {
        socket.write(`${base}\r\nfixture-upgrade`)
        setTimeout(() => socket.destroy(new Error("owned fixture upstream failure")), 20)
      } else if (request.url === "/echo-ws") {
        socket.write(Buffer.concat([Buffer.from(`${base}\r\n`), Buffer.from([0x81, 5]), Buffer.from("early")]))
        socket.on("data", (chunk) => {
          echoInput = Buffer.concat([echoInput, chunk])
          if (echoInput.length >= clientFrame.length) socket.end(Buffer.from([0x81, 4, ...Buffer.from("echo")]))
        })
      } else if (request.url === "/bulk-ws") {
        Readable.from([Buffer.from(`${base}\r\n`), ...bulkFrames], { objectMode: false }).pipe(socket)
      } else if (request.url === "/disconnect-bulk-ws") {
        blockedSource = Readable.from([Buffer.from(`${base}\r\n`), ...Array.from({ length: 512 }, (_, index) => bulkFrames[index % bulkFrames.length])], { objectMode: false })
        socket.once("close", () => blockedSource?.destroy())
        blockedSource.pipe(socket)
      } else socket.end(`${base}\r\nfixture-upgrade`)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")
    targets.set(kind, `${kind === "http" ? "http" : "https"}://127.0.0.1:${address.port}`)
  }
  // Unused integrations are inert mocks. The real production auth hook, proxy
  // registration, fallback router, reply-from transport and upgrade listeners run.
  app = createCodeNomadServer({
    bindHost: "127.0.0.1", bindPort: 0, defaultPort: 0, protocol: "http",
    logger, authManager: auth, previewManager: previews, uiStaticDir: directory,
    workspaceManager: {}, settings: {}, fileSystemBrowser: {}, eventBus: {}, serverMeta: {},
    instanceStore: {}, speechService: {}, sidecarManager: {}, clientConnectionManager: {},
    remoteProxySessionManager: {}, yoloManager: {}, nativeParent: {}, automationBridgeToken: "fixture-only",
  } as unknown as Parameters<typeof createCodeNomadServer>[0])
  app.instance.server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  port = (await app.start()).port
})

after(async () => {
  for (const socket of sockets) socket.destroy()
  await app?.stop()
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

function createPreview(kind: string) {
  const preview = previews.create("fixture-session", targets.get(kind)!)
  return { token: preview.token, base: previews.buildProxyBasePath(preview.token) }
}

const headers = { ...credentials, host: "127.0.0.1", "x-preview-test": "preserved", accept: "application/json", origin: "http://codenomad-fixture.invalid" }

it("strips all credentials on path, capability host, POST body and authenticated fallback routes", async () => {
  const { token, base } = createPreview("http")
  const responses = [
    await app.instance.inject({ url: `${base}/final?query=kept`, headers }),
    await app.instance.inject({ url: "/final", headers: { ...headers, host: `${token}.preview.localhost:${port}` } }),
    await app.instance.inject({ method: "POST", url: `${base}/final`, headers: { ...headers, "content-type": "text/plain" }, payload: "harmless payload" }),
    await app.instance.inject({ url: "/fallback-asset.js", headers: { ...headers, referer: `http://127.0.0.1:${port}${base}/page` } }),
  ]
  for (const response of responses) {
    assert.equal(response.statusCode, 200, response.body)
    assertSanitized(response.json().headers)
    assert.equal(response.json().headers.origin, targets.get("http"))
  }
  assert.equal(responses[0].json().url, "/final?query=kept")
  assert.equal(responses[2].json().method, "POST")
  assert.equal(responses[2].json().body, "harmless payload")
})

it("keeps backend auth and unknown/revoked capability fences", async () => {
  const login = await app.instance.inject({ method: "POST", url: "/api/auth/login", payload: { username: "test", password: "fixture-password-only" } })
  assert.equal(login.statusCode, 200)
  assert.match(String(login.headers["set-cookie"]), /; Path=\//)
  const loginCookie = String(login.headers["set-cookie"]).split(";")[0]
  const status = await app.instance.inject({ url: "/api/auth/status", headers: { cookie: loginCookie } })
  assert.equal(status.json().authenticated, true)
  const loginPreview = createPreview("http")
  const proxied = await app.instance.inject({ url: `${loginPreview.base}/final`, headers: { ...headers, cookie: loginCookie } })
  assert.equal(proxied.statusCode, 200)
  assertSanitized(proxied.json().headers)
  assert.equal((await app.instance.inject({ url: "/api/previews" })).statusCode, 401)
  assert.equal((await app.instance.inject({ url: "/previews/unknown/final", headers: { accept: "application/json" } })).statusCode, 401)
  assert.equal((await app.instance.inject({ url: "/previews/unknown/final", headers })).statusCode, 404)
  const { token, base } = createPreview("http")
  assert.equal((await app.instance.inject({ url: `${base}/final`, headers: { origin: "null" } })).statusCode, 200)
  assert.equal((await app.instance.inject({ url: "/api/auth/status", headers: { origin: "null" } })).statusCode, 403)
  previews.delete(token)
  assert.equal((await app.instance.inject({ url: `${base}/final`, headers })).statusCode, 404)
})

it("does not follow upstream redirects and strips credentials again on browser follow-up", async () => {
  const { base } = createPreview("http")
  for (const suffix of ["redirect", "absolute-redirect"]) {
    const before = seen.length
    const response = await app.instance.inject({ url: `${base}/${suffix}`, headers })
    assert.equal(response.statusCode, 302)
    assert.equal(seen.length, before + 1, "reply-from must not follow the redirect internally")
    assertSanitized(seen.at(-1)!.headers)
    assert.equal(response.headers.location, `${base}/final`)
    assert.equal(response.headers["set-cookie"], undefined)
    const follow = await app.instance.inject({ url: String(response.headers.location), headers })
    assert.equal(follow.statusCode, 200)
    assertSanitized(follow.json().headers)
  }
  const before = seen.length
  const cross = await app.instance.inject({ url: `${base}/cross-origin-redirect`, headers })
  assert.equal(cross.statusCode, 302)
  assert.equal(cross.headers.location, undefined, "same-host/different-port redirects must not expose CodeNomad cookies to a browser")
  assert.equal(seen.length, before + 1, "no second origin request is made by the backend")
  const external = await app.instance.inject({ url: `${base}/safe-external-redirect`, headers })
  assert.equal(external.headers.location, undefined, "external redirects remain inert even behind a Host-rewriting reverse proxy")
  const relative = await app.instance.inject({ url: `${base}/relative-redirect/page`, headers })
  assert.equal(relative.headers.location, `${base}/final?keep=1#section`, "relative redirects cannot escape the capability path")
  const backslash = await app.instance.inject({ url: `${base}/backslash-redirect`, headers })
  assert.equal(backslash.headers.location, undefined)
  const refresh = await app.instance.inject({ url: `${base}/refresh`, headers })
  assert.equal(refresh.headers.refresh, undefined)
})

it("does not reuse HTTP upstream sockets, containing the nested Undici response-queue advisory", async () => {
  const { base } = createPreview("http")
  const connections: Socket[] = []
  for (let index = 0; index < 3; index++) {
    const response = await app.instance.inject({ url: `${base}/final`, headers })
    assert.equal(response.statusCode, 200)
    assert.equal(seen.at(-1)!.headers.connection, "close")
    connections.push(seen.at(-1)!.socket)
  }
  assert.equal(new Set(connections).size, 3)
})

it("HTTP accepts a trusted matching certificate but rejects expired, mismatched and untrusted certificates even with inherited TLS bypass", async () => {
  for (const kind of Object.keys(certificates)) {
    const { base } = createPreview(kind)
    const before = seen.length
    const response = await app.instance.inject({ url: `${base}/final`, headers })
    assert.equal(response.statusCode, kind === "valid" ? 200 : 502, `${kind}: ${response.body}`)
    assert.equal(seen.length, before + (kind === "valid" ? 1 : 0), "invalid TLS must fail before HTTP headers")
    if (kind === "valid") assertSanitized(response.json().headers)
  }
})

function upgrade(url: string, host = `127.0.0.1:${port}`, extraHeaders: Record<string, string> = credentials, initialFrame = Buffer.alloc(0)): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1")
    let result = ""
    socket.setTimeout(15_000, () => socket.destroy(new Error("upgrade timeout")))
    socket.once("error", reject)
    socket.on("data", (chunk) => { result += chunk })
    socket.once("close", () => resolve(result))
    socket.once("connect", () => socket.write(Buffer.concat([Buffer.from([
      `GET ${url} HTTP/1.1`, `Host: ${host}`, "Connection: Upgrade", "Upgrade: websocket",
      "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: Zml4dHVyZS10ZXN0LW9ubHk=",
      "X-Preview-Test: preserved", "Accept: application/json", "Origin: http://codenomad-fixture.invalid",
      ...Object.entries(extraHeaders).map(([name, value]) => `${name.toUpperCase()}: ${value}`), "", "",
    ].join("\r\n")), initialFrame])))
  })
}

it("WebSocket path and capability-host upgrades strip credentials and preserve the handshake", async () => {
  const { token, base } = createPreview("http")
  for (const [url, host] of [[`${base}/socket?keep=1`, undefined], ["/socket?keep=1", `${token}.preview.localhost:${port}`]]) {
    const response = await upgrade(url!, host)
    assert.match(response, /^HTTP\/1\.1 101/)
    assert.match(response, /fixture-upgrade/)
    assert.equal(seen.at(-1)!.url, "/socket?keep=1")
    assertSanitized(seen.at(-1)!.headers)
    assert.equal(seen.at(-1)!.headers.origin, targets.get("http"))
    assert.equal(seen.at(-1)!.headers["sec-websocket-version"], "13")
  }
  assert.match(await upgrade("/previews/unknown/socket", undefined, {}), /^HTTP\/1\.1 401/)
  assert.match(await upgrade("/previews/unknown/socket"), /^HTTP\/1\.1 404/)
})

it("WebSocket TLS verifies trust, expiry and hostname before sending upgrade credentials", async () => {
  for (const kind of Object.keys(certificates)) {
    const { base } = createPreview(kind)
    const before = seen.length
    const response = await upgrade(`${base}/socket`)
    assert.match(response, kind === "valid" ? /^HTTP\/1\.1 101/ : /^HTTP\/1\.1 502/, kind)
    assert.equal(seen.length, before + (kind === "valid" ? 1 : 0), "invalid TLS must fail before the upgrade request")
    if (kind === "valid") assertSanitized(seen.at(-1)!.headers)
  }
})

it("production WebSocket response admission strips malicious and fragmented cookies without losing coalesced payload bytes", async () => {
  const { base } = createPreview("http")
  for (const path of ["malicious-ws", "fragmented-ws"]) {
    const response = await upgrade(`${base}/${path}`)
    assert.match(response, /^HTTP\/1\.1 101/)
    assert.match(response, /fixture-upgrade$/)
    assert.doesNotMatch(response, /set-cookie|malicious/i)
    assert.match(response, /Sec-WebSocket-Accept:/)
  }
})

it("production WebSocket response admission rejects redirects, oversized, malformed, truncated and closed upstream handshakes", async () => {
  const { base } = createPreview("http")
  for (const path of ["redirect-ws", "oversized-ws", "malformed-ws", "incomplete-ws", "close-ws"]) {
    const response = await upgrade(`${base}/${path}`)
    assert.equal(response, "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
    const upstream = seen.at(-1)!.socket
    await waitForPeerClose(upstream)
    assert.equal(upstream.destroyed, true, "rejection must release the upstream connection")
  }
})

it("production WebSocket tunnel preserves a client frame coalesced with the request and upstream early frames", async () => {
  const { base } = createPreview("http")
  echoInput = Buffer.alloc(0)
  const response = await upgrade(`${base}/echo-ws`, undefined, credentials, clientFrame)
  assert.match(response, /^HTTP\/1\.1 101/)
  assert.match(response, /early/)
  assert.match(response, /echo$/)
  assert.deepEqual(echoInput, clientFrame, "request head bytes must be forwarded exactly once after admission")
})

it("production WebSocket handshake deadline closes a stalled upstream fail-closed", { timeout: 20_000 }, async () => {
  const { base } = createPreview("http")
  const start = Date.now()
  const response = await upgrade(`${base}/stall-ws`)
  assert.match(response, /^HTTP\/1\.1 502/)
  assert.ok(Date.now() - start < 15_000)
})

it("production WebSocket tunnel drains a slow recipient without dropping frames at upstream EOF", async () => {
  const { base } = createPreview("http")
  const result = await new Promise<Buffer>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1")
    const chunks: Buffer[] = []
    let delayed = false
    socket.setTimeout(5000, () => socket.destroy(new Error("bulk response timeout")))
    socket.once("error", reject)
    socket.on("data", (chunk) => {
      chunks.push(chunk)
      if (!delayed) {
        delayed = true
        socket.pause()
        setTimeout(() => socket.resume(), 50)
      }
    })
    socket.once("close", () => resolve(Buffer.concat(chunks)))
    socket.once("connect", () => socket.write(`GET ${base}/bulk-ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`))
  })
  const boundary = result.indexOf("\r\n\r\n") + 4
  assert.match(result.subarray(0, boundary).toString(), /^HTTP\/1\.1 101/)
  assert.deepEqual(result.subarray(boundary), Buffer.concat(bulkFrames))
})

it("production WebSocket tunnel closes both halves on client disconnect or upstream failure after admission", async () => {
  const { base } = createPreview("http")
  await new Promise<void>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1")
    socket.once("error", reject)
    socket.setTimeout(5000, () => socket.destroy(new Error("disconnect fixture timeout")))
    socket.once("data", async (chunk) => {
      try {
        assert.match(chunk.toString(), /^HTTP\/1\.1 101/)
        const upstream = seen.at(-1)!.socket
        const closed = waitForPeerClose(upstream)
        socket.destroy()
        await closed
        assert.equal(upstream.destroyed, true)
        resolve()
      } catch (error) { socket.destroy(); reject(error) }
    })
    socket.once("connect", () => socket.write(`GET ${base}/echo-ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`))
  })
  const response = await upgrade(`${base}/error-ws`)
  assert.match(response, /^HTTP\/1\.1 101/)
  assert.doesNotMatch(response, /502 Bad Gateway/, "post-admission failures must not inject a second HTTP response into frames")
})

it("production WebSocket tunnel cancels pending admission and blocked streaming on client disconnect", async () => {
  const { base } = createPreview("http")
  const started = new Promise<Socket>((resolve) => { markAbortStarted = resolve })
  const pending = connect(port, "127.0.0.1")
  pending.on("error", () => {})
  pending.once("connect", () => pending.write(`GET ${base}/abort-ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`))
  try {
    const upstream = await started
    const closed = waitForPeerClose(upstream)
    pending.destroy()
    await closed
    assert.equal(upstream.destroyed, true, "client cancellation must release a stalled upstream before its deadline")
  } finally { pending.destroy(); markAbortStarted = undefined }

  await new Promise<void>((resolve, reject) => {
    const client = connect(port, "127.0.0.1")
    client.once("error", reject)
    client.setTimeout(5000, () => client.destroy(new Error("blocked disconnect fixture timeout")))
    client.once("data", async (chunk) => {
      try {
        assert.match(chunk.toString(), /^HTTP\/1\.1 101/)
        client.pause()
        assert.equal(blockedSource?.readableEnded, false, "fixture must still have queued frames when the client cancels")
        const upstream = seen.at(-1)!.socket
        const closed = waitForPeerClose(upstream)
        client.destroy()
        await closed
        assert.equal(upstream.destroyed, true)
        resolve()
      } catch (error) { client.destroy(); reject(error) }
    })
    client.once("connect", () => client.write(`GET ${base}/disconnect-bulk-ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`))
  })
})
