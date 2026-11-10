import type { FastifyInstance, FastifyRequest } from "fastify"
import cors from "@fastify/cors"
import type { ServerMeta } from "../api-types"
import { isLocalRequest, isRemoteRequest } from "../remote-control/request-origin"

type OriginRequest = Pick<FastifyRequest, "raw" | "headers">

/** Explicit origins only: credentials, paths, wildcards and opaque origins fail startup. */
export function parseAllowedOrigins(value = ""): string[] {
  return value.split(",").map(value => value.trim()).filter(Boolean).map(value => {
    const url = new URL(value)
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.origin !== value || value.includes("*")) {
      throw new Error("CODENOMAD_ALLOWED_ORIGINS must contain comma-separated HTTP(S) origins")
    }
    return url.origin
  })
}

export function registerDirectOriginPolicy(app: FastifyInstance, options: {
  meta: ServerMeta
  allowedOrigins?: string[]
  devServerUrl?: string
  publicHost(): string | null
  isPreview(request: FastifyRequest): boolean
}) {
  const allows = (request: OriginRequest, origin: string): boolean => {
    if (isRemoteRequest(request)) return origin === `https://${options.publicHost()}`
    const candidates = [options.meta.localUrl, options.meta.remoteUrl,
      ...(options.meta.addresses ?? []).map(address => address.remoteUrl), ...(options.allowedOrigins ?? [])]
    // The listening socket supplies its own port even before startup metadata is published.
    const address = app.server.address()
    if (address && typeof address === "object") {
      const host = address.address.includes(":") ? `[${address.address}]` : address.address
      const protocol = request.raw.socket && "encrypted" in request.raw.socket ? "https" : "http"
      candidates.push(`${protocol}://${host}:${address.port}`)
      if (isLocalRequest(request) && (address.address === "127.0.0.1" || address.address === "::1")) {
        candidates.push(`${protocol}://localhost:${address.port}`)
      }
    }
    if (isLocalRequest(request) && options.devServerUrl) candidates.push(options.devServerUrl)
    return candidates.some(candidate => {
      try { return candidate !== undefined && new URL(candidate).origin === origin } catch { return false }
    })
  }

  const allowsSource = (request: OriginRequest): boolean => {
    const origin = request.headers.origin
    let source = origin
    if (source === undefined && request.headers.referer !== undefined) {
      try { source = new URL(request.headers.referer).origin } catch { source = "null" }
    }
    // Desktop hosts and bundled native plugins make origin-less loopback calls.
    return source === undefined ? isLocalRequest(request) : allows(request, source)
  }

  app.addHook("onRequest", (request, reply, done) => {
    if (isRemoteRequest(request) || ["GET", "HEAD", "OPTIONS"].includes(request.method) || options.isPreview(request)) return done()
    if (allowsSource(request)) return done()
    reply.header("connection", "close").code(403).send({ error: "Cross-origin request rejected" })
  })

  app.register(cors, () => (request: FastifyRequest, cb: (error: Error | null, options: object) => void) => {
    const origin = request.headers.origin
    cb(null, { credentials: true, methods: "GET,HEAD,PUT,PATCH,POST,DELETE", origin: origin !== undefined && (allows(request, origin)
      || (origin === "null" && options.isPreview(request))) })
  })
  return allowsSource
}
