import { createHash } from "node:crypto"
import { once } from "node:events"
import fs from "node:fs"
import http, { type IncomingHttpHeaders } from "node:http"
import type { Socket } from "node:net"
import os from "node:os"
import path from "node:path"
import type { TestContext } from "node:test"
import type { Logger } from "../../logger"
import { resolveConfigLocation } from "../../config/location"
import { SettingsService } from "../../settings/service"

/** Both controlled remotes issue this same preview token and the same paths. */
export const PREVIEW_TOKEN = "11111111-1111-4111-8111-111111111111"
export const PREVIEW_PREFIX = `/previews/${PREVIEW_TOKEN}`

/**
 * A remote CodeNomad's preview surface on real sockets: creation/deletion, HTML/JS
 * referencing its own prefix, JSON, redirects, SSE and a WebSocket that streams its label.
 */
export async function startPreviewRemote(t: TestContext, label: string, renderPage?: (pathname: string) => string | undefined) {
  const requests: { path: string; headers: IncomingHttpHeaders }[] = []
  const streams = new Set<http.ServerResponse | Socket>()
  let live = true
  const server = http.createServer(async (request, reply) => {
    const url = request.url!
    requests.push({ path: url, headers: request.headers })
    const json = (value: unknown) => { reply.setHeader("content-type", "application/json"); reply.end(JSON.stringify(value)) }
    if (url === "/api/meta") return json({ serverId: label, apiContract: 1 })
    if (url === "/api/auth/status") return json({ authenticated: true })
    if (url === "/api/previews" && request.method === "POST") {
      let body = ""
      for await (const chunk of request) body += chunk
      live = true
      return json({ token: PREVIEW_TOKEN, sessionId: JSON.parse(body).sessionId, targetUrl: "http://app.invalid/start",
        proxyUrl: `${PREVIEW_PREFIX}/start`, createdAt: new Date().toISOString() })
    }
    if (url === `/api/previews/${PREVIEW_TOKEN}` && request.method === "DELETE") { live = false; return reply.writeHead(204).end() }
    if (!live || !url.startsWith(`${PREVIEW_PREFIX}/`)) return reply.writeHead(404).end()
    reply.setHeader("set-cookie", "remote-app=private-cookie-sentinel; HttpOnly")
    const pathname = url.slice(PREVIEW_PREFIX.length)
    const page = renderPage?.(pathname)
    if (page !== undefined) return reply.writeHead(200, { "content-type": "text/html" }).end(page)
    if (pathname === "/start" || pathname === "/next") {
      reply.setHeader("content-type", "text/html")
      return reply.end(`<!doctype html><head><script src="${PREVIEW_PREFIX}/app.js"></script><script>const base=${JSON.stringify(PREVIEW_PREFIX)}</script></head><body>${label}${pathname}</body>`)
    }
    if (pathname === "/app.js") { reply.setHeader("content-type", "text/javascript"); return reply.end(`import "${PREVIEW_PREFIX}/dep.js"; window.label = "${label}"`) }
    if (pathname === "/leak.js") { reply.setHeader("content-type", "text/javascript"); return reply.end(`window.leaked = "private-${label}"`) }
    if (pathname === "/redirect") return reply.writeHead(302, { location: `${PREVIEW_PREFIX}/next` }).end()
    if (pathname === "/events") {
      reply.writeHead(200, { "content-type": "text/event-stream" })
      streams.add(reply)
      const timer = setInterval(() => reply.write(`data: ${label}\n\n`), 20)
      reply.once("close", () => { clearInterval(timer); streams.delete(reply) })
      return reply.write(`data: ${label}\n\n`)
    }
    json({ label, page: pathname, method: request.method })
  })
  server.on("upgrade", (request, socket: Socket) => {
    requests.push({ path: request.url!, headers: request.headers })
    if (!live || request.url !== `${PREVIEW_PREFIX}/ws`) return socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSet-Cookie: remote-ws=private-cookie-sentinel\r\n\r\n`)
    streams.add(socket)
    socket.on("error", () => {})
    const payload = Buffer.from(`private-${label}`)
    const timer = setInterval(() => socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload])), 20)
    socket.once("close", () => { clearInterval(timer); streams.delete(socket) })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(async () => { server.closeAllConnections(); for (const stream of streams) stream.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests }
}

/** Saved A/B destinations with the strict multi-backend flag, read by the production settings service. */
export function previewRemoteSettings(t: TestContext, remotes: { origin: string }[], logger: Logger, multiBackend = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-remote-client-previews-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const location = resolveConfigLocation(directory)
  fs.writeFileSync(location.configYamlPath, `ui:\n  settings:\n    multiBackend: ${multiBackend}\n`)
  fs.writeFileSync(location.stateYamlPath, JSON.stringify({ ui: { remoteServers: remotes.map((entry, index) =>
    ({ id: index ? "B" : "A", baseUrl: entry.origin, skipTlsVerify: false })), recentFolders: [] } }))
  return { settings: new SettingsService(location, undefined, logger), directory }
}
