import type { FastifyRequest } from "fastify"
import type { ServerMeta } from "../api-types"
import { verifiedDirectHttpsOrigin, verifiedHttpsOrigins } from "../remote-control/direct-https"
import type { SettingsService } from "../settings/service"

/** Host setting (`config.yaml` server owner) that opens SideCars to verified direct HTTPS origins. Off unless `true`. */
export const SIDECARS_OVER_DIRECT_HTTPS = "sidecarsOverDirectHttps"

type AccessRequest = Pick<FastifyRequest, "raw" | "method" | "headers">

/** Whether the host opted in; an unreadable configuration keeps SideCars host-only. */
export function sidecarsOverDirectHttpsEnabled(settings: Pick<SettingsService, "getOwner">): boolean {
  try {
    return settings.getOwner("config", "server")?.[SIDECARS_OVER_DIRECT_HTTPS] === true
  } catch {
    return false
  }
}

/**
 * The host's opt-in exception to host-only SideCar content and WebSockets: a direct-listener
 * request whose origin is a verified direct HTTPS origin (`remote-control/direct-https.ts`).
 * Remote Control ingress, plain-HTTP and loopback-alias origins never qualify. Callers keep
 * authentication, the direct source policy and every other host-only path unchanged.
 */
export function createSideCarDirectHttpsAccess(deps: {
  meta: Pick<ServerMeta, "localUrl" | "remoteUrl" | "addresses">
  allowedOrigins?: readonly string[]
  enabled: () => boolean
}): (request: AccessRequest) => boolean {
  return request => verifiedDirectHttpsOrigin(request, verifiedHttpsOrigins(deps.meta, deps.allowedOrigins)) !== null && deps.enabled()
}

/** SideCar content paths, as routed; the bare `/sidecars` path stays host-only. */
export function isSideCarContentPath(pathname: string): boolean {
  return pathname.startsWith("/sidecars/")
}
