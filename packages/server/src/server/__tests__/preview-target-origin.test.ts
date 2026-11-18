import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import test, { type TestContext } from "node:test"
import pino from "pino"
import { AuthManager } from "../../auth/manager"
import { PreviewManager } from "../../previews/manager"
import { createHttpServer } from "../http-server"

/** A local HTTP server that records every request and upgrade it receives. */
async function startRecorder(t: TestContext) {
  const seen: string[] = []
  const sockets = new Set<net.Socket>()
  const server = http.createServer((request, response) => {
    seen.push(request.url ?? "")
    request.resume()
    response.writeHead(200, { "content-type": "application/json" }).end("{\"ok\":true}")
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  server.on("upgrade", (request, socket: net.Socket) => {
    seen.push(`upgrade ${request.url ?? ""}`)
    const accept = crypto.createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
    socket.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve) => {
    for (const socket of sockets) socket.destroy()
    server.close(() => resolve())
  }))
  return { host: `127.0.0.1:${(server.address() as net.AddressInfo).port}`, seen }
}

async function startServer(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-preview-origin-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const logger = pino({ level: "silent" })
  const authManager = new AuthManager({
    configPath: path.join(directory, "config.yaml"), username: "codenomad", password: "test-password", generateToken: false,
  }, logger)
  const target = await startRecorder(t)
  const other = await startRecorder(t)
  const previewManager = new PreviewManager()
  const { token } = previewManager.create("fixture", `http://${target.host}`)
  const stub = new Proxy({}, { get: () => () => undefined }) as never
  const { instance: app } = createHttpServer({
    bindHost: "127.0.0.1", bindPort: 0, defaultPort: 0, protocol: "http",
    workspaceManager: stub, settings: stub, fileSystemBrowser: stub, eventBus: stub,
    serverMeta: { localUrl: "http://localhost:0", eventsUrl: "/api/events", listeningMode: "local", localPort: 0, hostLabel: "test", workspaceRoot: directory, addresses: [] } as never,
    instanceStore: stub, speechService: stub, sidecarManager: stub, previewManager,
    clientConnectionManager: stub, remoteProxySessionManager: stub, yoloManager: stub,
    authManager, logger, nativeParent: stub, automationBridgeToken: "fixture-token",
    remoteControlManager: stub, uiStaticDir: directory,
  })
  t.after(async () => {
    app.server.closeAllConnections?.()
    await app.close()
  })
  await app.listen({ host: "127.0.0.1", port: 0 })
  const port = (app.server.address() as net.AddressInfo).port
  const session = authManager.createSession("codenomad")
  return { port, origin: `http://127.0.0.1:${port}`, cookie: `${authManager.getCookieName()}=${session.id}`, token, target, other }
}

/** Sends the request target verbatim, as a client writes it on the request line. */
function get(port: number, target: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: target, headers: { host: `127.0.0.1:${port}`, ...headers } }, (response) => {
      response.resume()
      response.on("end", () => resolve(response.statusCode ?? 0))
    })
    request.on("error", reject)
    request.end()
  })
}

function upgrade(port: number, target: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: target, headers: {
      host: `127.0.0.1:${port}`, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13",
      "sec-websocket-key": crypto.randomBytes(16).toString("base64"), ...headers,
    } })
    request.on("response", (response) => { response.resume(); resolve(response.statusCode ?? 0) })
    request.on("upgrade", (response, socket) => { socket.destroy(); resolve(response.statusCode ?? 0) })
    request.on("error", reject)
    request.end()
  })
}

test("preview targets stay on the preview origin however the path begins", async (t) => {
  const server = await startServer(t)
  const { token, other } = server
  const capability = { host: `${token}.preview.localhost:${server.port}` }
  const fallback = { cookie: server.cookie, referer: `${server.origin}/previews/${token}/page` }
  const cases: Array<[string, Record<string, string>?]> = [
    [`/previews/${token}/%5C%5C${other.host}/x`],
    [`/previews/${token}/%5C/${other.host}/x`],
    [`/previews/${token}//%5C${other.host}/x`],
    [`/previews/${token}/%2F%5C${other.host}/x`],
    [`/previews/${token}/%09/${other.host}/x`],
    [`/previews/${token}/\\\\${other.host}/x`],
    [`/previews/${token}//\\${other.host}/x`],
    [`/previews/${token}/\\/${other.host}/x?q=1`],
    [`/\\\\${other.host}/x`, capability],
    [`//\\${other.host}/x`, capability],
    [`/\\/${other.host}/x`, capability],
    [`/\\\\${other.host}/x`, fallback],
    [`//\\${other.host}/x`, fallback],
  ]
  const reached: string[] = []
  for (const [target, headers] of cases) {
    const before = other.seen.length
    await get(server.port, target, headers)
    if (other.seen.length !== before) reached.push(target)
  }
  for (const [target, headers] of [
    [`/previews/${token}/%5C%5C${other.host}/ws`],
    [`/previews/${token}/\\\\${other.host}/ws`],
    [`/\\\\${other.host}/ws`, capability],
  ] as Array<[string, Record<string, string>?]>) {
    const before = other.seen.length
    await upgrade(server.port, target, headers)
    if (other.seen.length !== before) reached.push(`upgrade ${target}`)
  }
  assert.deepEqual(reached, [])
  assert.deepEqual(other.seen, [])
  // Whatever was served came from the preview target itself.
  for (const forwarded of server.target.seen) assert.ok(forwarded.startsWith(`/${other.host}/`) || forwarded.startsWith("upgrade /"), forwarded)
})

test("ordinary preview paths still reach the preview target", async (t) => {
  const server = await startServer(t)
  const { token, target } = server
  const capability = { host: `${token}.preview.localhost:${server.port}` }
  const fallback = { cookie: server.cookie, referer: `${server.origin}/previews/${token}/page` }
  const cases: Array<[string, string, Record<string, string>?]> = [
    [`/previews/${token}`, "/"],
    [`/previews/${token}/`, "/"],
    [`/previews/${token}/@vite/client`, "/@vite/client"],
    [`/previews/${token}/src/nested/main.ts?import&t=1`, "/src/nested/main.ts?import&t=1"],
    [`/previews/${token}//127.0.0.1:9/private`, "/127.0.0.1:9/private"],
    ["/@vite/client?x=1", "/@vite/client?x=1", capability],
    ["/src/nested/app.js", "/src/nested/app.js", capability],
    ["/@vite/client", "/@vite/client", fallback],
    ["/assets/nested/app.js?v=2", "/assets/nested/app.js?v=2", fallback],
  ]
  for (const [request, , headers] of cases) {
    assert.equal(await get(server.port, request, headers), 200, request)
  }
  assert.equal(await upgrade(server.port, `/previews/${token}/ws?x=1`), 101)
  assert.deepEqual(target.seen, [...cases.map(([, forwarded]) => forwarded), "upgrade /ws?x=1"])
})
