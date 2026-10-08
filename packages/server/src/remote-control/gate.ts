import type { Socket } from "node:net"
import type { FastifyReply, FastifyRequest } from "fastify"
import { parseCookies, wantsHtml } from "../auth/http-auth"
import type { RemoteControlDevice } from "../api-types"
import { attachRemoteDevice, isRemoteRequest } from "./request-origin"

export const DEVICE_COOKIE_NAME = "__Host-codenomad_device"
export const PAIR_PAGE_PATH = "/remote-pair"
export const PAIR_EXCHANGE_PATH = "/api/remote-control/pair"
// Browsers cap cookie lifetime at 400 days; the host registry decides expiry.
const DEVICE_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60

// Reachable remotely without a paired device.
const PUBLIC_PATHS = new Set([PAIR_PAGE_PATH, PAIR_EXCHANGE_PATH, "/api/auth/status"])
// Host-only surfaces: local login/bootstrap, Remote Control management, desktop
// windows, local tools and the automation bridge. Never reachable remotely.
const LOCAL_ONLY_PATHS = new Set(["/login", "/api/auth/login", "/api/auth/token", "/api/auth/password", "/api/auth/logout"])
const LOCAL_ONLY_PREFIXES = ["/auth/", "/api/remote-control/", "/api/remote-proxy/", "/api/remote-servers/", "/api/opencode-plugin/", "/sidecars/", "/previews/"]
const REMOTE_MANAGEMENT_READS = new Set(["/api/remote-control/status"])
// Client-supplied routing or authority metadata is never trusted on the remote surface.
const SPOOFABLE_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "x-codenomad-remote-control"]
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

export interface RemoteGateDeps {
  /** Public hostname while Remote Control runs; null when stopped. */
  publicHost(): string | null
  authenticate(token: string | undefined): RemoteControlDevice | null
  assignDevice(socket: Socket, deviceId: string): void
}

/**
 * Admission for requests arriving through the Remote Control ingress. Local
 * requests pass through untouched. Returns true when it has replied.
 */
export function gateRemoteRequest(request: FastifyRequest, reply: FastifyReply, deps: RemoteGateDeps): boolean {
  if (!isRemoteRequest(request)) return false

  const host = deps.publicHost()
  if (!host || request.headers.host !== host) {
    reject(reply, 421, "Misdirected request")
    return true
  }
  for (const name of SPOOFABLE_HEADERS) delete request.headers[name]

  const method = request.method.toUpperCase()
  if (!SAFE_METHODS.has(method) && request.headers.origin !== `https://${host}`) {
    reject(reply, 403, "Cross-origin request rejected")
    return true
  }

  // Judge the decoded path so percent-encoding cannot slip past host-only prefixes.
  const pathname = decodePath((request.raw.url ?? "/").split("?")[0] ?? "/")
  if (pathname === null) {
    reject(reply, 400, "Invalid request path")
    return true
  }
  if (PUBLIC_PATHS.has(pathname)) return false
  if (isLocalOnly(pathname) && !(method === "GET" && REMOTE_MANAGEMENT_READS.has(pathname))) {
    reject(reply, 404, "Not found")
    return true
  }

  const device = deps.authenticate(parseCookies(request.headers.cookie)[DEVICE_COOKIE_NAME])
  if (!device) {
    if (method === "GET" && wantsHtml(request)) reply.header("connection", "close").redirect(PAIR_PAGE_PATH)
    else reject(reply, 401, "This device is not paired")
    return true
  }
  attachRemoteDevice(request, device.id)
  deps.assignDevice(request.raw.socket, device.id)
  return false
}

export function deviceCookie(token: string): string {
  return `${DEVICE_COOKIE_NAME}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${DEVICE_COOKIE_MAX_AGE_SECONDS}`
}

// An early reply leaves any request body unread; closing the connection keeps a
// reused keep-alive socket from failing the client's next request.
function reject(reply: FastifyReply, status: number, error: string): void {
  reply.header("connection", "close").code(status).send({ error })
}

function decodePath(rawPath: string): string | null {
  try {
    return decodeURIComponent(rawPath)
  } catch {
    return null
  }
}

function isLocalOnly(pathname: string): boolean {
  return LOCAL_ONLY_PATHS.has(pathname) || LOCAL_ONLY_PREFIXES.some((prefix) => pathname.startsWith(prefix) || `${pathname}/` === prefix)
}
