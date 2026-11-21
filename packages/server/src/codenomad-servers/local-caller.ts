import type { FastifyReply, FastifyRequest } from "fastify"
import { isLocalRequest } from "../remote-control/request-origin"
import { isLoopbackHost } from "../server/network-host"

/** Same-origin SideCars share the local UI's authority. Opaque frames have none. */
export function guardLocalBackendCaller(request: FastifyRequest, reply: FastifyReply, origins: Set<string>): boolean {
  const localOrigin = (value: string) => {
    try { return origins.has(value) && /^https?:$/.test(new URL(value).protocol) && isLoopbackHost(new URL(value).hostname) }
    catch { return false }
  }
  const origin = request.headers.origin
  let admitted = typeof origin === "string" && localOrigin(origin)
  // Same-origin EventSource and media GETs send Referer and Fetch Metadata, without Origin.
  if (origin === undefined && ["GET", "HEAD"].includes(request.method) && request.headers["sec-fetch-site"] === "same-origin") {
    try { admitted = localOrigin(new URL(request.headers.referer ?? "").origin) } catch { /* Missing provenance. */ }
  }
  if (!isLocalRequest(request) || !admitted) {
    reply.header("connection", "close").code(403).send({ error: "auth" })
    return true
  }
  reply.header("Cache-Control", "no-store")
  return false
}
