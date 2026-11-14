import type { IncomingMessage } from "node:http"
import type { Socket } from "node:net"
import type { FastifyReply, FastifyRequest } from "fastify"
import { parseCookies, wantsHtml } from "../auth/http-auth"
import type { RemoteControlDevice } from "../api-types"
import { parsePreviewUpgradePath } from "../previews/upgrade-path"
import { routedPath } from "../server/routed-path"
import { attachRemoteDevice, isRemoteSocket } from "./request-origin"
import { hasBrowserRequestContext, SERVER_PAIR_PATH, validServerPairRequest } from "./server-pairing"

export const DEVICE_COOKIE_NAME = "__Host-codenomad_device"
export const PAIR_PAGE_PATH = "/remote-pair"
export const PAIR_EXCHANGE_PATH = "/api/remote-control/pair"
// Browsers cap cookie lifetime at 400 days; the host registry decides expiry.
const DEVICE_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60

// Reachable remotely without a paired device.
const PUBLIC_PATHS = new Set([PAIR_PAGE_PATH, PAIR_EXCHANGE_PATH, "/api/auth/status"])
// Host-only surfaces: local login/bootstrap, Remote Control management, desktop
// windows, local tools and the automation bridge. Never reachable remotely, except
// web previews through their capability token while the host allows them.
const LOCAL_ONLY_PATHS = new Set(["/login", "/api/auth/login", "/api/auth/token", "/api/auth/password", "/api/auth/logout"])
const LOCAL_ONLY_PREFIXES = ["/auth/", "/api/backends/", "/api/remote-control/", "/api/remote-proxy/", "/api/remote-servers/", "/api/opencode-plugin/", "/sidecars/", "/previews/"]
const REMOTE_MANAGEMENT_READS = new Set(["/api/remote-control/status"])
// Client-supplied routing or authority metadata is never trusted on the remote surface.
const SPOOFABLE_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "x-codenomad-remote-control"]
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

