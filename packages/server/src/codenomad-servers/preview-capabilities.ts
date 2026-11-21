import { randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { Readable } from "node:stream"
import { finished } from "node:stream/promises"
import { checkServerIdentity } from "node:tls"
import { z } from "zod"
import type { Logger } from "../logger"
import { resolveExplicitAddress } from "../opencode/servers/endpoint"
import { createExplicitTransport } from "../opencode/servers/transport"
import { routedPath } from "../server/routed-path"
import { proxyWebSocket } from "../server/proxy-websocket"
import { guardProxyListener } from "../server/proxy-destination"
import { PREVIEW_SANDBOX_FLAGS } from "../previews/sandbox"
import type { RemoteServerBrowseManager } from "./browse-manager"
import type { RemotePreviewCapability } from "../api-types"
import { isLoopbackHost } from "../server/network-host"
import { isRemoteSocket } from "../remote-control/request-origin"
import { PreviewBodyBudget, previewBodyKind, replacePreviewPrefix } from "./preview-body"

const Preview = z.object({
  token: z.string().uuid(), sessionId: z.string().min(1), targetUrl: z.string().url(),
  proxyUrl: z.string(), createdAt: z.string(),
})
type Owner = ReturnType<RemoteServerBrowseManager["previewOwner"]>
/** A remote client's capability: served on the host path proxy, bound to its issuing principal and channel. */
export type PreviewPrincipal = {
  key: string
  /** Aborts when the principal ends (logout, expiry, password change, device revocation, Stop, previews switch). */
  signal: AbortSignal
  /** Validate the issuing authority without refreshing session/device activity. */
  current(): boolean
  ingress: boolean
  /** The exact public Host that issued it; content arriving elsewhere is refused. */
  host: string
  release(): void
}
type Capability = { id: string; proof: string; preview: z.infer<typeof Preview>; owner: Owner; embeddingOrigin?: string; principal?: PreviewPrincipal; controller: AbortController; release(): void }
const PATH_CAPABILITY = /^\/previews\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=[/?]|$)/
const MAX_CAPABILITIES = 128
// Never forward Service-Worker-Allowed: content authority cannot become persistent origin authority.
const safeHeaders = ["content-type", "content-disposition", "cache-control", "etag", "last-modified", "content-range", "accept-ranges",
  "content-security-policy", "referrer-policy", "access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers"]

/** An isolated, content-only loopback listener. No UI routes, credentials or generic relay live here. */
export class RemotePreviewCapabilities {
  readonly #records = new Map<string, Capability>()
  readonly #rewrites = new PreviewBodyBudget()
  readonly #shutdown = new AbortController()
  #pending = 0
  readonly #server = createServer({ requestTimeout: 0, keepAliveTimeout: 72_000 }, (request, reply) => { void this.http(request, reply) })
  readonly #sockets = new Set<Socket>()
  #listening?: Promise<number>
  #closed = false

