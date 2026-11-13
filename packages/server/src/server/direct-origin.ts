import type { FastifyInstance, FastifyRequest } from "fastify"
import cors from "@fastify/cors"
import type { ServerMeta } from "../api-types"
import { isLocalRequest, isRemoteRequest } from "../remote-control/request-origin"

type OriginRequest = Pick<FastifyRequest, "raw" | "headers">
/** Loopback names that reach a socket bound to each address. */
const LOOPBACK_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "127.0.0.1": ["localhost"],
  "0.0.0.0": ["127.0.0.1", "localhost"],
  "::1": ["localhost"],
  "::": ["[::1]", "127.0.0.1", "localhost"],
}

/**
 * Loopback aliases of a listening socket admitted for one request: only the alias the request
 * itself targets (same-origin), compared as normalized origins so default ports match.
 */
export function sameOriginLoopbackAliases(socket: { address: string; port: number }, protocol: "http" | "https", host: string | undefined): string[] {
  // A Host header is a bare authority: anything URL parsing would drop (path, userinfo, query) fails closed.
  if (!host || /[\s/\\@?#]/.test(host)) return []
  let target: string
  try { target = new URL(`${protocol}://${host}`).origin } catch { return [] }
  return (LOOPBACK_ALIASES[socket.address] ?? []).flatMap(name => {
    const alias = new URL(`${protocol}://${name}:${socket.port}`).origin
    return alias === target ? [alias] : []
  })
}

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
      // A page on this machine reaches this socket under the loopback names its bind
      // address covers, including all interfaces. Other loopback addresses and ports, or
      // the same name resolved to a sibling listener, can belong to other servers: an alias
      // is admitted only for a request that targets that very alias (same-origin).
      if (isLocalRequest(request)) candidates.push(...sameOriginLoopbackAliases(address, protocol, request.headers.host))
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