// BackendClient's reviewed server-device protocol: API, auth, storage, events,
// media and panel extensions. Keep methods and paths closed as callers evolve.
// instance/api delegates to isAllowedInstanceApiRoute in http-server.ts.
const SERVER_DEVICE_ROUTES: ReadonlyArray<readonly [string, RegExp]> = [
  ["POST", /^\/api\/memory$/],
  ["GET PUT", /^\/api\/memory\/settings$/],
  ["GET", /^\/api\/(?:auth\/status|meta|events|remote-control\/status|missions\/playbooks)$/],
  ["POST", /^\/api\/client-connections\/pong$/],
  ["GET", /^\/api\/usage\/[^/]+$/],
  ["GET", /^\/api\/filesystem(?:\/files\/content)?$/],
  ["POST", /^\/api\/filesystem\/folders$/],
  ["GET", /^\/api\/config-files$/],
  ["GET PUT", /^\/api\/config-files\/[^/]+\/content$/],
  ["GET PATCH", /^\/api\/storage\/(?:config|state)(?:\/[^/]+)?$/],
  ["GET PUT DELETE", /^\/api\/storage\/instances\/[^/]+$/],
  ["POST", /^\/api\/storage\/binaries\/validate$/],
  ["GET POST", /^\/api\/opencode\/(?:update|login-start)$/],
  ["POST", /^\/api\/opencode\/service$/],
  ["GET", /^\/api\/speech\/capabilities$/],
  ["POST", /^\/api\/speech\/(?:transcribe|synthesize(?:\/stream)?)$/],
  ["GET POST", /^\/api\/sidecars$/],
  ["POST", /^\/api\/previews$/],
  ["PUT DELETE", /^\/api\/sidecars\/[^/]+$/],
  ["DELETE", /^\/api\/previews\/[^/]+$/],
  ["GET POST", /^\/api\/panel-extensions$/],
  ["GET", /^\/api\/panel-extensions\/catalog$/],
  ["POST", /^\/api\/panel-extensions\/(?:inspect|catalog\/(?:inspect|install))$/],
  ["PATCH DELETE", /^\/api\/panel-extensions\/[^/]+$/],
  ["GET", /^\/api\/panel-extensions\/[^/]+\/panel$/],
  ["POST", /^\/api\/panel-extensions\/[^/]+\/(?:assets|assetRead|workItems|workItemUrl|images|imageRead|imagesStatus|prefillReferences|conversationStatus|conversationOpen|conversationNew|preferencesGet|preferencesSet)$/],
  ["GET POST", /^\/api\/workspaces$/],
  ["POST", /^\/api\/workspaces\/(?:clone|creation\/cancel|temporary\/abandon)$/],
  ["GET POST", /^\/api\/workspaces\/temporary$/],
  ["GET DELETE", /^\/api\/workspaces\/[^/]+$/],
  ["POST", /^\/api\/workspaces\/[^/]+\/(?:creation\/release|keep|discard|git-init|images-conversation)$/],
  ["GET", /^\/api\/workspaces\/[^/]+\/(?:background-shells|git-branches|pending-requests|files(?:\/(?:search|preview|content))?|plugin-controls|integrations|service-usage(?:\/(?:owner|cache))?)$/],
  ["PUT", /^\/api\/workspaces\/[^/]+\/files\/content$/],
  ["PATCH", /^\/api\/workspaces\/[^/]+\/plugin-controls$/],
  ["POST DELETE", /^\/api\/workspaces\/[^/]+\/plugin-sources$/],
  ["GET PUT", /^\/api\/workspaces\/[^/]+\/(?:websearch-settings|image-settings|subagent-depth|provider-accounts\/[^/]+)$/],
  ["GET", /^\/api\/workspaces\/[^/]+\/integrations\/[^/]+\/(?:hosts|binding)$/],
  ["POST", /^\/api\/workspaces\/[^/]+\/integrations\/[^/]+\/(?:install|attach|detach|install-host)$/],
  ["GET POST", /^\/api\/workspaces\/[^/]+\/worktrees$/],
  ["DELETE", /^\/api\/workspaces\/[^/]+\/worktrees\/[^/]+$/],
  ["GET", /^\/api\/workspaces\/[^/]+\/worktrees\/[^/]+\/(?:git-status|git-diff|git-history(?:\/[^/]+)?)$/],
  ["POST", /^\/api\/workspaces\/[^/]+\/worktrees\/[^/]+\/(?:git-stage|git-unstage|git-commit)$/],
  ["POST", /^\/api\/workspaces\/[^/]+\/sessions\/[^/]+\/worktree$/],
  ["GET", /^\/api\/workspaces\/[^/]+\/sessions\/[^/]+\/(?:permission-receipts|goal)$/],
  ["GET", /^\/api\/workspaces\/[^/]+\/session-media\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/[^/]+$/],
  ["POST", /^\/api\/workspaces\/[^/]+\/session-history\/(?:window|outline|outlinePreview|query|ranked|prune)$/],
  ["POST", /^\/api\/workspaces\/[^/]+\/session-pruning\/prune$/],
  ["GET POST", /^\/api\/workspaces\/[^/]+\/missions$/],
  ["POST", /^\/api\/workspaces\/[^/]+\/missions\/panel-page$/],
  ["GET POST", /^\/api\/workspaces\/[^/]+\/missions\/(?:scheduled|recurrence)$/],
  ["GET", /^\/api\/workspaces\/[^/]+\/missions\/scheduled\/(?:capabilities|requests\/[^/]+)$/],
  ["GET PATCH DELETE", /^\/api\/workspaces\/[^/]+\/missions\/[^/]+$/],
  ["GET", /^\/api\/workspaces\/[^/]+\/missions\/[^/]+\/(?:content|tasks|admission)$/],
  ["POST", /^\/api\/workspaces\/[^/]+\/missions\/[^/]+\/(?:control|recover)$/],
  ["GET POST", /^\/api\/workspaces\/[^/]+\/missions\/[^/]+\/schedule$/],
  ["GET POST", /^\/api\/workspaces\/[^/]+\/missions\/[^/]+\/schedule-settings$/],
  ["GET", /^\/api\/workspaces\/[^/]+\/missions\/recurrence\/[^/]+\/(?:current|run-now\/status|passages\/[^/]+|current\/[^/]+\/content)$/],
  ["POST", /^\/api\/workspaces\/[^/]+\/missions\/recurrence\/[^/]+\/(?:control(?:\/status)?|run-now|current\/[^/]+\/page)$/],
  ["GET", /^\/workspaces\/[^/]+\/yolo\/sessions\/[^/]+$/],
  ["POST", /^\/workspaces\/[^/]+\/yolo\/sessions\/[^/]+\/toggle$/],
  ["GET POST PUT PATCH DELETE", /^\/workspaces\/[^/]+\/instance\/api\/.+$/],
]

export interface RemoteGateDeps {
  /** Public hostname while Remote Control runs; null when stopped. */
  publicHost(): string | null
  authenticate(token: string | undefined): RemoteControlDevice | null
  assignDevice(socket: Socket, deviceId: string): void
  /** Whether Remote Control serves this live web preview: the host allows previews and the token exists. */
  servesPreview(token: string): boolean
}

/**
 * Admission for ingress traffic and paired-device credentials on either listener.
 * Other direct requests pass through untouched. Returns true when it has replied.
 */