  constructor(private readonly manager: RemoteServerBrowseManager, private readonly logger: Logger) {
    guardProxyListener(this.#server)
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

  /**
   * Local UIs receive an exclusive `preview.localhost` origin. A remote client's
   * `principal` instead receives a host path capability (`/previews/<capability>/…`).
   */
  async create(id: string, proof: string, body: { sessionId: string; url: string }, signal?: AbortSignal, embeddingOrigin?: string, principal?: PreviewPrincipal): Promise<RemotePreviewCapability> {
    try {
      if (this.#closed || this.#records.size + this.#pending >= MAX_CAPABILITIES) throw new Error("Preview capacity reached")
      this.#pending++
      try { return await this.issue(id, proof, body, signal, embeddingOrigin, principal) }
      finally { this.#pending-- }
    }
    catch (error) { principal?.release(); throw error }
  }

  private async issue(id: string, proof: string, body: { sessionId: string; url: string }, signal?: AbortSignal, embeddingOrigin?: string, principal?: PreviewPrincipal): Promise<RemotePreviewCapability> {
    if (embeddingOrigin !== undefined && !principal) {
      const source = new URL(embeddingOrigin)
      if (!/^https?:$/.test(source.protocol) || source.origin !== embeddingOrigin || !isLoopbackHost(source.hostname)) throw new Error("Invalid embedding origin")
    }
    const owner = this.manager.previewOwner(id, proof)
    const port = principal ? 0 : await this.listen()
    if (this.#closed) throw new Error("Preview listener closed")
    owner.current()
    if (principal && !principal.current()) throw new Error("Invalid principal")
    const lifetime = AbortSignal.any([owner.signal, this.#shutdown.signal, ...(signal ? [signal] : []), ...(principal ? [principal.signal] : []), AbortSignal.timeout(10_000)])
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
      if (principal && !principal.current()) throw new Error("Invalid principal")
      lifetime.throwIfAborted()
      if (this.#closed) throw new Error("Preview listener closed")
      const capability = randomUUID()
      const controller = new AbortController()
      const revoke = () => this.revoke(capability)
      owner.signal.addEventListener("abort", revoke, { once: true })
      principal?.signal.addEventListener("abort", revoke, { once: true })
      this.#records.set(capability, { id, proof, preview, owner, embeddingOrigin: principal ? undefined : embeddingOrigin, principal, controller,
        release: () => {
          owner.signal.removeEventListener("abort", revoke)
          principal?.signal.removeEventListener("abort", revoke)
          principal?.release()
        } })
      return { ...preview, capability, contentUrl: principal
        ? `/previews/${capability}${preview.proxyUrl.slice(prefix.length)}`
        : `http://${capability}.preview.localhost:${port}${preview.proxyUrl}` }
    } catch (error) {
      this.deleteRemote(id, proof, preview.token)
      throw error
    }
  }

  private deleteRemote(id: string, proof: string, token: string) {
    void this.manager.relay(id, `/api/previews/${token}`, { method: "DELETE" }, proof)
      .then(response => response.body?.cancel()).catch(() => {})
  }

  /** Callers name the principal that issued it: `undefined` for the local UI. */
  revoke(capability: string, id?: string, proof?: string, principal?: string): boolean {
    const record = this.#records.get(capability)
    if (!record || id !== undefined && (record.id !== id || record.proof !== proof || record.principal?.key !== principal)) return false
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

  /** A live remote-client capability served on the host path proxy. */
  servesPath(capability: string): boolean {
    const record = this.#records.get(capability)
    return Boolean(record?.principal?.current() && !record.controller.signal.aborted)
  }

  /** The host path proxy's remote adapter; false when no remote-client capability owns the target. */
  servePath(request: IncomingMessage, reply: ServerResponse): boolean {
    if (!this.ownsPath(request)) return false
    void this.http(request, reply, true)
    return true
  }

  upgradePath(request: IncomingMessage, socket: Socket, head: Buffer): boolean {
    if (!this.ownsPath(request)) return false
    void this.upgrade(request, socket, head, true)
    return true
  }

  private ownsPath(request: IncomingMessage) {
    const capability = routedPath(request.url ?? "/")?.match(PATH_CAPABILITY)?.[1]
    return capability !== undefined && this.#records.get(capability)?.principal !== undefined
  }

  private capture(request: IncomingMessage, hostPath = false) {
    if (request.headers["service-worker"] !== undefined) throw new Error("Service workers are unavailable")
    if (this.#closed) throw new Error("Invalid capability")
    const raw = request.url ?? "/"
    const pathname = routedPath(raw)
    const parsed = new URL(raw, "http://preview.invalid")
    if (!pathname || pathname !== routedPath(parsed.pathname)) throw new Error("Invalid target")
    let record: Capability | undefined
    let path: string
    let origin: string
    let publicPrefix: string | undefined
    if (hostPath) {
      // Content is cookie-free: the capability, its live principal and its exact channel admit it.
      const match = raw.match(PATH_CAPABILITY)
      record = match ? this.#records.get(match[1]!) : undefined
      const principal = record?.principal
      if (!match || !record || !principal || pathname.match(PATH_CAPABILITY)?.[0] !== match[0]
        || isRemoteSocket(request.socket) !== principal.ingress || request.headers.host !== principal.host) throw new Error("Invalid capability")
      if (!principal.current()) throw new Error("Invalid principal")
      publicPrefix = match[0]
      path = `/previews/${record.preview.token}${raw.slice(match[0].length)}`
      origin = "null"
    } else {
      const port = (this.#server.address() as { port: number } | null)?.port
      const capability = request.headers.host?.match(/^([0-9a-f-]{36})\.preview\.localhost:(\d+)$/)?.[1]
      record = capability ? this.#records.get(capability) : undefined
      if (!record || record.principal || request.headers.host !== `${capability}.preview.localhost:${port}`) throw new Error("Invalid capability")
      const prefix = `/previews/${record.preview.token}`
      path = pathname === prefix || pathname.startsWith(`${prefix}/`) ? raw : `${prefix}${raw}`
      origin = `http://${request.headers.host}`
    }
    record.owner.current()
    record.controller.signal.throwIfAborted()
    const source = request.headers.origin
    if (source !== undefined && source !== origin) throw new Error("Foreign origin")
    return { record, path, origin, publicPrefix }
  }

  private async http(request: IncomingMessage, reply: ServerResponse, hostPath = false) {
    // Path documents are opaque, so same-origin CORP would block their own no-CORS resources.
    if (!hostPath) reply.setHeader("cross-origin-resource-policy", "same-origin")
    const disconnect = new AbortController()
    const abort = () => disconnect.abort()
    request.once("aborted", abort)
    reply.once("close", abort)
    let body: Response["body"] = null
    try {
      const { record, path, origin, publicPrefix } = this.capture(request, hostPath)
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
        if (/^(?:cookie|authorization|proxy-authorization|referer|sec-.*|x-codenomad-.*|x-opencode-.*|content-length|accept-encoding|expect)$/i.test(name)) continue
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value)
      }
      headers.set("accept-encoding", "identity")
      const response = await transport.fetch(new URL(path, record.owner.origin), {
        method: request.method, headers,
        body: ["GET", "HEAD"].includes(request.method ?? "GET") ? undefined : Readable.toWeb(request) as never,
        duplex: "half", signal,
      } as RequestInit)
      body = response.body
      record.owner.current()
      if (record.principal && !record.principal.current()) throw new Error("Invalid principal")
      signal.throwIfAborted()
      const type = response.headers.get("content-type") ?? ""
      const rewrittenType = Boolean(publicPrefix && previewBodyKind(type))
      if (rewrittenType && (response.status === 206 || response.headers.has("content-range"))) throw new Error("Partial preview document")
      reply.statusCode = response.status
      for (const name of safeHeaders) {
        if (rewrittenType && /^(etag|last-modified|content-range|accept-ranges)$/.test(name)) continue
        const value = response.headers.get(name)
        if (value) reply.setHeader(name, value)
      }
      const location = response.headers.get("location")
      if (location) {
        const target = new URL(location, new URL(path, record.owner.origin))
        const prefix = `/previews/${record.preview.token}`
        if (target.origin !== record.owner.origin || !(target.pathname === prefix || target.pathname.startsWith(`${prefix}/`))) {
          throw new Error("Invalid redirect")
        }
        reply.setHeader("location", `${publicPrefix ?? prefix}${target.pathname.slice(prefix.length)}${target.search}${target.hash}`)
      }
      reply.setHeader("cache-control", "no-store")
      reply.setHeader("x-content-type-options", "nosniff")
      // Isolated documents keep their own content origin, embeddable only by the issuing UI.
      // Host path documents share the public hostname, so they stay opaque however they are opened.
      reply.setHeader("content-security-policy", publicPrefix
        ? `sandbox ${PREVIEW_SANDBOX_FLAGS}; frame-ancestors 'self'`
        : `sandbox ${PREVIEW_SANDBOX_FLAGS} allow-same-origin; frame-ancestors 'self'${record.embeddingOrigin ? ` ${record.embeddingOrigin}` : ""}`)
      reply.setHeader("referrer-policy", publicPrefix ? "no-referrer" : "same-origin")
      reply.setHeader("access-control-allow-origin", origin)
      reply.setHeader("vary", "Origin")
      const revoke = () => reply.destroy()
      signal.addEventListener("abort", revoke, { once: true })
      reply.once("close", () => signal.removeEventListener("abort", revoke))
      if (publicPrefix && rewrittenType && body && request.method !== "HEAD") {
        // The remote proxy rewrites resources, redirects and its runtime bridge to its own
        // prefix; publish them under this host capability's prefix instead.
        const remotePrefix = `/previews/${record.preview.token}`
        await this.#rewrites.run(body, signal, async (bytes, deadline) => {
          record.owner.current()
          if (record.principal && !record.principal.current()) throw new Error("Invalid principal")
          const rewritten = replacePreviewPrefix(bytes, remotePrefix, publicPrefix, type)
          deadline.throwIfAborted()
          reply.setHeader("content-length", rewritten.length)
          const stop = () => reply.destroy()
          deadline.addEventListener("abort", stop, { once: true })
          try {
            const sent = finished(reply, { cleanup: true })
            reply.end(rewritten)
            await sent
          } finally { deadline.removeEventListener("abort", stop) }
        })
      } else if (body && request.method !== "HEAD") {
        const stream = Readable.fromWeb(body as never)
        body = null // The client response now owns cancellation.
        stream.on("error", () => reply.destroy())
        reply.once("close", () => stream.destroy())
        stream.pipe(reply)
      } else reply.end()
    } catch {
      if (reply.headersSent) reply.destroy()
      else {
        for (const name of reply.getHeaderNames()) reply.removeHeader(name)
        const capability = !hostPath && request.headers.host?.match(/^([0-9a-f-]{36})\.preview\.localhost:\d+$/)?.[1]
        if (capability && !this.#records.has(capability)) reply.setHeader("clear-site-data", '"storage"')
        reply.writeHead(404, { connection: "close", "content-length": "0" }); reply.end()
      }
    } finally {
      request.off("aborted", abort)
      if (body && !body.locked) void body.cancel().catch(() => {})
    }
  }

  private async upgrade(request: IncomingMessage, socket: Socket, head: Buffer, hostPath = false) {
    try {
      const { record, path, origin } = this.capture(request, hostPath)
      if (request.headers.origin !== origin || request.headers.upgrade?.toLowerCase() !== "websocket") throw new Error("Invalid upgrade")
      const signal = AbortSignal.any([record.controller.signal, record.owner.signal, AbortSignal.timeout(15_000)])
      const abort = () => socket.destroy()
      signal.addEventListener("abort", abort, { once: true })
      socket.once("close", () => signal.removeEventListener("abort", abort))
      const address = await (record.owner.dial?.() ?? resolveExplicitAddress(record.owner.origin))
      signal.removeEventListener("abort", abort)
      signal.throwIfAborted()
      record.owner.current()
      if (record.principal && !record.principal.current()) throw new Error("Invalid principal")
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
    this.#shutdown.abort()
    for (const capability of this.#records.keys()) this.revoke(capability)
    for (const socket of this.#sockets) socket.destroy()
    if (this.#listening) {
      await this.#listening.catch(() => {})
      await new Promise<void>(resolve => this.#server.close(() => resolve()))
    }
  }
}
