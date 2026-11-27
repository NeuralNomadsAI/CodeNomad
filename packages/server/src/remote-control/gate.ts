import type { IncomingMessage } from "node:http"
import type { Socket } from "node:net"
import type { FastifyReply, FastifyRequest } from "fastify"
import { parseCookies, wantsHtml } from "../auth/http-auth"
import type { RemoteControlDevice } from "../api-types"
import { parsePreviewUpgradePath } from "../previews/upgrade-path"
import { routedPath } from "../server/routed-path"
import { verifiedDirectEntryOrigin, verifiedDirectHttpsOrigin, verifiedDirectServerOrigin } from "./direct-https"
import { attachRemoteDevice, isRemoteSocket, markDirectDeviceRequest } from "./request-origin"
import { hasBrowserRequestContext, SERVER_PAIR_PATH, validServerPairRequest } from "./server-pairing"

export const DEVICE_COOKIE_NAME = "__Host-codenomad_device"
export const PAIR_PAGE_PATH = "/remote-pair"
export const PAIR_EXCHANGE_PATH = "/api/remote-control/pair"
// Browsers cap cookie lifetime at 400 days; the host registry decides expiry.
const DEVICE_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60

// Reachable remotely without a paired device.
const PUBLIC_PATHS = new Set([PAIR_PAGE_PATH, PAIR_EXCHANGE_PATH, "/api/auth/status"])
// Host-only surfaces retain the reviewed browser UI exceptions below and live
// preview capabilities while the host allows them.
const LOCAL_ONLY_PATHS = new Set(["/login", "/api/auth/login", "/api/auth/token", "/api/auth/password", "/api/auth/logout", "/api/opencode/logs"])
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
  ["POST", /^\/api\/speech\/(?:transcribe|synthesize\/stream)$/],
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
  ["POST", /^\/api\/panel-extensions\/[^/]+\/(?:notesGet|notesSet|notesList|notesDelete|notesOpen|workItemBranches|workItemBranchLookup|workItemBranch)$/],
  ["GET POST", /^\/api\/workspaces$/],
  ["POST", /^\/api\/workspaces\/(?:clone|creation\/cancel|temporary\/abandon)$/],
  ["GET POST", /^\/api\/workspaces\/temporary$/],
  ["GET DELETE", /^\/api\/workspaces\/[^/]+$/],
  ["POST", /^\/api\/workspaces\/[^/]+\/(?:creation\/release|keep|discard|git-init|images-conversation)$/],
  ["GET", /^\/api\/workspaces\/[^/]+\/(?:background-shells|git-branches|repository-source|pending-requests|files(?:\/(?:search|preview|content))?|plugin-controls|integrations|service-usage(?:\/(?:owner|cache))?)$/],
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
  ["GET", /^\/api\/workspaces\/[^/]+\/sessions\/[^/]+\/(?:permission-receipts|goal|automations)$/],
  ["POST", /^\/api\/workspaces\/[^/]+\/sessions\/[^/]+\/automations\/[^/]+\/(?:pause|resume)$/],
  ["DELETE", /^\/api\/workspaces\/[^/]+\/sessions\/[^/]+\/automations\/[^/]+$/],
  ["GET", /^\/api\/workspaces\/[^/]+\/session-media\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/[^/]+$/],
  ["GET", /^\/api\/workspaces\/[^/]+\/session-attachment\/[^/]+\/[^/]+\/[^/]+\/[^/]+$/],
  ["POST", /^\/api\/workspaces\/[^/]+\/session-history\/(?:window|outline|outlinePreview|query|ranked|prune)$/],
  ["POST", /^\/api\/workspaces\/[^/]+\/session-pruning\/(?:preview|prune)$/],
  ["GET POST", /^\/api\/workspaces\/[^/]+\/missions$/],
  ["GET", /^\/api\/workspaces\/[^/]+\/missions\/creation\/[^/]+$/],
  ["POST", /^\/api\/workspaces\/[^/]+\/missions\/panel-page$/],
  ["GET POST", /^\/api\/workspaces\/[^/]+\/missions\/scheduled$/],
  ["GET", /^\/api\/workspaces\/[^/]+\/missions\/scheduled\/(?:capabilities|requests\/[^/]+)$/],
  ["GET PATCH DELETE", /^\/api\/workspaces\/[^/]+\/missions\/[^/]+$/],
  ["GET", /^\/api\/workspaces\/[^/]+\/missions\/[^/]+\/(?:content|tasks|admission)$/],
  ["POST", /^\/api\/workspaces\/[^/]+\/missions\/[^/]+\/(?:control|recover)$/],
  ["GET POST", /^\/api\/workspaces\/[^/]+\/missions\/[^/]+\/schedule$/],
  ["GET POST", /^\/api\/workspaces\/[^/]+\/missions\/[^/]+\/schedule-settings$/],
  ["GET", /^\/api\/workspaces\/[^/]+\/missions\/recurrence\/[^/]+\/(?:current|current\/[^/]+\/content)$/],
  ["POST", /^\/api\/workspaces\/[^/]+\/missions\/recurrence\/[^/]+\/current\/[^/]+\/page$/],
  ["GET PUT", /^\/api\/workspaces\/[^/]+\/sessions\/[^/]+\/permission-mode$/],
  ["GET POST PUT PATCH DELETE", /^\/workspaces\/[^/]+\/instance\/api\/.+$/],
]
const allowsServerDeviceRoute = (method: string, pathname: string) =>
  SERVER_DEVICE_ROUTES.some(([methods, pattern]) => methods.split(" ").includes(method === "HEAD" ? "GET" : method) && pattern.test(pathname))

