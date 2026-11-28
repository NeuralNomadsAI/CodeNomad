import type { FastifyRequest } from "fastify"
import type { ServerMeta } from "../api-types"
import { isRemoteSocket } from "./request-origin"

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * Verified direct HTTPS origins: the only browser origins where the direct listener
 * pairs Remote Control devices and accepts their credentials.
 *
 * They are the `https:` origins the direct listener already trusts for mutations
 * (`direct-origin.ts`): this server's advertised HTTPS listener URLs and the explicit
 * `CODENOMAD_ALLOWED_ORIGINS` entries. Loopback and unspecified hosts never qualify.
 * The listener's own transport is irrelevant on purpose: behind a TLS-terminating
 * reverse proxy the request reaches a plain-HTTP socket, and the configured public
 * https origin is what the browser actually used. Browsers send the `Secure`,
 * host-only device cookie only over TLS to the host it was issued for.
 */
export function verifiedHttpsOrigins(meta: Pick<ServerMeta, "localUrl" | "remoteUrl" | "addresses">, allowedOrigins: readonly string[] = []): string[] {
  const origins = new Set<string>()
  for (const candidate of [meta.localUrl, meta.remoteUrl, ...(meta.addresses ?? []).map(address => address.remoteUrl), ...allowedOrigins]) {
    let url: URL
    try { url = new URL(candidate ?? "") } catch { continue }
    if (url.protocol === "https:" && !isLoopbackOrUnspecifiedHost(url.hostname)) origins.add(url.origin)
  }
  return [...origins]
}

/**
 * The verified direct HTTPS origin a direct-listener browser request comes from, or null.
 * Mutations need their own `Origin`. Reads use `Origin`, else the `Referer` origin, else
 * the targeted `Host` as https: same-origin navigations and fetches send neither header.
 * Opaque (`null`), `http:`, loopback and unlisted origins, and ingress sockets, give null.
 */
export function verifiedDirectHttpsOrigin(request: Pick<FastifyRequest, "raw" | "method" | "headers">, origins: readonly string[]): string | null {
  if (isRemoteSocket(request.raw.socket) || origins.length === 0) return null
  const { origin, referer, host } = request.headers
  let source: string | undefined
  if (origin !== undefined) source = origin
  else if (!SAFE_METHODS.has(request.method.toUpperCase())) return null
  else if (referer !== undefined) source = originOf(referer)
  // A Host header is a bare authority: anything URL parsing would drop fails closed.
  else source = httpsHostOrigin(host)
  return source !== undefined && origins.includes(source) ? source : null
}

export function verifiedDirectServerOrigin(request: Pick<FastifyRequest, "raw" | "headers">, origins: readonly string[]): string | undefined {
  if (isRemoteSocket(request.raw.socket)) return
  const origin = httpsHostOrigin(request.headers.host)
  return origin && origins.includes(origin) ? origin : undefined
}

/** HTML entry reads accept links from other sites, but an explicit Origin keeps precedence. */
export function verifiedDirectEntryOrigin(request: Pick<FastifyRequest, "raw" | "method" | "headers">, origins: readonly string[]): string | null {
  return request.headers.origin === undefined && (request.method === "GET" || request.method === "HEAD")
    ? verifiedDirectServerOrigin(request, origins) ?? null
    : verifiedDirectHttpsOrigin(request, origins)
}

function httpsHostOrigin(host: string | undefined): string | undefined {
  return host && !/[\s/\\@?#]/.test(host) ? originOf(`https://${host}`) : undefined
}

function originOf(value: string): string | undefined {
  try { return new URL(value).origin } catch { return undefined }
}

function isLoopbackOrUnspecifiedHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || /^0\./.test(host)
    || host === "[::1]" || host === "[::]" || /^\[::ffff:(?:7f|0:)/.test(host)
}
