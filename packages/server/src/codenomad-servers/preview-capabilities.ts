import { randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { Readable } from "node:stream"
import { checkServerIdentity } from "node:tls"
import { z } from "zod"
import type { Logger } from "../logger"
import { resolveExplicitAddress } from "../opencode/servers/endpoint"
import { createExplicitTransport } from "../opencode/servers/transport"
import { routedPath } from "../server/routed-path"
import { proxyWebSocket } from "../server/proxy-websocket"
import { PREVIEW_SANDBOX_FLAGS } from "../previews/sandbox"
import type { RemoteServerBrowseManager } from "./browse-manager"
import type { RemotePreviewCapability } from "../api-types"
import { isLoopbackHost } from "../server/network-host"

const Preview = z.object({
  token: z.string().uuid(), sessionId: z.string().min(1), targetUrl: z.string().url(),
  proxyUrl: z.string(), createdAt: z.string(),
})
type Owner = ReturnType<RemoteServerBrowseManager["previewOwner"]>
type Capability = { id: string; proof: string; preview: z.infer<typeof Preview>; owner: Owner; embeddingOrigin?: string; controller: AbortController; release(): void }
// Never forward Service-Worker-Allowed: content authority cannot become persistent origin authority.
const safeHeaders = ["content-type", "content-disposition", "cache-control", "etag", "last-modified", "content-range", "accept-ranges",
  "content-security-policy", "referrer-policy", "access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers"]

/** An isolated, content-only loopback listener. No UI routes, credentials or generic relay live here. */
export class RemotePreviewCapabilities {
  readonly #records = new Map<string, Capability>()
  readonly #server = createServer({ requestTimeout: 0, keepAliveTimeout: 72_000 }, (request, reply) => { void this.http(request, reply) })
  readonly #sockets = new Set<Socket>()
  #listening?: Promise<number>
  #closed = false

  constructor(private readonly manager: RemoteServerBrowseManager, private readonly logger: Logger) {
    this.#server.on("connection", socket => {
      this.#sockets.add(socket)
      socket.once("close", () => this.#sockets.delete(socket))
    })
    this.#server.on("upgrade", (request, socket: Socket, head) => { void this.upgrade(request, socket, head) })
  }

  private listen() {
    if (this.#closed) throw new Error("Preview listener closed")
    return this.#listening ??= new Promise<number>((resolve, reject) => {
      this.#server.once("error", reject)
      this.#server.listen(0, "127.0.0.1", () => {
        this.#server.off("error", reject)
        resolve((this.#server.address() as { port: number }).port)
      })
    })
  }

  async create(id: string, proof: string, body: { sessionId: string; url: string }, signal?: AbortSignal, embeddingOrigin?: string): Promise<RemotePreviewCapability> {
    if (embeddingOrigin !== undefined) {
      const source = new URL(embeddingOrigin)
      if (!/^https?:$/.test(source.protocol) || source.origin !== embeddingOrigin || !isLoopbackHost(source.hostname)) throw new Error("Invalid embedding origin")
    }
    const owner = this.manager.previewOwner(id, proof)
    const port = await this.listen()
    if (this.#closed) throw new Error("Preview listener closed")
    owner.current()
    const lifetime = AbortSignal.any([owner.signal, ...(signal ? [signal] : []), AbortSignal.timeout(10_000)])
    const response = await this.manager.relay(id, "/api/previews", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: lifetime,
    }, proof)
    // This fixed response is tiny; bound it before parsing untrusted remote JSON.
    const chunks: Uint8Array[] = []
    let bytes = 0
    const reader = response.body?.getReader()
    try {
      if (!response.ok || !reader) throw new Error("Preview creation failed")
      while (true) {
        const chunk = await reader.read()
        lifetime.throwIfAborted()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > 16_384) throw new Error("Preview response too large")
        chunks.push(chunk.value)
      }
    } finally { await reader?.cancel().catch(() => {}) }
    const preview = Preview.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")))
    try {
      const target = new URL(preview.targetUrl)
      const prefix = `/previews/${preview.token}`
      if (!/^https?:$/.test(target.protocol) || target.username || target.password
        || preview.sessionId !== body.sessionId || !preview.proxyUrl.startsWith(`${prefix}/`)) throw new Error("Invalid preview")
      owner.current()
      lifetime.throwIfAborted()
      if (this.#closed) throw new Error("Preview listener closed")
      const capability = randomUUID()
      const controller = new AbortController()
      const revoke = () => this.revoke(capability)
      owner.signal.addEventListener("abort", revoke, { once: true })
      this.#records.set(capability, { id, proof, preview, owner, embeddingOrigin, controller,
        release: () => owner.signal.removeEventListener("abort", revoke) })
      return { ...preview, capability, contentUrl: `http://${capability}.preview.localhost:${port}${preview.proxyUrl}` }
    } catch (error) {
      this.deleteRemote(id, proof, preview.token)
      throw error
    }
  }

  private deleteRemote(id: string, proof: string, token: string) {
    void this.manager.relay(id, `/api/previews/${token}`, { method: "DELETE" }, proof)
      .then(response => response.body?.cancel()).catch(() => {})
  }

  revoke(capability: string, id?: string, proof?: string): boolean {
    const record = this.#records.get(capability)
    if (!record || id !== undefined && (record.id !== id || record.proof !== proof)) return false
    this.#records.delete(capability)
    record.release()
    record.controller.abort()
    // Cleanup retains the original generation; refusal never acquires a replacement.
    this.deleteRemote(record.id, record.proof, record.preview.token)
    return true
  }

  detach(id: string, proof: string) {
    this.manager.detachPreviews(id, proof)
  }

  private capture(request: IncomingMessage) {
    if (request.headers["service-worker"] !== undefined) throw new Error("Service workers are unavailable")
    const port = (this.#server.address() as { port: number } | null)?.port
    const capability = request.headers.host?.match(/^([0-9a-f-]{36})\.preview\.localhost:(\d+)$/)?.[1]
    const record = capability && this.#records.get(capability)
    if (!record || request.headers.host !== `${capability}.preview.localhost:${port}` || this.#closed) throw new Error("Invalid capability")
    record.owner.current()
    record.controller.signal.throwIfAborted()
    const raw = request.url ?? "/"
    const pathname = routedPath(raw)
    const parsed = new URL(raw, "http://preview.invalid")
    if (!pathname || pathname !== routedPath(parsed.pathname)) throw new Error("Invalid target")
    const prefix = `/previews/${record.preview.token}`
    const path = pathname === prefix || pathname.startsWith(`${prefix}/`) ? raw : `${prefix}${raw}`
    const source = request.headers.origin
    const origin = `http://${request.headers.host}`
    if (source !== undefined && source !== origin) throw new Error("Foreign origin")
    return { record, path, origin }
  }

  private async http(request: IncomingMessage, reply: ServerResponse) {
    reply.setHeader("cross-origin-resource-policy", "same-origin")
    const disconnect = new AbortController()
    const abort = () => disconnect.abort()
    request.once("aborted", abort)
    reply.once("close", abort)
    try {
      const { record, path, origin } = this.capture(request)
      const signal = AbortSignal.any([record.controller.signal, record.owner.signal, disconnect.signal])
      const requestedMethod = request.headers["access-control-request-method"]
      if (request.method === "OPTIONS" && typeof requestedMethod === "string") {
        if (request.headers.origin !== origin || !/^[A-Z]{1,20}$/.test(requestedMethod)) throw new Error("Invalid preflight")
        reply.writeHead(204, {
          "access-control-allow-origin": origin, "access-control-allow-methods": requestedMethod,
          "access-control-allow-headers": request.headers["access-control-request-headers"] ?? "",
          "cache-control": "no-store",
        })
        reply.end()
        return
      }
      const transport = createExplicitTransport({ ...record.owner, signal, omitFetchMetadata: true, previewRedirects: true })
      const headers = new Headers()
      for (const [name, value] of Object.entries(request.headers)) {
        // The shared transport removes credentials and hop-by-hop fields. Keep local
        // capabilities, browser provenance and backend protocol markers out as well.
        if (/^(?:referer|sec-.*|x-codenomad-.*|x-opencode-.*|content-length|accept-encoding|expect)$/i.test(name)) continue
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value)
      }
      const response = await transport.fetch(new URL(path, record.owner.origin), {
        method: request.method, headers,
        body: ["GET", "HEAD"].includes(request.method ?? "GET") ? undefined : Readable.toWeb(request) as never,
        duplex: "half", signal,
      } as RequestInit)
      record.owner.current()
      signal.throwIfAborted()
      reply.statusCode = response.status
      for (const name of safeHeaders) {
        const value = response.headers.get(name)
        if (value) reply.setHeader(name, value)
      }
      const location = response.headers.get("location")
      if (location) {
        const target = new URL(location, new URL(path, record.owner.origin))
        const prefix = `/previews/${record.preview.token}`
        if (target.origin !== record.owner.origin || !(target.pathname === prefix || target.pathname.startsWith(`${prefix}/`))) {
          await response.body?.cancel()
          throw new Error("Invalid redirect")
        }
        reply.setHeader("location", `${target.pathname}${target.search}${target.hash}`)
      }
      reply.setHeader("cache-control", "no-store")
      reply.setHeader("x-content-type-options", "nosniff")
      // Each document keeps its own content origin. Only the issuing UI can embed it.
      reply.setHeader("content-security-policy", `sandbox ${PREVIEW_SANDBOX_FLAGS} allow-same-origin; frame-ancestors 'self'${record.embeddingOrigin ? ` ${record.embeddingOrigin}` : ""}`)
      reply.setHeader("referrer-policy", "same-origin")
      reply.setHeader("access-control-allow-origin", origin)
      reply.setHeader("vary", "Origin")
      const revoke = () => reply.destroy()
      signal.addEventListener("abort", revoke, { once: true })
      reply.once("close", () => signal.removeEventListener("abort", revoke))
      if (response.body) {
        const stream = Readable.fromWeb(response.body as never)
        stream.on("error", () => reply.destroy())
        reply.once("close", () => stream.destroy())
        stream.pipe(reply)
      } else reply.end()
    } catch {
      if (reply.headersSent) reply.destroy()
      else {
        const capability = request.headers.host?.match(/^([0-9a-f-]{36})\.preview\.localhost:\d+$/)?.[1]
        if (capability && !this.#records.has(capability)) reply.setHeader("clear-site-data", '"storage"')
        reply.writeHead(404, { connection: "close", "content-length": "0" }); reply.end()
      }
    } finally {
      request.off("aborted", abort)
      // Keep close cancellation through streaming; the response owns its listener.
    }
  }

  private async upgrade(request: IncomingMessage, socket: Socket, head: Buffer) {
    try {
      const { record, path, origin } = this.capture(request)
      if (request.headers.origin !== origin || request.headers.upgrade?.toLowerCase() !== "websocket") throw new Error("Invalid upgrade")
      const signal = AbortSignal.any([record.controller.signal, record.owner.signal, AbortSignal.timeout(15_000)])
      const abort = () => socket.destroy()
      signal.addEventListener("abort", abort, { once: true })
      socket.once("close", () => signal.removeEventListener("abort", abort))
      const address = await (record.owner.dial?.() ?? resolveExplicitAddress(record.owner.origin))
      signal.removeEventListener("abort", abort)
      signal.throwIfAborted()
      record.owner.current()
      if (socket.destroyed) return
      const targetUrl = new URL(path, record.owner.origin)
      const headers: Record<string, string> = { host: targetUrl.host, connection: "Upgrade", upgrade: "websocket" }
      for (const name of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"]) {
        const value = request.headers[name]
        if (typeof value === "string") headers[name] = value
      }
      proxyWebSocket({ request, socket, head, targetUrl, headers, logger: this.logger, logContext: { backendId: record.id },
        signal: AbortSignal.any([record.controller.signal, record.owner.signal]),
        connection: {
          hostname: address.address, port: "port" in address ? address.port as number : targetUrl.port || undefined,
          servername: targetUrl.hostname.replace(/^\[|\]$/g, ""), rejectUnauthorized: !record.owner.skipTlsVerify,
          checkServerIdentity: (_hostname, cert) => checkServerIdentity(targetUrl.hostname.replace(/^\[|\]$/g, ""), cert),
        },
        responseHeaders: incoming => Object.fromEntries(Object.entries(incoming)
          .filter(([name]) => /^(upgrade|connection|sec-websocket-accept|sec-websocket-protocol|sec-websocket-extensions)$/i.test(name))),
      })
    } catch { socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n") }
  }

  async close() {
    if (this.#closed) return
    this.#closed = true
    for (const capability of this.#records.keys()) this.revoke(capability)
    for (const socket of this.#sockets) socket.destroy()
    if (this.#listening) {
      await this.#listening.catch(() => {})
      await new Promise<void>(resolve => this.#server.close(() => resolve()))
    }
  }
}