export function gateRemoteRequest(request: FastifyRequest, reply: FastifyReply, deps: RemoteGateDeps): boolean {
  const ingress = isRemoteSocket(request.raw.socket)
  let cookies: Record<string, string>
  try {
    cookies = parseCookies(request.headers.cookie)
  } catch {
    reject(reply, 400, "Invalid cookie")
    return true
  }
  const explicitServer = request.headers["x-codenomad-server-request"] === "1"
  if (!ingress && !explicitServer) return false

  const host = deps.publicHost()
  if (!host || (ingress && request.headers.host !== host)) {
    reject(reply, ingress ? 421 : 401, ingress ? "Misdirected request" : "This device is not paired")
    return true
  }
  for (const name of SPOOFABLE_HEADERS) delete request.headers[name]

  const pathname = routedPath(request.raw.url ?? "/")
  if (pathname === null) {
    reject(reply, 400, "Invalid request path")
    return true
  }
  // Device attachment also marks direct requests remote for downstream auth.
  // Browser pairing authority comes from the ingress socket, before attachment.
  if (!ingress && (pathname === PAIR_PAGE_PATH || pathname === PAIR_EXCHANGE_PATH)) {
    reject(reply, 404, "Not found")
    return true
  }
  // Pairing has its own explicit non-browser exchange.
  if (pathname === SERVER_PAIR_PATH) {
    if (ingress && validServerPairRequest(request)) return false
    reject(reply, 403, "Server pairing request rejected")
    return true
  }
  // A preview's sandboxed document sends no device cookie and `Origin: null`; its
  // capability token admits it, as on local listeners, while the host allows previews.
  const previewToken = pathname.match(/^\/previews\/([^/]+)(?:\/|$)/)?.[1]
  if (ingress && previewToken && deps.servesPreview(previewToken)) return false

  const method = request.method.toUpperCase()
  const device = deps.authenticate(cookies[DEVICE_COOKIE_NAME])
  const serverRequest = explicitServer && device !== null && !hasBrowserRequestContext(request)
  const nativePairing = pathname === PAIR_EXCHANGE_PATH && request.headers.origin === undefined
    && request.headers.referer === undefined && request.headers["sec-fetch-site"] === undefined
  if (!SAFE_METHODS.has(method) && request.headers.origin !== `https://${host}` && !serverRequest && !nativePairing) {
    reject(reply, 403, "Cross-origin request rejected")
    return true
  }
  if (!ingress && !device) {
    reject(reply, 401, "This device is not paired")
    return true
  }
  if ((serverRequest || (!ingress && explicitServer)) && !SERVER_DEVICE_ROUTES.some(([methods, pattern]) => methods.split(" ").includes(method === "HEAD" ? "GET" : method) && pattern.test(pathname))) {
    reject(reply, 404, "Not found")
    return true
  }
  if ((isHostOnlyPath(pathname, method) || ingress && (pathname === "/api/memory" || pathname.startsWith("/api/memory/")))
    && !(PUBLIC_PATHS.has(pathname) && !serverRequest)) {
    reject(reply, 404, "Not found")
    return true
  }

  if (device) {
    attachRemoteDevice(request, device.id)
    deps.assignDevice(request.raw.socket, device.id)
    return false
  }
  // Public paths still identify a paired device, so status reports it as authenticated.
  if (PUBLIC_PATHS.has(pathname)) return false
  // The UI bundle is public on local listeners too, and browsers fetch the PWA
  // manifest without cookies. HTML entry points, APIs and workspaces stay gated.
  if ((method === "GET" || method === "HEAD") && isStaticBundlePath(pathname)) return false

  if (method === "GET" && wantsHtml(request)) reply.header("connection", "close").redirect(PAIR_PAGE_PATH)
  else reject(reply, 401, "This device is not paired")
  return true
}

/**
 * Admission for WebSocket upgrades arriving through the Remote Control ingress:
 * only previews it serves, parsed as the preview proxy parses them.
 */
export function admitRemoteUpgrade(request: IncomingMessage, deps: RemoteGateDeps): boolean {
  const host = deps.publicHost()
  const target = request.url ?? ""
  if (!host || request.headers.host !== host || !target.startsWith("/") || target.startsWith("//")) return false
  for (const name of SPOOFABLE_HEADERS) delete request.headers[name]
  const parsed = parsePreviewUpgradePath(target)
  return parsed !== null && deps.servesPreview(parsed.token)
}

export function deviceCookie(token: string): string {
  return `${DEVICE_COOKIE_NAME}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${DEVICE_COOKIE_MAX_AGE_SECONDS}`
}

// An early reply leaves any request body unread; closing the connection keeps a
// reused keep-alive socket from failing the client's next request.
function reject(reply: FastifyReply, status: number, error: string): void {
  reply.header("connection", "close").code(status).send({ error })
}

function isStaticBundlePath(pathname: string): boolean {
  return /\.[A-Za-z0-9]+$/.test(pathname) && !/\.html?$/i.test(pathname)
    && !pathname.startsWith("/api/") && !pathname.startsWith("/workspaces/")
}

export function isHostOnlyPath(pathname: string, method: string, direct = false): boolean {
  // Direct browsers sign in/out with the password; token bootstrap stays local.
  if (direct && ["/login", "/api/auth/login", "/api/auth/logout"].includes(pathname)) return false
  if (method === "GET" && REMOTE_MANAGEMENT_READS.has(pathname)) return false
  return LOCAL_ONLY_PATHS.has(pathname) || LOCAL_ONLY_PREFIXES.some((prefix) => pathname.startsWith(prefix) || `${pathname}/` === prefix)
}

/** Reviewed memory methods exposed by the local UI relay; ingress stays host-only. */
export function isMemoryRelayRoute(pathname: string, method: string): boolean {
  return pathname === "/api/memory" && method === "POST"
    || pathname === "/api/memory/settings" && ["GET", "HEAD", "PUT"].includes(method)
}