export interface RemoteGateDeps {
  /** Public hostname while Remote Control runs; null when stopped. */
  publicHost(): string | null
  authenticate(token: string | undefined): RemoteControlDevice | null
  assignDevice(socket: Socket, deviceId: string): void
  /** Whether Remote Control serves this live web preview: the host allows previews and the token exists. */
  servesPreview(token: string): boolean
  /** Verified direct HTTPS origins (`direct-https.ts`); browser devices are refused elsewhere on the direct listener. */
  directHttpsOrigins?(): readonly string[]
  /** A browser device paired on this verified direct HTTPS origin, independent of the tunnel. */
  authenticateDirect?(token: string | undefined, origin: string): RemoteControlDevice | null
  assignDirectDevice?(socket: Socket, deviceId: string): void
  /** The host's opt-in for SideCar content on verified direct HTTPS origins only. */
  allowsDirectSidecar?(request: FastifyRequest): boolean
  /** Host-owned experimental multi-backend admission for browser UI routes. */
  allowsBackendUi?(): boolean
}

/**
 * Admission for ingress traffic and paired-device credentials on either listener.
 * Other direct requests pass through untouched. Returns true when it has replied.
 */
export function gateRemoteRequest(request: FastifyRequest, reply: FastifyReply, deps: RemoteGateDeps): boolean {
  const ingress = isRemoteSocket(request.raw.socket)
  const cookies = parseCookies(request.headers.cookie)
  if (!cookies) {
    reject(reply, 400, "Invalid cookie")
    return true
  }
  const explicitServer = request.headers["x-codenomad-server-request"] === "1"
  if (!ingress && !explicitServer) return gateDirectHttpsDevice(request, reply, cookies[DEVICE_COOKIE_NAME], deps)
  const direct = !ingress ? verifiedDirectServerOrigin(request, deps.directHttpsOrigins?.() ?? []) : undefined
  if (direct) {
    const device = !hasBrowserRequestContext(request) && deps.authenticateDirect?.(cookies[DEVICE_COOKIE_NAME], direct)
    if (!device) { reject(reply, 401, "This device is not paired"); return true }
    const pathname = routedPath(request.raw.url ?? "/")
    if (!pathname || !allowsServerDeviceRoute(request.method, pathname)) {
      reject(reply, 404, "Not found"); return true
    }
    for (const name of SPOOFABLE_HEADERS) delete request.headers[name]
    attachRemoteDevice(request, device.id)
    markDirectDeviceRequest(request, true)
    deps.assignDirectDevice?.(request.raw.socket, device.id)
    return false
  }

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
  if ((serverRequest || (!ingress && explicitServer)) && !allowsServerDeviceRoute(method, pathname)) {
    reject(reply, 404, "Not found")
    return true
  }
  const backendUi = request.headers["x-codenomad-server-request"] === undefined && device !== null
    && deps.allowsBackendUi?.() === true && isBackendUiRoute(pathname, method)
  if (((isHostOnlyPath(pathname, method) || ingress && (pathname === "/api/memory" || pathname.startsWith("/api/memory/"))) && !backendUi)
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

  if ((method === "GET" || (method === "HEAD" && pathname === "/")) && wantsHtml(request)) reply.header("connection", "close").redirect(PAIR_PAGE_PATH)
  else reject(reply, 401, "This device is not paired")
  return true
}

/**
 * Browser device credentials on the direct listener: judged only on a verified direct
 * HTTPS origin, in the ingress device scope. Without a device cookie, and on any other
 * origin, the request keeps the direct listener's password rules untouched.
 */
function gateDirectHttpsDevice(request: FastifyRequest, reply: FastifyReply, token: string | undefined, deps: RemoteGateDeps): boolean {
  if (!token || !deps?.authenticateDirect || !deps.directHttpsOrigins) return false
  const pathname = routedPath(request.raw.url ?? "/")
  // Pairing replaces the credential; preview capabilities keep their scoped admission.
  if (pathname === null || pathname === PAIR_PAGE_PATH || pathname === PAIR_EXCHANGE_PATH || /^\/previews\/[^/]+(?:\/|$)/.test(pathname)) return false
  const origin = (pathname === "/" ? verifiedDirectEntryOrigin : verifiedDirectHttpsOrigin)(request, deps.directHttpsOrigins())
  if (!origin) return false

  const method = request.method.toUpperCase()
  const device = deps.authenticateDirect(token, origin)
  if (!device) {
    // An invalid device credential never falls back to a password session.
    markDirectDeviceRequest(request, false)
    if (pathname === "/api/auth/status" || ((method === "GET" || method === "HEAD") && isStaticBundlePath(pathname))) return false
    if ((method === "GET" || (method === "HEAD" && pathname === "/")) && wantsHtml(request)) reply.header("connection", "close").redirect(PAIR_PAGE_PATH)
    else reject(reply, 401, "This device is not paired")
    return true
  }
  const directSidecar = pathname.startsWith("/sidecars/") && deps.allowsDirectSidecar?.(request) === true
  const backendUi = request.headers["x-codenomad-server-request"] === undefined
    && deps.allowsBackendUi?.() === true && isBackendUiRoute(pathname, method)
  if (((isHostOnlyPath(pathname, method) && !directSidecar || pathname === "/api/memory" || pathname.startsWith("/api/memory/")) && !backendUi) && !PUBLIC_PATHS.has(pathname)) {
    reject(reply, 404, "Not found")
    return true
  }
  for (const name of SPOOFABLE_HEADERS) delete request.headers[name]
  attachRemoteDevice(request, device.id)
  markDirectDeviceRequest(request, true)
  deps.assignDirectDevice?.(request.raw.socket, device.id)
  return false
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

/** Audio uses the exact tunnel origin and the device credential on this request. */
export function admitRemoteVoiceUpgrade(request: IncomingMessage, deps: RemoteGateDeps): RemoteControlDevice | null {
  const host = deps.publicHost()
  if (!isRemoteSocket(request.socket) || !host || request.headers.host !== host || request.headers.origin !== `https://${host}`) return null
  for (const name of SPOOFABLE_HEADERS) delete request.headers[name]
  const cookies = parseCookies(request.headers.cookie)
  if (!cookies) return null
  const device = deps.authenticate(cookies[DEVICE_COOKIE_NAME])
  if (device) deps.assignDevice(request.socket, device.id)
  return device
}

export function deviceCookie(token: string, maxAge = DEVICE_COOKIE_MAX_AGE_SECONDS): string {
  return `${DEVICE_COOKIE_NAME}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
}

// An early reply leaves any request body unread; closing the connection keeps a
// reused keep-alive socket from failing the client's next request.
function reject(reply: FastifyReply, status: number, error: string): void {
  if (status === 401) reply.header("x-codenomad-before-dispatch", "1")
  reply.header("connection", "close").code(status).send({ error })
}

export function isHtmlBundlePath(pathname: string): boolean {
  return /\.html?(?:\.(?:br|gz|deflate))*$/i.test(pathname)
}

function isStaticBundlePath(pathname: string): boolean {
  return /\.[A-Za-z0-9]+$/.test(pathname) && !isHtmlBundlePath(pathname)
    && !pathname.startsWith("/api/") && !pathname.startsWith("/workspaces/")
}

export function isHostOnlyPath(pathname: string, method: string, direct = false): boolean {
  // Paired browsers can clear their device cookie.
  if (pathname === "/api/auth/logout" && method === "POST") return false
  // Direct browsers sign in/out with the password; token bootstrap stays local.
  if (direct && ["/login", "/api/auth/login", "/api/auth/logout"].includes(pathname)) return false
  if (method === "GET" && REMOTE_MANAGEMENT_READS.has(pathname)) return false
  return LOCAL_ONLY_PATHS.has(pathname) || LOCAL_ONLY_PREFIXES.some((prefix) => pathname.startsWith(prefix) || `${pathname}/` === prefix)
}

/** Reviewed memory methods; browser admission retains the host feature and principal guards. */
export function isMemoryRelayRoute(pathname: string, method: string): boolean {
  return pathname === "/api/memory" && method === "POST"
    || pathname === "/api/memory/settings" && ["GET", "HEAD", "PUT"].includes(method)
}

/** Browser-only exceptions; remote-side host administration and nested relays stay closed. */
export function isBackendUiRoute(pathname: string, method: string): boolean {
  const verb = method === "HEAD" ? "GET" : method
  if (isMemoryRelayRoute(pathname, method)) return true
  if (["GET", "PATCH"].includes(verb) && ["/api/storage/state", "/api/storage/state/ui"].includes(pathname)) return true
  if (verb === "GET" && pathname === "/api/remote-servers/ssh-hosts") return true
  if (verb === "POST" && (pathname === "/api/remote-servers/probe"
    || /^\/api\/remote-servers\/[A-Za-z0-9_-]{1,64}\/(?:browse|connect|forget)$/.test(pathname))) return true
  const target = pathname.match(/^\/api\/backends\/[A-Za-z0-9_-]{1,64}(\/.+)$/)?.[1]
  if (!target) return false
  // Principal-bound host path capabilities; generation-wide detachment stays local.
  if (verb === "POST" && target === "/preview-capabilities") return true
  if (verb === "DELETE" && /^\/preview-capabilities\/[0-9a-f-]{36}$/.test(target)) return true
  if (isMemoryRelayRoute(target, method)) return true
  if (verb === "POST" && ["/api/auth/login", "/api/auth/logout"].includes(target)) return true
  return !isHostOnlyPath(target, method) && target !== "/api/remote-control/status"
    && allowsServerDeviceRoute(verb, target)
}
