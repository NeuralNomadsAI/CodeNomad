import { Readable } from "node:stream"
import type { FastifyInstance } from "fastify"
import { ConnectBody, type RemoteServerBrowseManager } from "../../codenomad-servers/browse-manager"
import { endpointErrorCode } from "../../codenomad-servers/client"
import { guardLocalBackendCaller } from "../../codenomad-servers/local-caller"
import { isHostOnlyPath } from "../../remote-control/gate"
import { routedPath } from "../routed-path"

const profileId = /^[A-Za-z0-9_-]{1,64}$/
const responseHeaders = new Set(["content-type", "content-length", "content-disposition", "content-range", "accept-ranges", "etag", "last-modified", "retry-after"])

/** Raw bodies and response streams retain the request and saved client's cancellation. */
export function registerBackendRelayRoutes(app: FastifyInstance, deps: { manager: RemoteServerBrowseManager; getSelfOrigins(): Set<string> }) {
  void app.register(async scope => {
    scope.addHook("onRequest", async (request, reply) => { guardLocalBackendCaller(request, reply, deps.getSelfOrigins()) })
    scope.post<{ Params: { id: string } }>("/api/backends/:id/api/auth/login", { bodyLimit: 24 * 1024 }, async (request, reply) => {
      if (!profileId.test(request.params.id)) return reply.code(404).send({ error: "unknown_server" })
      const controller = new AbortController()
      const abort = () => controller.abort()
      reply.raw.once("close", abort)
      try { return await deps.manager.connect(request.params.id, ConnectBody.parse(request.body ?? {}), controller.signal) }
      catch { return reply.code(401).send({ error: "auth" }) }
      finally { reply.raw.off("close", abort) }
    })
    scope.post<{ Params: { id: string } }>("/api/backends/:id/api/auth/logout", async (request, reply) => {
      if (!profileId.test(request.params.id)) return reply.code(404).send({ error: "unknown_server" })
      return deps.manager.forget(request.params.id)
    })
    void scope.register(async streamScope => {
      streamScope.removeAllContentTypeParsers()
      streamScope.addContentTypeParser("*", (_request, payload, done) => done(null, payload))
      streamScope.all<{ Params: { id: string; "*": string } }>("/api/backends/:id/*", async (request, reply) => {
        const id = request.params.id
        if (!profileId.test(id)) return reply.code(404).send({ error: "unknown_server" })
        const raw = request.raw.url ?? ""
        const prefix = `/api/backends/${id}`
        if (!raw.startsWith(`${prefix}/`)) return reply.code(400).send({ error: "unreachable" })
        const target = raw.slice(prefix.length)
        const pathname = routedPath(target)
        let normalized: string | null = null
        try { normalized = routedPath(new URL(target, "http://relay.invalid").pathname) } catch { /* Refuse malformed targets. */ }
        if (!pathname || pathname !== normalized || (!pathname.startsWith("/api/") && !pathname.startsWith("/workspaces/"))
          || isHostOnlyPath(pathname, request.method) || pathname.startsWith("/api/backends/") || pathname === "/api/backends"
          || pathname === "/api/remote-control/status"
          || (pathname.startsWith("/api/auth/") && pathname !== "/api/auth/status")) {
          return reply.code(404).send({ error: "unreachable" })
        }
        const controller = new AbortController()
        const abort = () => controller.abort()
        request.raw.once("aborted", abort)
        reply.raw.once("close", abort)
        const cleanup = () => { request.raw.off("aborted", abort); reply.raw.off("close", abort) }
        reply.raw.once("finish", cleanup)
        reply.raw.once("close", cleanup)
        try {
          const headers = new Headers()
          for (const name of ["content-type", "accept", "accept-language", "if-none-match", "if-modified-since", "range", "last-event-id",
            "x-codenomad-media", "x-codenomad-location", "x-codenomad-pending-reconciliation", "x-codenomad-human-answer", "x-opencode-directory", "x-opencode-workspace"]) {
            const value = request.headers[name]
            if (typeof value === "string") headers.set(name, value)
          }
          const body = ["GET", "HEAD"].includes(request.method) ? undefined : Readable.toWeb(request.raw) as ReadableStream<Uint8Array>
          const response = await deps.manager.relay(id, target, { method: request.method, headers, body, signal: controller.signal, duplex: "half" } as RequestInit)
          controller.signal.throwIfAborted()
          reply.code(response.status)
          for (const [name, value] of response.headers) if (responseHeaders.has(name)) reply.header(name, value)
          reply.header("Cache-Control", "no-store").header("Content-Security-Policy", "sandbox").header("X-Content-Type-Options", "nosniff")
          return reply.send(response.body ? Readable.fromWeb(response.body as never) : null)
        } catch (error) {
          const code = endpointErrorCode(error)
          if (pathname === "/api/auth/status" && ["auth", "needs_credentials"].includes(code)) return reply.code(200).send({ authenticated: false })
          return reply.code(code === "unknown_server" ? 404 : ["auth", "needs_credentials"].includes(code) ? 401 : 502).send({ error: code })
        }
      })
    })
  })
}
