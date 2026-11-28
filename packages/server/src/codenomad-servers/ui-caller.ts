import type { FastifyReply, FastifyRequest } from "fastify"
import { verifiedDirectHttpsOrigin } from "../remote-control/direct-https"
import { isLocalRequest, isRemoteSocket, remoteDeviceOf } from "../remote-control/request-origin"
import { isLoopbackHost, isWildcardHost } from "../server/network-host"
import { guardLocalBackendCaller } from "./local-caller"
import { isBackendUiRoute } from "../remote-control/gate"
import { routedPath } from "../server/routed-path"

export type BackendCallerGuard = (request: FastifyRequest, reply: FastifyReply) => boolean

export function createBackendUiAccess(deps: {
  enabled(): boolean
  selfOrigins(): Set<string>
  directHttpsOrigins(): readonly string[]
  publicHost(): string | null
  allowsDirectSource(request: FastifyRequest): boolean
}) {
  const channel = (request: FastifyRequest): "secure" | "http" | null => {
    // Explicit server traffic never borrows browser authority, even with browser headers.
    if (request.headers["x-codenomad-server-request"] !== undefined) return null
    const safe = ["GET", "HEAD"].includes(request.method)
    if (isRemoteSocket(request.raw.socket)) {
      const host = deps.publicHost()
      if (!host || request.headers.host !== host || !remoteDeviceOf(request)) return null
      const origin = request.headers.origin
      if (origin !== undefined) return origin === `https://${host}` ? "secure" : null
      if (!safe) return null
      if (request.headers.referer !== undefined) {
        try { if (new URL(request.headers.referer).origin !== `https://${host}`) return null } catch { return null }
      }
      return "secure"
    }
    if (verifiedDirectHttpsOrigin(request, deps.directHttpsOrigins())) return "secure"
    // Sensitive LAN reads require an explicit source, just like mutations.
    let source = request.headers.origin
    if (source === undefined && request.headers.referer !== undefined) {
      try { source = new URL(request.headers.referer).origin } catch { return null }
    }
    if (typeof source !== "string" || !deps.allowsDirectSource(request)) return null
    try {
      const url = new URL(source)
      return url.origin === source && url.protocol === "http:"
        && !isLoopbackHost(url.hostname) && !isWildcardHost(url.hostname) ? "http" : null
    } catch { return null }
  }
  const localUiRequest = (request: FastifyRequest) => {
    if (!isLocalRequest(request) || request.headers["x-codenomad-server-request"] !== undefined
      || verifiedDirectHttpsOrigin(request, deps.directHttpsOrigins())) return false
    const source = request.headers.origin ?? request.headers.referer
    if (source === undefined) {
      const host = request.headers.host
      if (host === undefined) return true
      if (/[\s/\\@?#]/.test(host)) return false
      try { return isLoopbackHost(new URL(`http://${host}`).hostname) } catch { return false }
    }
    try { return isLoopbackHost(new URL(source).hostname) } catch { return false }
  }
  const capabilities = (request: FastifyRequest) => {
    const local = localUiRequest(request)
    const transport = channel(request)
    const usable = local || deps.enabled() && transport !== null
    return { serversUsable: usable, serversManageable: usable, secretEntryAllowed: usable && (local || transport === "secure") }
  }
  const guard: BackendCallerGuard = (request, reply) => {
    // Preserve the local relay's stricter loopback provenance contract.
    if (localUiRequest(request)) {
      if (request.headers.origin === undefined && request.headers.referer === undefined
        && routedPath(request.raw.url ?? "") === "/api/remote-servers/probe") return false
      return guardLocalBackendCaller(request, reply, deps.selfOrigins())
    }
    const rawPath = (request.raw.url ?? "").split("?")[0]
    const path = routedPath(request.raw.url ?? "")
    if (!deps.enabled() || channel(request) === null || !path || path !== rawPath || !isBackendUiRoute(path, request.method)) {
      reply.header("connection", "close").code(403).send({ error: "auth" })
      return true
    }
    reply.header("Cache-Control", "no-store")
    return false
  }
  const guardSecret = (request: FastifyRequest, reply: FastifyReply, body: unknown) => {
    if (body !== null && typeof body === "object" && ("password" in body || "pairingLink" in body)
      && !capabilities(request).secretEntryAllowed) {
      reply.code(403).send({ error: "secret_entry_forbidden" })
      return true
    }
    return false
  }
  const guardProfiles: BackendCallerGuard = (request, reply) => {
    // Local preference writes retain the direct listener's existing source policy.
    if (localUiRequest(request)) return false
    return guard(request, reply)
  }
  return { guard, guardProfiles, guardSecret, capabilities, localUiRequest }
}
