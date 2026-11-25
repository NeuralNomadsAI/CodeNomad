import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify"
import fastifyStatic from "@fastify/static"
import replyFrom from "@fastify/reply-from"
import fs from "fs"
import { isIP, type Socket } from "net"
import path from "path"
import { AsyncLocalStorage } from "node:async_hooks"
import { Readable } from "node:stream"
import { finished } from "node:stream/promises"
import { fetch } from "undici"
import type { Logger } from "../logger"
import { WorkspaceManager } from "../workspaces/manager"
import { isInvalidRequestError, isPtyNotFoundError, isSessionNotFoundError, isShellNotFoundError, type LocationRef, type OpenCodeClient } from "@opencode/client"

import type { SettingsService } from "../settings/service"
import { FileSystemBrowser } from "../filesystem/browser"
import { EventBus } from "../events/bus"
import { registerWorkspaceRoutes } from "./routes/workspaces"
import { registerTemporaryWorkspaceRoutes } from "./routes/temporary-workspaces"
import { syncSessionGitContext } from "../workspaces/session-git-context"
import { syncSessionMemoryContext } from "../workspaces/session-memory-context"
import { admitSessionControl, currentSessionControl, controlKind } from "./session-control-admission"
import { assertOrdinaryMissionScheduleBody, assertOrdinaryMissionScheduleSession, MissionScheduleInputError } from "./mission-schedule-input-guard"
import { readGitStatus } from "../workspaces/git-requirement"
import { registerSettingsRoutes } from "./routes/settings"
import { registerFilesystemRoutes } from "./routes/filesystem"
import { registerConfigFileRoutes } from "./routes/config-files"
import { registerMetaRoutes } from "./routes/meta"
import { registerEventRoutes } from "./routes/events"
import { registerStorageRoutes } from "./routes/storage"
import { registerPermissionReceiptRoutes } from "./routes/permission-receipts"
import type { PermissionReceipts } from "../permissions/receipts"
import { registerSessionPruningRoutes } from "./routes/session-pruning"
import { registerImagesConversationRoute } from "./routes/images-conversation"
import { registerSessionGoalRoute } from "./routes/session-goal"
import { registerSessionFavoritesRoutes } from "./routes/session-favorites"
import { registerSessionCleanupRoute } from "./routes/session-cleanup"
import { SessionCleanupFence } from "./session-cleanup-fence"
import { registerBackgroundShellRoutes } from "./routes/background-shells"
import { ownedShellDirectory } from "../opencode/background-shells"
import { registerSessionMediaRoutes } from "./routes/session-media"
import { registerWorktreeRoutes } from "./routes/worktrees"
import { registerPendingRequestRoutes } from "./routes/pending-requests"
import { registerSpeechRoutes } from "./routes/speech"
import { registerOpenCodeUpdateRoutes } from "./routes/opencode-update"
import { registerOpenCodeLogsRoutes } from "./routes/opencode-logs"
import { BinaryResolver } from "../settings/binaries"
import { registerRemoteControlRoutes } from "./routes/remote-control"
import { registerRemoteServerRoutes } from "./routes/remote-servers"
import { registerRemoteServerBrowseRoutes } from "./routes/remote-server-browse"
import { registerBackendRelayRoutes } from "./routes/backend-relay"
import { registerRemotePreviewCapabilityRoutes } from "./routes/remote-preview-capabilities"
import { RemoteServerBrowseManager } from "../codenomad-servers/browse-manager"
import { registerRemoteProxyRoutes } from "./routes/remote-proxy"
import { registerSideCarRoutes } from "./routes/sidecars"
import { registerPreviewRoutes } from "./routes/previews"
import { registerUsageRoutes } from "./routes/usage"
import { registerMissionRoutes } from "./routes/missions"
import { connectMissionActivityCache, MissionActivityCache } from "../missions/activity-cache"
import { replyMissionHumanAnswer } from "./routes/mission-human-answer"
import { HUMAN_ANSWER_HEADER } from "../missions/human-answer"
import { registerMissionRecurrenceControl } from "./routes/mission-recurrence-control"
import { registerMissionRecurrenceControlStatus } from "./routes/mission-recurrence-control-status"
import { registerMissionRecurrenceManual } from "./routes/mission-recurrence-manual"
import { registerPanelExtensionRoutes } from "./routes/panel-extensions"
import { registerPanelExtensionAssetRoutes } from "./routes/panel-extension-assets"
import { registerPanelExtensionWorkItemRoutes } from "./routes/panel-extension-work-items"
import { registerPanelExtensionApi4Routes } from "./routes/panel-extension-api4"
import { forgeWorkItems } from "../forge/work-items"
import { registerRepositorySourceRoute } from "./routes/repository-source"
import type { PanelExtensionStore } from "../panel-extensions/store"
import { registerPluginControlRoutes } from "./routes/plugin-controls"
import { PluginControls } from "../opencode/plugin-controls"
import { PluginSources } from "../opencode/plugin-sources"
import { registerPluginSourceRoutes } from "./routes/plugin-sources"
import { registerIntegrationRoutes } from "./routes/integrations"
import { IntegrationCatalogSource } from "../opencode/integrations/catalog"
import { IntegrationsReader } from "../opencode/integrations/integrations"
import { IntegrationAttachments } from "../opencode/integrations/attachments"
import { registerIntegrationAttachmentRoutes } from "./routes/integration-attachments"
import { IntegrationInstaller } from "../opencode/integrations/install"
import { registerIntegrationInstallRoutes } from "./routes/integration-install"
import { WebSearchSettings } from "../opencode/websearch-settings"
import { ServiceUsage } from "../opencode/service-usage"
import { registerServiceUsageRoutes } from "./routes/service-usage"
import { registerWebSearchSettingsRoutes } from "./routes/websearch-settings"
import { SubagentDepthSettings } from "../opencode/subagent-depth-settings"
import { NativeScheduleSettingsActivation } from "../opencode/native-schedule-settings-activation"
import { NativeScheduleCapabilityReader } from "../opencode/native-schedule-capability"
import { createOpenCodeLoginStart } from "../host-lifetime/opencode-login-start"
import { registerOpenCodeLoginStartRoutes } from "./routes/opencode-login-start"
import { registerSubagentDepthSettingsRoutes } from "./routes/subagent-depth-settings"
import { ImageSettings } from "../opencode/image-settings"
import { registerImageSettingsRoutes } from "./routes/image-settings"
import { PROMPT_INLINE_FILE_LIMITS, ServerMeta, SESSION_ENVIRONMENT_FAILED_ERROR_CODE } from "../api-types"
import { InstanceStore } from "../storage/instance-store"
import type { AuthManager } from "../auth/manager"
import { registerAuthRoutes } from "./routes/auth"
import { sendUnauthorized, wantsHtml } from "../auth/http-auth"
import type { SpeechService } from "../speech/service"
import { isLiveVoiceRoute, LiveVoiceGateway, refuseVoiceUpgrade, voiceSource } from "../speech/live-voice-gateway"
import { ClientConnectionManager } from "../clients/connection-manager"
import type { SideCarManager } from "../sidecars/manager"
import { sidecarRequestCookies, sidecarResponseCookies } from "../sidecars/proxy-cookies"
import { proxyWebSocket } from "./proxy-websocket"
import { guardProxyListener, proxyConnector, ProxyDestinationDenied } from "./proxy-destination"
import type { PreviewManager } from "../previews/manager"
import type { RemoteControlManager } from "../remote-control/manager"
import { guardServerPairRequest, isServerPairExchange, SERVER_PAIR_PATH } from "../remote-control/server-pairing"
import { gateRemoteRequest, isHostOnlyPath, isHtmlBundlePath, isBackendUiRoute, isMemoryRelayRoute, PAIR_EXCHANGE_PATH, PAIR_PAGE_PATH } from "../remote-control/gate"
import { createBackendUiAccess } from "../codenomad-servers/ui-caller"
import { createRelayPrincipalBinding } from "../codenomad-servers/relay-principal"
import { isLocalRequest, isRemoteRequest, isRemoteSocket } from "../remote-control/request-origin"
import type { RemotePreviewCapabilities } from "../codenomad-servers/preview-capabilities"
import { PreviewBodyBudget, previewBodyKind, previewDocumentStream, rewritePreviewText } from "../codenomad-servers/preview-body"
import { registerDirectOriginPolicy } from "./direct-origin"
import { verifiedDirectHttpsOrigin, verifiedDirectServerOrigin } from "../remote-control/direct-https"
import { createSideCarDirectHttpsAccess, isSideCarContentPath, sidecarsOverDirectHttpsEnabled } from "./sidecar-direct-https"
import { framesNoBody } from "./bodiless-request"
import { addProxiedHttpMethods } from "./proxied-http-methods"
import { ROUTER_OPTIONS, routedPath } from "./routed-path"
import { redactSecrets, registerRequestLogging } from "./request-logging"
export { redactSecrets, registerRequestLogging } from "./request-logging"
import { buildPreviewRuntimeBridge, rewritePreviewImportMap, rewritePreviewJavaScriptImports } from "../previews/runtime-bridge"
import { PREVIEW_SANDBOX_FLAGS } from "../previews/sandbox"
import { parsePreviewUpgradePath } from "../previews/upgrade-path"
import { forwardRuntimeRequest, PreDispatchHttpError } from "../opencode/compatibility/proxy"
import { markDispatchHookAwareFetch, supportsDispatchHooks } from "../opencode/compatibility/transport"
import { UnsupportedOpenCodeError } from "../opencode/runtime-support"
import { SessionModeConflict, SessionPermissionModes } from "../permissions/session-mode"
import { appendSessionProjection, sessionPermissionRules, blockPositions } from "../permissions/session-mode-rules"
import { recordPermissionFork, registerSessionPermissionModeRoutes, sessionPermissionTarget } from "./routes/session-permission-mode"
import { connectSessionPermissionRefresh } from "./routes/session-permission-refresh"
import { requestAdmission } from "./request-admission"
import { LOCATION_CONTEXT_HEADER, locationRequestOptions, readLocationContext, readLocationRef, sameLocation } from "../opencode/compatibility/location"
import { DEFERRED_MEDIA_HEADER, deferToolMedia, wantsDeferredMedia } from "../opencode/session-media"
import { SESSION_LOCATED_ELSEWHERE_REASON, SESSION_PLACEMENT_HEADER } from "../opencode/session-access-contract"
import { decodeSessionListScope, prepareLocationImport, readRequestLocations, type SessionListScope } from "../opencode/compatibility/proxy-locations"
import type { RemoteProxySessionManager } from "./remote-proxy"
import { createOpenCodeUpdateService } from "../opencode-update/service"
import { WorktreeDeletionFence } from "../workspaces/worktree-session-evacuation"
import type { NativeParent } from "../native-parent"
import { isAutomationPluginRequest, registerAutomationPluginRoute } from "./routes/automation-plugin"
import type { MemoryStore } from "../memory/store"
import { MemoryService } from "../memory/service"
import { registerMemoryRoutes } from "./routes/memory"
import { DeveloperCdp } from "../developer-cdp"
import { formatHostForUrl, isLoopbackHost, isWildcardHost, stripHostBrackets } from "./network-host"
import { validatePromptAttachmentBudget } from "./prompt-attachment-budget"
import { ProviderAccountsService, AccountSelectionFailed } from "../provider-accounts/service"
import { registerProviderAccountsRoutes } from "./routes/provider-accounts"
import { observeProviderQuotaFailures } from "../provider-accounts/quota-observer"
import { createOpenCodeFreeUsage } from "../usage/opencode-free-usage"
import { deferPendingDiscovery, grantPendingReconciliation, PENDING_DISCOVERY_DEFERRED, PENDING_RECONCILIATION_HEADER } from "../workspaces/pending-discovery"

interface HttpServerDeps {
  bindHost: string
  bindPort: number
  /** When bindPort is 0, try this first. */
  defaultPort: number
  protocol: "http" | "https"
  httpsOptions?: { key: string | Buffer; cert: string | Buffer; ca?: string | Buffer }
  workspaceManager: WorkspaceManager
  settings: SettingsService
  remoteServerBrowseManager?: RemoteServerBrowseManager
  fileSystemBrowser: FileSystemBrowser
  eventBus: EventBus
  serverMeta: ServerMeta
  instanceStore: InstanceStore
  speechService: SpeechService
  liveVoice?: LiveVoiceGateway
  sidecarManager: SideCarManager
  previewManager: PreviewManager
  remoteControlManager: RemoteControlManager
  authManager: AuthManager
  clientConnectionManager: ClientConnectionManager
  remoteProxySessionManager: RemoteProxySessionManager
  permissionReceipts?: PermissionReceipts
  uiStaticDir: string
  uiDevServerUrl?: string
  allowedOrigins?: string[]
  logger: Logger
  nativeParent: NativeParent
  automationBridgeToken: string
  memoryStore?: MemoryStore
  panelExtensions?: PanelExtensionStore
  /** Shared by every listener of one backend; a fresh one serves a lone server. */
  worktreeDeletionFence?: WorktreeDeletionFence
  sessionPermissions?: { modes: SessionPermissionModes; cleanup: SessionCleanupFence }
  /** See `registerMissionRoutes`. */
  missionsHost?: () => boolean
  /** Shared by every listener of one backend; a fresh in-memory one serves a lone server. */
  integrationCatalog?: IntegrationCatalogSource
}

interface HttpServerStartResult {
  port: number
  url: string
  displayHost: string
}

export function shouldRetryPreferredPort(error: unknown, autoPortRequested: boolean, platform = process.platform): boolean {
  if (!autoPortRequested) return false
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "EADDRINUSE" || (platform === "win32" && code === "EACCES")
}

// One boundary per application listener; plugin routes share this raw server.
const hostProxyTargets = new WeakMap<object, (target: URL) => boolean>()

function blocksHostProxyTarget(server: object, target: URL): boolean {
  return hostProxyTargets.get(server)?.(target) ?? true
}

export function createHttpServer(deps: HttpServerDeps) {
  // Fastify's type-level RawServer inference gets noisy when toggling HTTP vs HTTPS.
  // We keep the runtime behavior correct and cast the instance to a generic FastifyInstance.
  const app = Fastify(
    ({
      logger: false,
      routerOptions: ROUTER_OPTIONS,
      frameworkErrors: (error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
        reply.header("connection", "close").code(error.statusCode ?? (error.code === "FST_ERR_BAD_URL" ? 400 : 500)).send({ error: "Invalid request" })
      },
      ...(deps.protocol === "https" && deps.httpsOptions ? { https: deps.httpsOptions } : {}),
    } as unknown) as any,
  ) as unknown as FastifyInstance
  // Before any route: `all()` routes take the methods supported when declared.
  addProxiedHttpMethods(app)
  guardProxyListener(app.server)
  const proxyLogger = deps.logger.child({ component: "proxy" })
  const apiLogger = deps.logger.child({ component: "http" })
  const sseLogger = deps.logger.child({ component: "sse" })

  const sseClients = new Set<() => void>()
  const registerSseClient = (cleanup: () => void) => {
    sseClients.add(cleanup)
    return () => sseClients.delete(cleanup)
  }
  const closeSseClients = () => {
    for (const cleanup of Array.from(sseClients)) {
      cleanup()
    }
    sseClients.clear()
  }
  // Upgraded sockets leave Node's HTTP connection pool, including unmatched
  // upgrades (for example Vite HMR). Server.close() cannot drain them itself.
  const upgrades = new Set<Socket>()
  let closing = false
  const trackUpgrade = (socket: Socket) => {
    if (closing) { socket.destroy(); return false }
    upgrades.add(socket)
    socket.once("close", () => upgrades.delete(socket))
    return true
  }
  app.server.on("upgrade", (request, socket: Socket) => {
    if (!trackUpgrade(socket)) return
    const pathname = routedPath(request.url ?? "/")
    // Only the reviewed content proxies own upgrades; the other control APIs use HTTP/SSE.
    if (!isLiveVoiceRoute(request.url) && !parsePreviewCapabilityHost(request.headers.host) && (pathname === "/api" || pathname?.startsWith("/api/"))) {
      rejectUpgrade(socket, 404, "Not Found")
    }
  })
  app.addHook("preClose", async () => {
    closing = true
    closeSseClients()
    for (const socket of upgrades) socket.destroy()
  })
  app.addHook("onSend", (_request, reply, payload, done) => {
    if (closing) reply.header("Connection", "close")
    done(null, payload)
  })
  app.addHook("onResponse", async () => {
    // Streams can send their keep-alive headers before shutdown starts.
    if (closing) app.server.closeIdleConnections()
  })

  registerRequestLogging(app, apiLogger)

  // Remote Control admission runs before CORS, authentication and routing.
  const remoteGate = deps.remoteControlManager.gate()
  const sidecarOverDirectHttps = createSideCarDirectHttpsAccess({
    meta: deps.serverMeta, allowedOrigins: deps.allowedOrigins, enabled: () => sidecarsOverDirectHttpsEnabled(deps.settings),
  })
  const multiBackendEnabled = () => deps.settings.multiBackendEnabled?.() === true
  const requestGate = { ...remoteGate, allowsDirectSidecar: sidecarOverDirectHttps, allowsBackendUi: multiBackendEnabled }
  const getSelfOrigins = (): Set<string> => {
    const origins = new Set<string>()
    for (const candidate of [deps.serverMeta.localUrl, deps.serverMeta.remoteUrl, ...(deps.serverMeta.addresses ?? []).map(address => address.remoteUrl)]) {
      try { if (candidate) origins.add(new URL(candidate).origin) } catch { /* Ignore unavailable metadata. */ }
    }
    return origins
  }
  hostProxyTargets.set(app.server, target => {
    // A capability's exclusive origin must never be exposed through another proxy.
    if (parsePreviewCapabilityHost(target.host)) return true
    const pathname = routedPath(target.pathname)
    if (pathname !== null && !pathname.startsWith("/api/") && pathname !== "/api"
      && !pathname.startsWith("/workspaces/") && !isHostOnlyPath(pathname, "GET")) return false
    const address = app.server.address()
    const samePort = address && typeof address === "object"
      && Number(target.port || (target.protocol === "https:" ? 443 : 80)) === address.port
    const hostname = target.hostname.replace(/\.$/, "")
    const loopback = isLoopbackHost(hostname) || isWildcardHost(hostname) || hostname.endsWith(".localhost")
    return Boolean(samePort && loopback) || getSelfOrigins().has(target.origin)
      || deps.allowedOrigins?.includes(target.origin) === true
  })
  app.addHook("onRequest", (request, reply, done) => {
    if (guardServerPairRequest(request, reply, remoteGate.directHttpsOrigins?.() ?? [])) return
    if (!gateRemoteRequest(request, reply, requestGate)) done()
  })

  const isLivePreview = (request: FastifyRequest) => {
    // Capability admission belongs to the matched proxy route, never Host alone:
    // explicit application routes take precedence over the host's wildcard route.
    const config = request.routeOptions.config
    if (!("previewCapability" in config) || config.previewCapability !== true) return false
    const pathname = routedPath(request.raw.url ?? "/")
    const token = parsePreviewCapabilityHost(request.headers.host) ?? pathname?.match(/^\/previews\/([^/]+)(?:\/|$)/)?.[1]
    if (!token) return false
    try { return Boolean(deps.previewManager.get(decodeURIComponent(token))) || remotePreviews.servesPath(token) } catch { return false }
  }
  app.addHook("onRequest", (request, reply, done) => {
    if (isLocalRequest(request) || isRemoteRequest(request)) return done()
    const pathname = routedPath(request.raw.url ?? "/")
    if (pathname === null) return reply.header("connection", "close").code(400).send({ error: "Invalid request path" })
    // Browser pairing also answers on verified direct HTTPS origins; its route rechecks the origin.
    const directPairing = pathname === PAIR_EXCHANGE_PATH && verifiedDirectHttpsOrigin(request, remoteGate?.directHttpsOrigins?.() ?? []) !== null
    const backendUi = request.headers["x-codenomad-server-request"] === undefined
      && multiBackendEnabled() && isBackendUiRoute(pathname, request.method)
    if (isHostOnlyPath(pathname, request.method, true) && !isLivePreview(request)
      && !directPairing && !isServerPairExchange(request, pathname) && !backendUi && !(isSideCarContentPath(pathname) && sidecarOverDirectHttps(request))) {
      return reply.header("connection", "close").code(404).send({ error: "Not found" })
    }
    done()
  })
  const allowsDirectSource = registerDirectOriginPolicy(app, {
    meta: deps.serverMeta, allowedOrigins: deps.allowedOrigins, devServerUrl: deps.uiDevServerUrl,
    publicHost: () => remoteGate.publicHost(), isPreview: isLivePreview,
  })
  const backendUiAccess = createBackendUiAccess({
    enabled: multiBackendEnabled, selfOrigins: getSelfOrigins, allowsDirectSource,
    publicHost: () => remoteGate.publicHost(),
    directHttpsOrigins: () => remoteGate.directHttpsOrigins?.() ?? [],
  })
  const remotePrincipals = createRelayPrincipalBinding({
    auth: deps.authManager, devices: deps.remoteControlManager, local: backendUiAccess.localUiRequest,
  })
  app.addHook("onRequest", async (request, reply) => {
    const pathname = routedPath(request.raw.url ?? "")
    // Global diagnostics retain local UI authority even behind a loopback reverse proxy.
    if (pathname === "/api/opencode/logs" && !backendUiAccess.localUiRequest(request))
      return reply.header("connection", "close").code(404).send({ error: "Not found" })
    if (pathname && isBackendUiRoute(pathname, request.method)) {
      // The existing direct server-device memory contract keeps its closed protocol.
      // Every browser memory call uses the same pre-body channel/provenance guard as the relay.
      if (isMemoryRelayRoute(pathname, request.method)
        && !backendUiAccess.localUiRequest(request)
        && request.headers["x-codenomad-server-request"] !== "1" && backendUiAccess.guard(request, reply)) return
      remotePrincipals.bind(request, reply)
    }
  })
  app.addHook("onSend", (request, reply, payload, done) => {
    if (remotePrincipals.signal(request)?.aborted) reply.raw.destroy()
    done(null, payload)
  })
  const liveVoice = deps.liveVoice ?? new LiveVoiceGateway(deps.speechService)
  app.server.on("upgrade", (request, socket: Socket, head) => {
    if (!isLiveVoiceRoute(request.url) || socket.destroyed || socket.writableEnded) return
    try {
      const raw = { raw: request, headers: request.headers }
      const origin = voiceSource(request.headers.origin)
      if (isRemoteRequest(raw) || parsePreviewCapabilityHost(request.headers.host) || !origin || !allowsDirectSource(raw)
        || (!deps.authManager.isAuthEnabled() && (!isLocalRequest(raw) || !isLoopbackHost(origin.hostname)))) {
        return refuseVoiceUpgrade(socket, "403 Forbidden")
      }
      const session = deps.authManager.getSessionFromHeaders(request.headers)
      if (!session) return refuseVoiceUpgrade(socket, "401 Unauthorized")
      liveVoice.upgrade(request, socket, head, {
        identity: `direct:${session.username}`,
        watchRevocation: stop => deps.authManager.watchSessionRevocation(session.sessionId, stop),
      })
    } catch { socket.destroy() }
  })
  const remoteVoiceUpgrade = (request: import("http").IncomingMessage, socket: Socket, head: Buffer, deviceId: string) => {
    if (!trackUpgrade(socket)) return
    liveVoice.upgrade(request, socket, head, { identity: `remote-device:${deviceId}` })
  }

  app.register(replyFrom, {
    contentTypesToEncode: [],
    undici: {
      connect: proxyConnector,
      connections: 16,
      pipelining: 1,
      bodyTimeout: 0,
      headersTimeout: 0,
    },
  })

  registerAuthRoutes(app, { authManager: deps.authManager })

  app.addHook("preHandler", (request, reply, done) => {
    // Judge the path the router routed: the raw target can differ ("/%61pi" routes as "/api").
    const pathname = routedPath(request.raw.url ?? request.url)
    if (pathname === null) {
      reply.code(400).send({ error: "Invalid request path" })
      return
    }

    // Pairing routes answer through the Remote Control ingress and verified direct HTTPS origins.
    const publicApiPaths = new Set(["/api/auth/login", "/api/auth/token", "/api/auth/status", "/api/auth/logout", PAIR_EXCHANGE_PATH, SERVER_PAIR_PATH])
    const publicPagePaths = new Set(["/login", PAIR_PAGE_PATH])
    if (deps.authManager.isTokenBootstrapEnabled()) {
      publicPagePaths.add("/auth/token")
    }

    const isLoopbackRemoteProxyDelete =
      request.method === "DELETE" &&
      pathname.startsWith("/api/remote-proxy/sessions/") &&
      deps.authManager.isLoopbackRequest(request)

    const isPreviewCapability = isLivePreview(request)

    if (request.headers.origin === "null" && !isPreviewCapability) {
      reply.code(403).send({ error: "Opaque origins may access preview capabilities only" })
      return
    }

    const isAutomationBridge = isAutomationPluginRequest(request, {
      authManager: deps.authManager,
      bridgeToken: deps.automationBridgeToken,
    })
    if (publicApiPaths.has(pathname) || publicPagePaths.has(pathname) || isLoopbackRemoteProxyDelete || isPreviewCapability || isAutomationBridge) {
      done()
      return
    }

    const session = deps.authManager.getSessionFromRequest(request)

    const requiresAuthForApi = pathname.startsWith("/api/") || pathname.startsWith("/workspaces/") || pathname.startsWith("/sidecars/") || pathname.startsWith("/previews/")
    if (requiresAuthForApi && !session) {
      sendUnauthorized(request, reply)
      return
    }

    if (!session && (wantsHtml(request) || isHtmlBundlePath(pathname))) {
      reply.redirect("/login")
      return
    }

    done()
  })

  const uiEntry = findUiEntry(deps.uiStaticDir)
  app.get("/", async (request, reply) => {
    const session = deps.authManager.getSessionFromRequest(request)
    if (!session) {
      reply.redirect("/login")
      return
    }

    if (deps.uiDevServerUrl) {
      await proxyToDevServer(request, reply, deps.uiDevServerUrl)
      return
    }

    const uiDir = deps.uiStaticDir
    const indexPath = path.join(uiDir, uiEntry)
    if (uiDir && fs.existsSync(indexPath)) {
      reply.header("cache-control", "no-store")
      if (reply.sendFile) return reply.sendFile(uiEntry, { cacheControl: false })
      reply.type("text/html").send(fs.readFileSync(indexPath, "utf-8"))
      return
    }

    reply.code(404).send({ message: "UI bundle missing" })
  })

  const worktreeDeletionFence = deps.worktreeDeletionFence ?? new WorktreeDeletionFence()
  registerWorkspaceRoutes(app, { workspaceManager: deps.workspaceManager, worktreeDeletionFence })
  registerRepositorySourceRoute(app, { workspaceManager: deps.workspaceManager, worktreeDeletionFence, forge: forgeWorkItems })
  registerTemporaryWorkspaceRoutes(app, { workspaceManager: deps.workspaceManager, worktreeDeletionFence, eventBus: deps.eventBus })
  const configurationControls = new PluginControls({ workspaceManager: deps.workspaceManager, worktreeDeletionFence, logger: apiLogger })
  registerPluginControlRoutes(app, { controls: configurationControls })
  const integrationCatalog = deps.integrationCatalog ?? new IntegrationCatalogSource({ logger: apiLogger })
  const integrations = new IntegrationsReader({ controls: configurationControls, workspaceManager: deps.workspaceManager, catalog: integrationCatalog })
  const pluginSources = new PluginSources({ documents: configurationControls, logger: apiLogger, catalog: integrationCatalog })
  registerPluginSourceRoutes(app, { sources: pluginSources })
  registerIntegrationRoutes(app, { integrations })
  registerIntegrationInstallRoutes(app, { installer: new IntegrationInstaller({ controls: configurationControls, workspaceManager: deps.workspaceManager, catalog: integrationCatalog, sources: pluginSources }) })
  registerIntegrationAttachmentRoutes(app, { attachments: new IntegrationAttachments({ controls: configurationControls, workspaceManager: deps.workspaceManager, catalog: integrationCatalog }) })
  registerWebSearchSettingsRoutes(app, new WebSearchSettings(configurationControls))
  const subagentDepth = new SubagentDepthSettings(configurationControls, deps.workspaceManager)
  registerSubagentDepthSettingsRoutes(app, subagentDepth)
  const imageSettings = new ImageSettings(configurationControls, deps.workspaceManager)
  registerImageSettingsRoutes(app, imageSettings)
  registerServiceUsageRoutes(app, new ServiceUsage(deps.workspaceManager, deps.settings))
  const loginStart = createOpenCodeLoginStart(deps.settings, deps.workspaceManager)
  registerOpenCodeLoginStartRoutes(app, { loginStart, auth: deps.authManager, remoteDevices: deps.remoteControlManager })
  const memory = deps.memoryStore ? new MemoryService(deps.memoryStore, deps.settings, deps.workspaceManager, deps.eventBus) : undefined
  if (memory) registerMemoryRoutes(app, memory, remotePrincipals.signal)
  registerSettingsRoutes(app, { settings: deps.settings, logger: apiLogger, refreshLoginStart: () => loginStart.refresh(),
    withConfigLock: memory ? action => memory.withSettingsLock(action) : undefined,
    guardServerProfiles: backendUiAccess.guardProfiles, principalSignal: remotePrincipals.signal })
  const accounts = new ProviderAccountsService(deps.settings)
  const freeUsage = createOpenCodeFreeUsage()
  const stopQuotaObserver = observeProviderQuotaFailures(deps.eventBus, accounts)
  app.addHook("onClose", async () => { stopQuotaObserver(); freeUsage.dispose() })
  registerProviderAccountsRoutes(app, { accounts, workspaceManager: deps.workspaceManager, worktreeDeletionFence })
  registerOpenCodeUpdateRoutes(app, {
    service: createOpenCodeUpdateService(deps.settings, deps.workspaceManager, loginStart),
    logger: apiLogger,
  })
  const logBinaryResolver = new BinaryResolver(deps.settings)
  registerOpenCodeLogsRoutes(app, { resolveBinary: () => deps.workspaceManager.resolveBinaryPath(logBinaryResolver.resolveDefault().path) })
  registerFilesystemRoutes(app, { fileSystemBrowser: deps.fileSystemBrowser })
  registerConfigFileRoutes(app)
  const remotePreviewsAllowed = () => deps.remoteControlManager.previewsAllowed()
  registerMetaRoutes(app, { serverMeta: deps.serverMeta, remotePreviewsAllowed, sidecarsOverDirectHttps: sidecarOverDirectHttps,
    backendUiCapabilities: backendUiAccess.capabilities })
  registerEventRoutes(app, {
    eventBus: deps.eventBus,
    registerClient: registerSseClient,
    logger: sseLogger,
    connectionManager: deps.clientConnectionManager,
  })
  registerWorktreeRoutes(app, { workspaceManager: deps.workspaceManager, worktreeDeletionFence })
  registerPendingRequestRoutes(app, { workspaceManager: deps.workspaceManager, worktreeDeletionFence, logger: apiLogger })
  registerStorageRoutes(app, {
    instanceStore: deps.instanceStore,
    eventBus: deps.eventBus,
    workspaceManager: deps.workspaceManager,
  })
  registerRemoteServerRoutes(app, { logger: apiLogger, guardCaller: backendUiAccess.guard, principalSignal: remotePrincipals.signal })
  const remoteServerBrowse = deps.remoteServerBrowseManager ?? new RemoteServerBrowseManager(deps.settings)
  registerRemoteServerBrowseRoutes(app, { manager: remoteServerBrowse, getSelfOrigins, guardCaller: backendUiAccess.guard,
    guardSecret: backendUiAccess.guardSecret, principalSignal: remotePrincipals.signal })
  registerBackendRelayRoutes(app, { manager: remoteServerBrowse, getSelfOrigins, guardCaller: backendUiAccess.guard,
    guardSecret: backendUiAccess.guardSecret, principalSignal: remotePrincipals.signal })
  const remotePreviews = registerRemotePreviewCapabilityRoutes(app, { manager: remoteServerBrowse, getSelfOrigins, logger: deps.logger,
    remote: { local: backendUiAccess.localUiRequest, guard: backendUiAccess.guard, principal: request => {
      const host = request.headers.host
      // The Web previews switch governs paired devices, at creation and for every later request.
      return host ? remotePrincipals.lifetime(request, host) : null
    } } })
  const reconcileBackends = () => remoteServerBrowse.reconcile()
  if (!deps.remoteServerBrowseManager) deps.eventBus.on("storage.stateChanged", reconcileBackends)
  app.addHook("onClose", async () => {
    if (!deps.remoteServerBrowseManager) {
      deps.eventBus.off("storage.stateChanged", reconcileBackends)
      remoteServerBrowse.close()
    }
  })
  registerRemoteProxyRoutes(app, { logger: proxyLogger, sessionManager: deps.remoteProxySessionManager })
  registerRemoteControlRoutes(app, { manager: deps.remoteControlManager })
  registerSpeechRoutes(app, { speechService: deps.speechService })
  registerSideCarRoutes(app, { sidecarManager: deps.sidecarManager })
  registerPreviewRoutes(app, { previewManager: deps.previewManager })
  const developerCdp = new DeveloperCdp()
  const permissionModes = deps.sessionPermissions?.modes ?? new SessionPermissionModes(deps.settings)
  const scheduleSettingsActivation = new NativeScheduleSettingsActivation(configurationControls, deps.workspaceManager)
  registerAutomationPluginRoute(app, {
    permissionModes,
    subagentDepth,
    forge: forgeWorkItems,
    memory,
    authManager: deps.authManager,
    settings: deps.settings,
    bridgeToken: deps.automationBridgeToken,
    worktreeDeletionFence,
    nativeParent: deps.nativeParent,
    developerCdp,
    workspaceManager: deps.workspaceManager,
    scheduleSettingsActivation,
    scheduleCapability: new NativeScheduleCapabilityReader(configurationControls, deps.workspaceManager),
    remoteDevices: deps.remoteControlManager,
  })
  app.addHook("onClose", async () => developerCdp.close())
  registerUsageRoutes(app, { workspaceManager: deps.workspaceManager, freeUsage })
  const missionActivityCache = new MissionActivityCache()
  const stopMissionActivityCache = connectMissionActivityCache(deps.eventBus, missionActivityCache)
  app.addHook("onClose", async () => stopMissionActivityCache())
  registerMissionRoutes(app, { workspaceManager: deps.workspaceManager, worktreeDeletionFence, settings: deps.settings, activityCache: missionActivityCache,
    permissionModes,
    scheduleSettingsActivation,
    scheduleCapability: new NativeScheduleCapabilityReader(configurationControls, deps.workspaceManager),
    auth: deps.authManager, bridgeToken: deps.automationBridgeToken, remoteDevices: deps.remoteControlManager,
    missionsHost: deps.missionsHost })
  registerMissionRecurrenceControl(app, { auth: deps.authManager, manager: deps.workspaceManager,
    settings: deps.settings, bridgeToken: deps.automationBridgeToken, fence: worktreeDeletionFence, remoteDevices: deps.remoteControlManager })
  registerMissionRecurrenceControlStatus(app, { auth: deps.authManager, manager: deps.workspaceManager, fence: worktreeDeletionFence,
    remoteDevices: deps.remoteControlManager })
  registerMissionRecurrenceManual(app, { auth: deps.authManager, manager: deps.workspaceManager,
    settings: deps.settings, bridgeToken: deps.automationBridgeToken, fence: worktreeDeletionFence, remoteDevices: deps.remoteControlManager })
  if (deps.panelExtensions) registerPanelExtensionRoutes(app, { store: deps.panelExtensions, workspaceManager: deps.workspaceManager })
  if (deps.panelExtensions) registerPanelExtensionAssetRoutes(app, { store: deps.panelExtensions, workspaceManager: deps.workspaceManager, worktreeDeletionFence })
  if (deps.panelExtensions) registerPanelExtensionWorkItemRoutes(app, { store: deps.panelExtensions, workspaceManager: deps.workspaceManager, forge: forgeWorkItems })
  if (deps.panelExtensions) registerPanelExtensionApi4Routes(app, { store: deps.panelExtensions, workspaceManager: deps.workspaceManager, worktreeDeletionFence, imageSettings, permissionModes })
  registerSideCarProxyRoutes(app, { sidecarManager: deps.sidecarManager, logger: proxyLogger, authManager: deps.authManager })
  registerPreviewProxyRoutes(app, { previewManager: deps.previewManager, remotePreviews, logger: proxyLogger })
  setupSideCarWebSocketProxy(app, {
    sidecarManager: deps.sidecarManager,
    authManager: deps.authManager,
    logger: proxyLogger,
    allowsSource: request => allowsDirectSource({ raw: request, headers: request.headers }),
    overDirectHttps: request => sidecarOverDirectHttps({ raw: request, method: request.method ?? "GET", headers: request.headers }),
  })
  const previewUpgrade = setupPreviewWebSocketProxy(app, {
    previewManager: deps.previewManager,
    remotePreviews,
    authManager: deps.authManager,
    logger: proxyLogger,
  })
  if (deps.permissionReceipts) registerPermissionReceiptRoutes(app, deps.permissionReceipts)
  registerSessionPruningRoutes(app, { workspaceManager: deps.workspaceManager, worktreeDeletionFence })
  registerImagesConversationRoute(app, { workspaceManager: deps.workspaceManager, worktreeDeletionFence, permissionModes })
  registerSessionGoalRoute(app, { workspaceManager: deps.workspaceManager })
  const sessionCleanup = deps.sessionPermissions?.cleanup ?? new SessionCleanupFence()
  if (!deps.sessionPermissions) {
    const stopPermissionRefresh = connectSessionPermissionRefresh(deps.eventBus, deps.workspaceManager, permissionModes,
      worktreeDeletionFence, sessionCleanup, apiLogger)
    app.addHook("onClose", async () => stopPermissionRefresh())
  }
  registerSessionPermissionModeRoutes(app, { workspaceManager: deps.workspaceManager, modes: permissionModes, worktreeDeletionFence, cleanup: sessionCleanup })
  const isProtected = registerSessionFavoritesRoutes(app, { workspaceManager: deps.workspaceManager, settings: deps.settings, eventBus: deps.eventBus, cleanup: sessionCleanup })
  registerSessionCleanupRoute(app, { workspaceManager: deps.workspaceManager, worktreeDeletionFence, cleanup: sessionCleanup, isProtected })
  registerBackgroundShellRoutes(app, deps.workspaceManager)
  registerSessionMediaRoutes(app, { workspaceManager: deps.workspaceManager })
  registerInstanceProxyRoutes(app, { workspaceManager: deps.workspaceManager, logger: proxyLogger, worktreeDeletionFence, accounts, memory, permissionReceipts: deps.permissionReceipts, sessionCleanup, permissionModes,
    humanAnswers: { auth: deps.authManager, manager: deps.workspaceManager, settings: deps.settings, bridgeToken: deps.automationBridgeToken,
      remoteDevices: deps.remoteControlManager } })


  if (deps.uiDevServerUrl) {
    setupDevProxy(app, deps.uiDevServerUrl, deps.authManager, deps.previewManager, proxyLogger, remotePreviewsAllowed)
  } else {
    setupStaticUi(app, deps.uiStaticDir, uiEntry, deps.authManager, deps.previewManager, proxyLogger, remotePreviewsAllowed,
      request => isRemoteSocket(request.raw.socket) || request.protocol === "https" ? "https"
        : verifiedDirectServerOrigin(request, remoteGate.directHttpsOrigins?.() ?? []) ? "either" : "http")
  }

  return {
    instance: app,
    previewUpgrade,
    /** Remote Control admits these remote-client path capabilities beside local previews. */
    servesRemotePreview: (token: string) => remotePreviews.servesPath(token),
    remoteVoiceUpgrade,
    start: async (): Promise<HttpServerStartResult> => {
      const attemptListen = async (requestedPort: number) => {
        const dualStackWildcard = isWildcardHost(deps.bindHost) && isIP(stripHostBrackets(deps.bindHost)) === 6
        const addressInfo = await app.listen({ port: requestedPort, host: deps.bindHost, ...(dualStackWildcard ? { ipv6Only: false } : {}) })
        return { addressInfo, requestedPort }
      }

      const autoPortRequested = deps.bindPort === 0
      const primaryPort = autoPortRequested ? deps.defaultPort : deps.bindPort

      let listenResult

      try {
        listenResult = await attemptListen(primaryPort)
      } catch (error) {
        if (!shouldRetryPreferredPort(error, autoPortRequested)) {
          throw error
        }
        deps.logger.warn({ err: error, port: primaryPort }, "Preferred port unavailable, retrying on ephemeral port")
        listenResult = await attemptListen(0)
      }

      let actualPort = listenResult.requestedPort

      if (typeof listenResult.addressInfo === "string") {
        try {
          const parsed = new URL(listenResult.addressInfo)
          actualPort = Number(parsed.port) || listenResult.requestedPort
        } catch {
          actualPort = listenResult.requestedPort
        }
      } else {
        const address = app.server.address()
        if (typeof address === "object" && address) {
          actualPort = address.port
        }
      }

      const displayHost = deps.bindHost === "127.0.0.1" ? "localhost" : formatHostForUrl(deps.bindHost)
      const serverUrl = `${deps.protocol}://${displayHost}:${actualPort}`

      deps.logger.info({ port: actualPort, host: deps.bindHost, protocol: deps.protocol }, "HTTP server listening")

      return { port: actualPort, url: serverUrl, displayHost }
    },
    stop: () => app.close(),
  }
}

export interface InstanceProxyWorkspaceManager {
  captureWorkspaceOperation?: WorkspaceManager["captureWorkspaceOperation"]
  getServiceWslDistro?: WorkspaceManager["getServiceWslDistro"]
  get(id: string): ReturnType<WorkspaceManager["get"]>
  getSharedServiceEndpoint(id: string): ReturnType<WorkspaceManager["getSharedServiceEndpoint"]>
  getSharedServiceConnection?(id: string): ReturnType<WorkspaceManager["getSharedServiceConnection"]>
  getSharedServiceFetch?(): Promise<typeof globalThis.fetch>
  invalidateSharedServiceConnection?(): void
  getInstanceAuthorizationHeader(id: string): string | undefined
  getServiceDirectory?(id: string): string | undefined
  getServiceDirectoryForPath?(id: string, directory: string): Promise<string | undefined>
  getWorktreeIdentityForPath(id: string, directory: string): Promise<string | undefined>
  getServicePathForPath?(id: string, candidate: string): Promise<string | undefined>
  getSharedServiceClient(): Promise<OpenCodeClient>
  getSessionEnvironment(id: string, signal?: AbortSignal): Promise<Record<string, string>>
  desktopPluginsReady?(): Promise<void>
  ownsLocation: WorkspaceManager["ownsLocation"]
  resolveLocationPlacement?: WorkspaceManager["resolveLocationPlacement"]
  ownsDirectory(id: string, directory: string): Promise<boolean>
  ownsPath(id: string, candidate: string): Promise<boolean>
}

interface InstanceProxyDeps {
  permissionModes?: SessionPermissionModes
  sessionCleanup?: SessionCleanupFence
  workspaceManager: InstanceProxyWorkspaceManager
  logger: Logger
  worktreeDeletionFence: WorktreeDeletionFence
  accounts?: ProviderAccountsService
  memory?: MemoryService
  permissionReceipts?: PermissionReceipts
  humanAnswers?: Parameters<typeof replyMissionHumanAnswer>[4]
}

interface SideCarProxyDeps {
  sidecarManager: SideCarManager
  logger: Logger
  authManager: AuthManager
}

interface SideCarWebSocketProxyDeps extends SideCarProxyDeps {
  allowsSource(request: import("http").IncomingMessage): boolean
  /** The host's opt-in for non-local upgrades from a verified direct HTTPS origin. */
  overDirectHttps(request: import("http").IncomingMessage): boolean
}

interface PreviewProxyDeps {
  previewManager: PreviewManager
  remotePreviews: Pick<RemotePreviewCapabilities, "servesPath" | "servePath" | "upgradePath">
  logger: Logger
}

interface PreviewWebSocketProxyDeps extends PreviewProxyDeps {
  authManager: AuthManager
}

function registerSideCarProxyRoutes(app: FastifyInstance, deps: SideCarProxyDeps) {
  const proxyBaseHandler = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    await proxySideCarRequest({
      request,
      reply,
      sidecarManager: deps.sidecarManager,
      logger: deps.logger,
      sessionCookie: deps.authManager.getCookieName(),
      pathSuffix: "",
    })
  }

  const proxyWildcardHandler = async (
    request: FastifyRequest<{ Params: { id: string; "*": string } }>,
    reply: FastifyReply,
  ) => {
    await proxySideCarRequest({
      request,
      reply,
      sidecarManager: deps.sidecarManager,
      logger: deps.logger,
      sessionCookie: deps.authManager.getCookieName(),
      pathSuffix: reencodePercent(request.params["*"] ?? ""),
    })
  }

  app.register(async (sidecarApp) => {
    // Like the instance proxy, a SideCar's bodiless DELETE or OPTIONS passes as such even when it declares JSON.
    const parseJson = sidecarApp.getDefaultJsonParser("error", "error")
    sidecarApp.removeContentTypeParser("application/json")
    sidecarApp.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
      if (framesNoBody(request)) done(null, undefined)
      else parseJson(request, body.toString(), done)
    })
    sidecarApp.all("/sidecars/:id", proxyBaseHandler)
    sidecarApp.all("/sidecars/:id/*", proxyWildcardHandler)
  })
}

function registerPreviewProxyRoutes(app: FastifyInstance, deps: PreviewProxyDeps) {
  app.register(async (previewApp) => {
    previewApp.removeAllContentTypeParsers()
    previewApp.addContentTypeParser("*", (_request, body, done) => done(null, body))
    const capabilityHost = /^[0-9a-f-]{36}\.preview\.localhost(?::\d+)?$/i
    const hostHandler = async (request: FastifyRequest, reply: FastifyReply) => {
      const token = parsePreviewCapabilityHost(request.headers.host)
      if (!token) return reply.code(404).send({ error: "Preview not found" })
      const pathname = (request.raw.url ?? request.url ?? "/").split("?")[0] ?? "/"
      await proxyPreviewRequest({
        request,
        reply,
        previewManager: deps.previewManager,
        logger: deps.logger,
        token,
        publicBase: "",
        pathSuffix: pathname.replace(/^\/+/, ""),
      })
    }

    const config = { previewCapability: true }
    // Remote clients' capabilities share this path chain through the remote-content adapter.
    const remote = (request: FastifyRequest, reply: FastifyReply) => {
      if (deps.previewManager.get((request.params as { token: string }).token) || !deps.remotePreviews.servesPath((request.params as { token: string }).token)) return false
      reply.hijack()
      if (!deps.remotePreviews.servePath(request.raw, reply.raw)) reply.raw.writeHead(404, { connection: "close", "content-length": "0" }).end()
      return true
    }
    previewApp.all("/", { config, constraints: { host: capabilityHost } }, hostHandler)
    previewApp.all("/*", { config, constraints: { host: capabilityHost } }, hostHandler)
    previewApp.all("/previews/:token", { config }, async (request: FastifyRequest<{ Params: { token: string } }>, reply) => {
      if (remote(request, reply)) return
      await proxyPreviewRequest({ request, reply, previewManager: deps.previewManager, logger: deps.logger, pathSuffix: "" })
    })
    previewApp.all("/previews/:token/*", { config }, async (request: FastifyRequest<{ Params: { token: string; "*": string } }>, reply) => {
      if (remote(request, reply)) return
      await proxyPreviewRequest({
        request,
        reply,
        previewManager: deps.previewManager,
        logger: deps.logger,
        pathSuffix: reencodePercent(request.params["*"] ?? ""),
      })
    })
  })
}

/**
 * Wildcard parameters arrive percent-decoded. A literal "%" in one (sent as
 * "%25") is escaped again so the target URL decodes back to it; every other
 * character keeps the form the URL parser gives it ("@vite/client" stays raw).
 */
function reencodePercent(decoded: string): string {
  return decoded.replaceAll("%", "%25")
}

/**
 * @fastify/reply-from validates a target by decoding it whole, so a query with
 * a raw "%" ("?q=50%") would fail. The target travels without its query, and the
 * query, as the URL parser serialized it, is appended unchanged.
 */
function withoutQuery(target: string): { url: string; query: string } {
  const url = new URL(target)
  const query = url.search.slice(1)
  url.search = ""
  return { url: url.href, query }
}

function setupSideCarWebSocketProxy(app: FastifyInstance, deps: SideCarWebSocketProxyDeps) {
  app.server.on("upgrade", (request, socket, head) => {
    if (socket.destroyed || socket.writableEnded) return
    if (parsePreviewCapabilityHost(request.headers.host)) return
    const rawUrl = request.url ?? "/"
    const parsed = parseSideCarUpgradePath(rawUrl)
    if (!parsed) {
      return
    }
    if (!isLocalRequest({ raw: request }) && !deps.overDirectHttps(request)) {
      rejectUpgrade(socket as Socket, 404, "Not Found")
      return
    }
    // Upgrades bypass Fastify hooks; use the HTTP mutation source policy before proxying.
    if (!deps.allowsSource(request)) {
      rejectUpgrade(socket as Socket, 403, "Forbidden")
      return
    }

    void proxySideCarWebSocketUpgrade({
      request,
      socket: socket as Socket,
      head,
      sidecarId: parsed.sidecarId,
      incomingPath: parsed.pathname,
      search: parsed.search,
      sidecarManager: deps.sidecarManager,
      authManager: deps.authManager,
      logger: deps.logger,
      server: app.server,
    })
  })
}

type PreviewUpgrade = (request: import("http").IncomingMessage, socket: Socket, head: Buffer) => boolean

/** Returns the path-preview upgrade handler, which Remote Control reuses for the previews it serves. */
function setupPreviewWebSocketProxy(app: FastifyInstance, deps: PreviewWebSocketProxyDeps): PreviewUpgrade {
  const proxy = (request: import("http").IncomingMessage, socket: Socket, head: Buffer, parsed: { token: string; pathname: string; search: string }) => {
    void proxyPreviewWebSocketUpgrade({
      request,
      socket,
      head,
      token: parsed.token,
      incomingPath: parsed.pathname,
      search: parsed.search,
      previewManager: deps.previewManager,
      authManager: deps.authManager,
      logger: deps.logger,
      server: app.server,
    })
  }
  app.server.on("upgrade", (request, socket, head) => {
    if (socket.destroyed || socket.writableEnded) return
    const rawUrl = request.url ?? "/"
    if (isLiveVoiceRoute(rawUrl)) return
    const capabilityToken = parsePreviewCapabilityHost(request.headers.host)
    let parsed = parsePreviewUpgradePath(rawUrl)
    if (capabilityToken) {
      try {
        const url = new URL(rawUrl, "http://localhost")
        parsed = { token: capabilityToken, pathname: url.pathname, search: url.search }
      } catch {
        rejectUpgrade(socket as Socket, 400, "Bad Request")
        return
      }
    }
    if (!parsed) {
      return
    }
    if (!capabilityToken && !deps.previewManager.get(parsed.token) && deps.remotePreviews.upgradePath(request, socket as Socket, head)) return
    proxy(request, socket as Socket, head, parsed)
  })
  return (request, socket, head) => {
    const parsed = parsePreviewUpgradePath(request.url ?? "/")
    if (!parsed) return false
    if (!deps.previewManager.get(parsed.token) && deps.remotePreviews.upgradePath(request, socket, head)) return true
    proxy(request, socket, head, parsed)
    return true
  }
}

export function registerInstanceProxyRoutes(app: FastifyInstance, deps: InstanceProxyDeps) {
  app.register(async (instance) => {
    instance.removeAllContentTypeParsers()
    instance.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
      if (framesNoBody(req)) {
        done(null, undefined)
        return
      }
      try {
        done(null, body.length ? JSON.parse(body.toString()) : {})
      } catch {
        done(Object.assign(new Error("Invalid JSON request body"), { statusCode: 400 }), undefined)
      }
    })
    instance.addContentTypeParser("*", (req, body, done) => done(null, framesNoBody(req) ? undefined : body))

    const proxyBaseHandler = async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      await proxyWorkspaceRequest({
        request,
        reply,
        workspaceManager: deps.workspaceManager,
        worktreeDeletionFence: deps.worktreeDeletionFence,
        accounts: deps.accounts,
        memory: deps.memory,
        permissionReceipts: deps.permissionReceipts,
        permissionModes: deps.permissionModes,
        humanAnswers: deps.humanAnswers,
        sessionCleanup: deps.sessionCleanup,
        pathSuffix: "",
        logger: deps.logger,
      })
    }

    const proxyWildcardHandler = async (
      request: FastifyRequest<{ Params: { id: string; "*": string } }>,
      reply: FastifyReply,
    ) => {
      await proxyWorkspaceRequest({
        request,
        reply,
        workspaceManager: deps.workspaceManager,
        worktreeDeletionFence: deps.worktreeDeletionFence,
        accounts: deps.accounts,
        memory: deps.memory,
        permissionReceipts: deps.permissionReceipts,
        permissionModes: deps.permissionModes,
        humanAnswers: deps.humanAnswers,
        sessionCleanup: deps.sessionCleanup,
        pathSuffix: request.params["*"] ?? "",
        logger: deps.logger,
      })
    }

    const proxyPromptHandler = async (
      request: FastifyRequest<{ Params: { id: string; sessionId: string } }>,
      reply: FastifyReply,
    ) => {
      await proxyWorkspaceRequest({
        request,
        reply,
        workspaceManager: deps.workspaceManager,
        worktreeDeletionFence: deps.worktreeDeletionFence,
        accounts: deps.accounts,
        memory: deps.memory,
        permissionReceipts: deps.permissionReceipts,
        permissionModes: deps.permissionModes,
        humanAnswers: deps.humanAnswers,
        sessionCleanup: deps.sessionCleanup,
        pathSuffix: `api/session/${encodeURIComponent(request.params.sessionId)}/prompt`,
        logger: deps.logger,
      })
    }

    instance.addHook("preParsing", (request, _reply, payload, done) => {
      if (request.method === "POST") {
        const pathOnly = routedPath(request.raw.url ?? "") ?? (request.raw.url ?? "").split(/[?;]/, 1)[0] ?? ""
        if (/^\/workspaces\/[^/]+\/instance\/api\/session\/[^/]+\/(?:prompt|command)\/\/+$/.test(pathOnly)) {
          // Skip JSON parsing, media-type validation, and body-limit rejection for disallowed
          // double-slash variants so auth (401), workspace lookup (404), and allowlist (403) run in order.
          delete request.headers["content-length"]
          delete request.headers["content-type"]
          done(null, Readable.from([]))
          return
        }
      }
      done(null, payload)
    })

    instance.setErrorHandler((error, request, reply) => {
      const pathOnly = routedPath(request.raw.url ?? "") ?? (request.raw.url ?? "").split(/[?;]/, 1)[0] ?? ""
      const isSendInput = request.method === "POST"
        && /^\/workspaces\/[^/]+\/instance\/api\/session\/[^/]+\/(?:prompt|command)\/?$/.test(pathOnly)
      const statusCode = (error as { statusCode?: unknown } | undefined)?.statusCode
      if (isSendInput && typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
        reply.header("x-codenomad-before-dispatch", "1")
        if (error instanceof UnsupportedOpenCodeError) {
          return reply.code(statusCode).send({
            error: error.code,
            message: error.message,
            actualVersion: error.actualVersion,
            minimumVersion: error.minimumVersion,
            reason: error.reason,
          })
        }
        return reply.send(error)
      }
      throw error
    })

    instance.post(
      "/workspaces/:id/instance/api/session/:sessionId/prompt",
      { bodyLimit: PROMPT_INLINE_FILE_LIMITS.maxRequestBodyBytes },
      proxyPromptHandler,
    )
    instance.post(
      "/workspaces/:id/instance/api/session/:sessionId/prompt/",
      { bodyLimit: PROMPT_INLINE_FILE_LIMITS.maxRequestBodyBytes },
      proxyPromptHandler,
    )
    instance.all("/workspaces/:id/instance", proxyBaseHandler)
    instance.all("/workspaces/:id/instance/*", proxyWildcardHandler)
  })
}

interface InstanceProxyRequestArgs {
  permissionModes?: SessionPermissionModes
  sessionCleanup?: SessionCleanupFence
  request: FastifyRequest
  reply: FastifyReply
  workspaceManager: InstanceProxyWorkspaceManager
  worktreeDeletionFence: WorktreeDeletionFence
  accounts?: ProviderAccountsService
  memory?: MemoryService
  permissionReceipts?: PermissionReceipts
  humanAnswers?: Parameters<typeof replyMissionHumanAnswer>[4]
  logger: Logger
  pathSuffix?: string
}

async function proxyWorkspaceRequest(args: InstanceProxyRequestArgs) {
  const admission = requestAdmission(args.request, args.reply)
  let releaseSessionMutation: (() => void) | undefined
  const releaseSession = () => { releaseSessionMutation?.(); releaseSessionMutation = undefined }
  try {
    admission.signal.throwIfAborted()
    return await proxyWorkspaceAdmission(args, admission, id => {
      if (!args.sessionCleanup) return true
      releaseSessionMutation = args.sessionCleanup.enterMutation(id)
      return Boolean(releaseSessionMutation)
    }, releaseSession)
  } catch (error) {
    if (!admission.signal.aborted) throw error
  } finally {
    releaseSession()
    admission.dispose()
  }
}

function deepJsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((item, index) => deepJsonEqual(item, right[index]))
  }
  const leftKeys = Object.keys(left as Record<string, unknown>).filter(key => (left as Record<string, unknown>)[key] !== undefined)
  const rightKeys = Object.keys(right as Record<string, unknown>).filter(key => (right as Record<string, unknown>)[key] !== undefined)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(key =>
    Object.prototype.hasOwnProperty.call(right, key)
    && deepJsonEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
  )
}

function sameSessionTarget(
  initial: {
    id: string
    location: LocationRef
    projectID?: string | null
    parentID?: string | null
    fork?: unknown
    time?: { created?: number | null }
  },
  current: {
    id: string
    location: LocationRef
    projectID?: string | null
    parentID?: string | null
    fork?: unknown
    time?: { created?: number | null }
  },
): boolean {
  return current.id === initial.id
    && deepJsonEqual(current.location, initial.location)
    && (current.projectID ?? null) === (initial.projectID ?? null)
    && (current.parentID ?? null) === (initial.parentID ?? null)
    && deepJsonEqual(current.fork ?? null, initial.fork ?? null)
    && (current.time?.created ?? null) === (initial.time?.created ?? null)
}

async function proxyWorkspaceAdmission(args: InstanceProxyRequestArgs, admission: ReturnType<typeof requestAdmission>,
  enterSessionMutation: (id: string) => boolean, releaseSession: () => void) {
  const { request, reply, workspaceManager, logger, worktreeDeletionFence } = args
  const { signal } = admission
  const wait = admission.wait
  const workspaceId = (request.params as { id: string }).id
  const workspace = workspaceManager.get(workspaceId)
  const rawRoutePath = args.pathSuffix ? `/${args.pathSuffix.replace(/^\/+/, "")}` : ""
  const earlyPromptOrCommandPost = request.method === "POST"
    && /^\/api\/session\/[^/]+\/(?:prompt|command)\/?$/.test(rawRoutePath)
  let markBeforeDispatch = earlyPromptOrCommandPost
  const sendPreDispatch = (statusCode: number, payload: Record<string, unknown>) =>
    (markBeforeDispatch ? reply.header("x-codenomad-before-dispatch", "1") : reply).code(statusCode).send(payload)
  const sendUnavailableBeforeSend = () =>
    sendPreDispatch(502, { error: "opencode_unavailable_before_send" })

  if (!workspace) {
    sendPreDispatch(404, { error: "Workspace not found" })
    return
  }

  const rawInstancePath = (request.raw.url ?? "").split(/[?;]/, 1)[0]?.match(/\/instance(?:\/(.*))?$/)?.[1] ?? ""
  if (/\\|%2f|%5c/i.test(rawInstancePath) || hasDotSegment(rawInstancePath)) {
    sendPreDispatch(400, { error: "Invalid workspace instance path" })
    return
  }
  const routeUrl = buildInstanceTargetUrl("http://127.0.0.1", args.pathSuffix)
  if (!routeUrl) {
    sendPreDispatch(400, { error: "Invalid workspace instance path" })
    return
  }
  const pathname = decodeURIComponent(routeUrl.pathname)
  if (!isAllowedInstanceApiRoute(request.method, pathname)) {
    sendPreDispatch(403, { error: "OpenCode route is not available through a workspace" })
    return
  }
  const isPromptOrCommandPost = request.method === "POST"
    && /^\/api\/session\/[^/]+\/(?:prompt|command)\/?$/.test(pathname)
  markBeforeDispatch = isPromptOrCommandPost
  const kind = controlKind(request.method, pathname.replace(/\/+$/, ""))
  const sessionControl = kind && !isGlobalFormAction(pathname, request.method) ? kind : undefined
  const workspaceOperation = sessionControl ? workspaceManager.captureWorkspaceOperation?.(workspaceId) : undefined

  const isMutation = request.method !== "GET" && request.method !== "HEAD"
    && !(request.method === "POST" && SESSION_SETTLEMENT_WAIT.test(pathname.replace(/\/+$/, "")))
  const ordinarySessionMutation = isMutation
    && /^\/api\/(?:experimental\/)?session(?:\/|$)/.test(pathname)
    && !isGlobalFormAction(pathname, request.method)
  if (ordinarySessionMutation) {
    try { assertOrdinaryMissionScheduleBody(request.body, pathname.replace(/\/+$/, "") === "/api/experimental/session/import") }
    catch (error) {
      if (error instanceof MissionScheduleInputError) return sendPreDispatch(error.statusCode, { error: error.message })
      throw error
    }
  }

  // Native parent creation ignores the supplied location and inherits the
  // parent's authority. It is not part of CodeNomad's root-create contract.
  const createRoot = request.method === "POST" && pathname.replace(/\/+$/, "") === "/api/session"
  if (createRoot) {
    if (request.body !== undefined && (!request.body || typeof request.body !== "object"
      || Array.isArray(request.body) || Buffer.isBuffer(request.body)
      || request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json")) {
      return reply.code(400).send({ error: "Session creation requires a JSON object" })
    }
    if (request.body && "parentID" in request.body) {
      return reply.code(403).send({ error: "Parent session creation is not available through a workspace" })
    }
  }

  let connection: Awaited<ReturnType<NonNullable<InstanceProxyWorkspaceManager["getSharedServiceConnection"]>>> | undefined
  let endpoint: Awaited<ReturnType<InstanceProxyWorkspaceManager["getSharedServiceEndpoint"]>>
  try {
    connection = await wait(Promise.resolve(workspaceManager.getSharedServiceConnection?.(workspaceId)))
    endpoint = connection?.endpoint ?? await wait(workspaceManager.getSharedServiceEndpoint(workspaceId))
  } catch (error) {
    const statusCode = (error as { statusCode?: unknown } | undefined)?.statusCode
    if (isPromptOrCommandPost && !signal.aborted && !(typeof statusCode === "number" && statusCode >= 400 && statusCode < 500)) {
      sendUnavailableBeforeSend()
      return
    }
    throw error
  }
  const clientForRequest = () => {
    signal.throwIfAborted()
    return wait(connection ? Promise.resolve(connection.client) : workspaceManager.getSharedServiceClient())
  }
  if (!endpoint) {
    if (isPromptOrCommandPost) {
      sendUnavailableBeforeSend()
      return
    }
    reply.header("x-codenomad-before-dispatch", "1").code(502).send({ error: "OpenCode service is not ready" })
    return
  }

  try {
    await wait(Promise.resolve(connection?.profile(signal)))
  } catch (error) {
    const statusCode = (error as { statusCode?: unknown } | undefined)?.statusCode
    if (isPromptOrCommandPost && !signal.aborted && !(typeof statusCode === "number" && statusCode >= 400 && statusCode < 500)) {
      sendUnavailableBeforeSend()
      return
    }
    throw error
  }
  let locationContext: LocationRef | undefined
  try { locationContext = readLocationContext(request.headers[LOCATION_CONTEXT_HEADER]) }
  catch { return sendPreDispatch(400, { error: "Invalid location context" }) }

  const targetUrl = buildInstanceTargetUrl(endpoint.url, args.pathSuffix)
  if (!targetUrl) {
    sendPreDispatch(400, { error: "Invalid workspace instance path" })
    return
  }
  if (isPromptOrCommandPost) {
    targetUrl.pathname = targetUrl.pathname.replace(/\/+$/, "")
  }
  appendIncomingQuery(targetUrl, request.raw.url ?? "")
  const isPendingList = request.method === "GET" && /^\/api\/(?:permission\/request|form)\/?$/.test(pathname)
  const reconciliationDirectory = request.headers[PENDING_RECONCILIATION_HEADER] === "1"
    && [...targetUrl.searchParams.keys()].length === 1
    && targetUrl.searchParams.getAll("location[directory]").length === 1
    && (!locationContext || (locationContext.directory === targetUrl.searchParams.get("location[directory]") && locationContext.workspaceID === undefined))
    ? targetUrl.searchParams.get("location[directory]")! : undefined
  const deferList = () => isPendingList && connection && deferPendingDiscovery(connection, { workspaceId, reconciliationDirectory })
  if (deferList()) return reply.header("Retry-After", "30").header("Cache-Control", "no-store").code(503).send({ error: PENDING_DISCOVERY_DEFERRED })
  if (pathname.replace(/\/+$/, "") === "/api/session/active") {
    if (request.method !== "GET") {
      reply.code(405).send({ error: "Method not allowed" })
      return
    }
    const client = await clientForRequest()
    const active = await wait(client.session.active({ signal }))
    const entries = await Promise.all(Object.entries(active).map(async ([sessionId, status]) => {
      try {
        const session = await wait(client.session.get({ sessionID: sessionId }, { signal }))
        return await wait(workspaceManager.ownsLocation(workspaceId, session.location, client, { signal })) ? [sessionId, status] as const : null
      } catch {
        return null
      }
    }))
    signal.throwIfAborted()
    reply.send({ data: Object.fromEntries(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null)) })
    return
  }
  if (pathname.replace(/\/+$/, "") === "/api/project") {
    const projects = await wait((await clientForRequest()).project.list(undefined, { signal }))
    const ownedProjects = await Promise.all(projects.map(async (project) => {
      if (!await wait(workspaceManager.ownsDirectory(workspaceId, project.canonical))) return null
      const sandboxes = (await Promise.all(project.sandboxes.map(async (directory) => (
        await wait(workspaceManager.ownsDirectory(workspaceId, directory)) ? directory : null
      )))).filter((directory): directory is string => directory !== null)
      return { ...project, sandboxes }
    }))
    signal.throwIfAborted()
    reply.send(ownedProjects.filter((project): project is NonNullable<typeof project> => project !== null))
    return
  }
  const sessionListHasScope = request.method === "GET"
    && pathname.replace(/\/+$/, "") === "/api/session"
    && (targetUrl.searchParams.has("cursor") || targetUrl.searchParams.has("project"))
  const sessionListScope = await wait(authorizeSessionList(targetUrl, request.method, workspaceManager, workspaceId, connection?.client, signal))
  if (sessionListScope !== "allowed") {
    reply.code(sessionListScope === "invalid" ? 400 : 403).send({ error: "Session list does not belong to workspace" })
    return
  }
  const serviceDirectory = workspaceManager.getServiceDirectory?.(workspaceId) ?? workspace.path
  let globalFormLocation: LocationRef | undefined
  if (isGlobalFormAction(pathname, request.method)) {
    const directoryHeader = request.headers["x-opencode-directory"]
    if (Array.isArray(directoryHeader) || request.headers["x-opencode-workspace"] !== undefined) {
      reply.code(400).send({ error: "Invalid Form location" })
      return
    }
    let directory: string | undefined
    if (directoryHeader !== undefined) {
      try {
        directory = decodeURIComponent(directoryHeader)
      } catch {
        reply.code(400).send({ error: "Invalid Form location" })
        return
      }
      if (!directory.trim()) {
        reply.code(400).send({ error: "Invalid Form location" })
        return
      }
    }
    if (locationContext && locationContext.directory !== (directory ?? serviceDirectory)) {
      return reply.code(400).send({ error: "Conflicting Form location" })
    }
    if (directory !== undefined) globalFormLocation = { ...locationContext, directory }
  }
  const imported = prepareSessionImport(
    pathname,
    request.method,
    stripLocationSelectors(targetUrl, request.body, workspace.path, serviceDirectory),
    serviceDirectory,
  )
  const requestLocations = readRequestLocations(targetUrl, imported.body, workspace.path)
  const explicitLocations = [...requestLocations.locations]
  if (locationContext) {
    requestLocations.directories.push(locationContext.directory)
    requestLocations.locations.push(locationContext)
  }
  if (globalFormLocation) {
    requestLocations.directories.push(globalFormLocation.directory)
    requestLocations.locations.push(globalFormLocation)
  }
  requestLocations.directories.push(...imported.directories)
  requestLocations.locations.push(...imported.locations)
  requestLocations.invalid ||= imported.invalid
  readNativeCwd(targetUrl, imported.body, requestLocations)
  const promptFiles = readPromptFilePaths(pathname, request.method, imported.body)
  const promptBudget = validatePromptAttachmentBudget(pathname, request.method, imported.body)
  if (!promptBudget.ok) {
    sendPreDispatch(promptBudget.reason === "limit" ? 413 : 400, {
      error: promptBudget.reason === "limit"
        ? "Prompt attachments exceed the supported limits"
        : "Prompt attachment data is invalid",
    })
    return
  }
  if (requestLocations.invalid
    || !(await wait(allDirectoriesOwned(workspaceManager, workspaceId, requestLocations.directories)))
    || !(await wait(allLocationsOwned(workspaceManager, workspaceId, requestLocations.locations, connection?.client, signal)))) {
    sendPreDispatch(requestLocations.invalid ? 400 : 403, { error: "Location does not belong to workspace" })
    return
  }
  const translatedDirectories = new Map<string, string>()
  for (const directory of new Set(requestLocations.directories)) {
    const translated = workspaceManager.getServiceDirectoryForPath
      ? await wait(workspaceManager.getServiceDirectoryForPath(workspaceId, directory))
      : directory
    if (!translated) {
      sendPreDispatch(403, { error: "Location does not belong to workspace" })
      return
    }
    translatedDirectories.set(directory, translated)
  }
  if (locationContext && explicitLocations.some(location =>
    translatedDirectories.get(location.directory) !== translatedDirectories.get(locationContext!.directory)
      || (location.workspaceID !== undefined && location.workspaceID !== locationContext!.workspaceID))) {
    return sendPreDispatch(400, { error: "Conflicting location context" })
  }
  const fileListPath = readFileListPath(targetUrl, request.method, requestLocations.directories[0] ?? workspace.path)
  if (fileListPath.invalid) {
    sendPreDispatch(400, { error: "Invalid filesystem path" })
    return
  }
  if (fileListPath.candidate) {
    if (!(await wait(workspaceManager.ownsPath(workspaceId, fileListPath.candidate)))) {
      sendPreDispatch(403, { error: "Filesystem path does not belong to workspace" })
      return
    }
    const translated = workspaceManager.getServicePathForPath
      ? await wait(workspaceManager.getServicePathForPath(workspaceId, fileListPath.candidate))
      : fileListPath.candidate
    if (!translated) {
      sendPreDispatch(403, { error: "Filesystem path does not belong to workspace" })
      return
    }
    targetUrl.searchParams.set("path", translated)
  }
  const mutationIdentities = new Set<string>()
  const mutationPlacements = new Map<string, string>()
  const mutationDirectories = new Set(requestLocations.directories)
  const serviceBody = replaceRequestDirectories(targetUrl, imported.body, translatedDirectories, pathname, request.method)
  if (promptFiles.invalid || !(await wait(allPathsOwned(workspaceManager, workspaceId, promptFiles.paths)))) {
    sendPreDispatch(promptFiles.invalid ? 400 : 403, { error: "Prompt file does not belong to workspace" })
    return
  }
  const translatedPromptPaths = new Map<string, string>()
  for (const candidate of new Set(promptFiles.paths)) {
    const translated = workspaceManager.getServicePathForPath
      ? await wait(workspaceManager.getServicePathForPath(workspaceId, candidate))
      : candidate
    if (!translated) {
      sendPreDispatch(403, { error: "Prompt file does not belong to workspace" })
      return
    }
    translatedPromptPaths.set(candidate, translated)
  }
  const promptBody = replacePromptFileUris(serviceBody, translatedPromptPaths)

  const requestedDirectory = requestLocations.directories[0]
  const runtimeLocation = {
    directory: requestedDirectory ? translatedDirectories.get(requestedDirectory) ?? serviceDirectory : serviceDirectory,
    workspaceID: locationContext?.workspaceID ?? explicitLocations.find(location => location.directory === requestedDirectory)?.workspaceID,
  }
  const runtimeLocationOptions = { ...locationRequestOptions(runtimeLocation), signal }
  if (pathname.replace(/\/+$/, "") === "/api/pty" && request.method === "GET") {
    const result = await wait((await clientForRequest()).pty.list({ location: { directory: runtimeLocation.directory } }, runtimeLocationOptions))
    const ownership = await wait(Promise.all(result.data.map((pty) => workspaceManager.ownsDirectory(workspaceId, pty.cwd))))
    reply.send({ ...result, data: result.data.filter((_, index) => ownership[index]) })
    return
  }

  const ptyId = getPtyRouteId(pathname)
  if (ptyId) {
    try {
      const pty = await wait((await clientForRequest()).pty.get({ ptyID: ptyId, location: { directory: runtimeLocation.directory } }, runtimeLocationOptions))
      if (!(await wait(workspaceManager.ownsDirectory(workspaceId, pty.data.cwd)))) {
        reply.code(403).send({ error: "PTY does not belong to workspace" })
        return
      }
      mutationDirectories.add(pty.data.cwd)
    } catch (error) {
      if (isPtyNotFoundError(error)) {
        reply.code(404).send({ error: "PTY not found" })
        return
      }
      throw error
    }
  }

  if (pathname.replace(/\/+$/, "") === "/api/shell" && request.method === "GET") {
    const result = await wait((await clientForRequest()).shell.list({ location: { directory: runtimeLocation.directory } }, runtimeLocationOptions))
    const ownership = await wait(Promise.all(result.data.map((shell) => workspaceManager.ownsDirectory(workspaceId, shell.cwd))))
    reply.send({ ...result, data: result.data.filter((_, index) => ownership[index]) })
    return
  }

  const shellId = getShellRouteId(pathname)
  if (shellId) {
    try {
      const shell = await wait((await clientForRequest()).shell.get({ id: shellId, location: { directory: runtimeLocation.directory } }, runtimeLocationOptions))
      const ownerDirectory = await wait(ownedShellDirectory(shell.data, await clientForRequest(), directory => workspaceManager.ownsDirectory(workspaceId, directory), signal))
      if (!ownerDirectory) {
        reply.code(403).send({ error: "Shell does not belong to workspace" })
        return
      }
      mutationDirectories.add(ownerDirectory)
    } catch (error) {
      if (isShellNotFoundError(error)) {
        reply.code(404).send({ error: "Shell not found" })
        return
      }
      throw error
    }
  }

  const sessionId = getSessionRouteId(pathname)
  const sessionInput = promptBody as {
    id?: unknown
    info?: { id?: unknown; parentID?: unknown }
  } | undefined
  const normalizedRoute = pathname.replace(/\/+$/, "")
  const suppliedSessionId = normalizedRoute === "/api/session"
    ? sessionInput?.id
    : normalizedRoute === "/api/experimental/session/import"
      ? sessionInput?.info?.id
      : undefined
  const suppliedParentId = normalizedRoute === "/api/experimental/session/import"
    ? sessionInput?.info?.parentID
    : undefined
  if (ordinarySessionMutation && (sessionId || typeof suppliedSessionId === "string")) {
    await wait(Promise.resolve(workspaceManager.desktopPluginsReady?.()))
  }
  let authorizedSessionDirectory: string | undefined
  let authorizedSession: Awaited<ReturnType<OpenCodeClient["session"]["get"]>> | undefined
  let boundSessionDirectory: string | undefined
  const matchesBoundSessionDirectory = async (nativeDirectory: string, boundDirectory: string): Promise<boolean> => {
    if (nativeDirectory === boundDirectory) return true
    if (workspaceManager.getServiceDirectoryForPath) {
      const translatedBound = await wait(workspaceManager.getServiceDirectoryForPath(workspaceId, boundDirectory))
      if (translatedBound && translatedBound === nativeDirectory) return true
    }
    const [realNative, realBound] = await Promise.all([
      fs.promises.realpath(nativeDirectory).catch(() => undefined),
      fs.promises.realpath(boundDirectory).catch(() => undefined),
    ])
    return Boolean(realNative && realBound && realNative === realBound)
  }
  const targetSessionId = sessionId && !isGlobalFormAction(pathname, request.method) ? sessionId
    : ordinarySessionMutation && typeof suppliedSessionId === "string" && suppliedSessionId ? suppliedSessionId : undefined
  if (targetSessionId) {
    let session
    try {
      session = await wait((await clientForRequest()).session.get({ sessionID: targetSessionId }, { signal }))
    } catch (error) {
      if (isInvalidRequestError(error)) {
        sendPreDispatch(400, { error: "Invalid session ID" })
        return
      }
      if (isSessionNotFoundError(error) && sessionId) {
        // Parent-chain hydration must distinguish a missing session from a
        // transport/authorization failure. Retain only the native public shape.
        sendPreDispatch(404, { _tag: "SessionNotFoundError", sessionID: sessionId, message: "Session not found" })
        return
      }
      if (isPromptOrCommandPost && !isSessionNotFoundError(error) && !signal.aborted) {
        sendUnavailableBeforeSend()
        return
      }
      if (!isSessionNotFoundError(error)) throw error
    }
    if (session) {
      const { location } = session
      const wantsPlacement = request.method === "GET" && /^\/api\/session\/[^/]+\/?$/.test(pathname)
        && request.headers[SESSION_PLACEMENT_HEADER] === "1" && workspaceManager.resolveLocationPlacement
      const ownsSession = async (strict = false) => wantsPlacement
        ? workspaceManager.resolveLocationPlacement!(workspaceId, location, { signal, strict })
        : workspaceManager.ownsLocation(workspaceId, location, await clientForRequest(), { signal, strict })
      const ownership = await wait(ownsSession())
      if (!ownership) {
        // A failed translation or inventory read also denies access, but cannot establish departure.
        const elsewhere = await wait(ownsSession(true)).then(owned => !owned, () => false)
        signal.throwIfAborted()
        connection?.assertCurrent()
        return sendPreDispatch(403, { error: "Session does not belong to workspace",
          ...(elsewhere ? { reason: SESSION_LOCATED_ELSEWHERE_REASON } : {}) })
      }
      if (typeof ownership === "object") {
        signal.throwIfAborted()
        connection?.assertCurrent()
        return reply.send({ data: { ...session, listWorktreeSlug: ownership.listWorktreeSlug } })
      }
    }
    if (ordinarySessionMutation && !enterSessionMutation(targetSessionId)) {
      return sendPreDispatch(409, { error: "Session cleanup in progress" })
    }
    authorizedSessionDirectory = session?.location.directory
    authorizedSession = session
    const sessionDirectoryHeader = request.headers["x-codenomad-session-directory"]
    if (session && isPromptOrCommandPost && sessionDirectoryHeader !== undefined) {
      let headerOccurrences = 0
      const rawHeaders = request.raw.rawHeaders
      if (Array.isArray(rawHeaders)) {
        for (let i = 0; i < rawHeaders.length; i += 2) {
          if (rawHeaders[i]?.toLowerCase() === "x-codenomad-session-directory") headerOccurrences += 1
        }
      }
      if (headerOccurrences > 1 || typeof sessionDirectoryHeader !== "string" || sessionDirectoryHeader.length > 16_384) {
        sendPreDispatch(400, { error: "Invalid session directory header" })
        return
      }
      try {
        boundSessionDirectory = decodeURIComponent(sessionDirectoryHeader)
      } catch {
        sendPreDispatch(400, { error: "Invalid session directory header" })
        return
      }
      if (!await matchesBoundSessionDirectory(session.location.directory, boundSessionDirectory)) {
        sendPreDispatch(403, { error: "Location does not belong to workspace" })
        return
      }
    }
    if (session && isMutation) {
      const sessionWorktree = await wait(workspaceManager.getWorktreeIdentityForPath(workspaceId, session.location.directory))
      if (!sessionWorktree) {
        sendPreDispatch(403, { error: "Session does not belong to workspace" })
        return
      }
      mutationIdentities.add(sessionWorktree)
      mutationPlacements.set(session.location.directory, sessionWorktree)
    }
  }

  const defaultLocation = applyDefaultWorkspaceLocation(targetUrl, promptBody, request.method, serviceDirectory, requestLocations.directories.length > 0 || sessionListHasScope, Boolean(sessionId) && !isGlobalFormAction(pathname, request.method))
  let body = defaultLocation.body
  if (defaultLocation.directory) mutationDirectories.add(defaultLocation.directory)
  if (isMutation) {
    // Resolve every effective effect location, including server-supplied defaults
    // and a native resource's actual cwd, BEFORE entering the deletion fence.
    for (const directory of mutationDirectories) {
      const identity = await workspaceManager.getWorktreeIdentityForPath(workspaceId, directory)
      if (!identity) {
        sendPreDispatch(403, { error: "Location does not belong to workspace" })
        return
      }
      mutationIdentities.add(identity)
      mutationPlacements.set(directory, identity)
    }
  }
  const instanceAuthHeader = workspaceManager.getInstanceAuthorizationHeader(workspaceId)
  signal.throwIfAborted()
  const releaseFence = isMutation ? worktreeDeletionFence.enter([...mutationIdentities]) : undefined
  if (isMutation && !releaseFence) {
    sendPreDispatch(409, { error: "Worktree deletion is in progress" })
    return
  }
  const fencedSessionIds = ordinarySessionMutation
    ? [
      ...(sessionId ? [sessionId] : []),
      ...(typeof suppliedSessionId === "string" && suppliedSessionId ? [suppliedSessionId] : []),
      ...(typeof suppliedParentId === "string" && suppliedParentId ? [suppliedParentId] : []),
    ]
    : []
  const releaseSessionMove = fencedSessionIds.length > 0
    ? worktreeDeletionFence.enterSessions(fencedSessionIds)
    : undefined
  if (fencedSessionIds.length > 0 && !releaseSessionMove) {
    releaseFence?.()
    sendPreDispatch(409, { error: "Session move is in progress" })
    return
  }
  logger.debug({ workspaceId, method: request.method, targetUrl: targetUrl.toString() }, "Proxying request to instance")
  const releaseAccount = connection && isMutation
    && /^\/api\/(?:credential|integration)(?:\/|$)/.test(pathname) ? args.accounts?.manual(connection) : undefined
  const releasePhysicalMutation = releaseFence || releaseSessionMove || releaseAccount
    ? () => { releaseAccount?.(); releaseSessionMove?.(); releaseFence?.() }
    : undefined
  const releaseMutation = !isMutation ? releasePhysicalMutation
    : () => { releasePhysicalMutation?.(); releaseSession() }

  let enteredForward = false
  try {
    connection?.assertCurrent()
    if (ordinarySessionMutation) {
      try {
        const client = await clientForRequest()
        const current = () => { signal.throwIfAborted(); connection?.assertCurrent() }
        const guard = async (session: NonNullable<typeof authorizedSession>) => {
          await wait(assertOrdinaryMissionScheduleSession(client, session, { signal, current }))
          const fresh = await wait(client.session.get({ sessionID: session.id }, { signal }))
          current()
          if (!sameSessionTarget(session, fresh)
            || !await wait(workspaceManager.ownsLocation(workspaceId, fresh.location, client, { signal }))) {
            throw new MissionScheduleInputError(403)
          }
          assertOrdinaryMissionScheduleBody({ metadata: fresh.metadata })
        }
        if (authorizedSession) await guard(authorizedSession)
        else if (targetSessionId) {
          // A supplied create/import ID absent natively still needs the exact
          // durable reverse-mapping read in the admitted project.
          await wait(assertOrdinaryMissionScheduleSession(client, { id: targetSessionId, location: runtimeLocation }, { signal, current }))
        }
        current()
      } catch (error) {
        if (error instanceof MissionScheduleInputError) {
          releaseMutation?.()
          return sendPreDispatch(error.statusCode, { error: error.message })
        }
        if (isPromptOrCommandPost && !signal.aborted) {
          releaseMutation?.()
          if (isSessionNotFoundError(error) && sessionId) {
            return sendPreDispatch(404, { _tag: "SessionNotFoundError", sessionID: sessionId, message: "Session not found" })
          }
          return sendUnavailableBeforeSend()
        }
        throw error
      }
    }
    let confirmRoot: ((response: Response) => Promise<Response>) | undefined
    if (createRoot && !authorizedSession && args.permissionModes) {
      const modes = args.permissionModes
      const distro = workspaceManager.getServiceWslDistro?.(workspaceId)
      const input = (body ?? {}) as { id?: unknown; location?: LocationRef; permissions?: unknown }
      // Native root creation selects its directory from the JSON body, not
      // from an ambient query or header. Read that Location's configuration.
      const location = { directory: input.location?.directory ?? runtimeLocation.directory }
      let configBlock
      try {
        configBlock = await wait(modes.newRootRules({ client: await clientForRequest(), location, distro, signal }))
      } catch {
        releaseMutation?.()
        return reply.code(503).send({ error: "Conversation permissions unavailable" })
      }
      if (configBlock) {
        const original = sessionPermissionRules.safeParse(input.permissions ?? [])
        if (!original.success || blockPositions(original.data, configBlock).length) {
          releaseMutation?.()
          return reply.code(400).send({ error: "Cannot combine conversation permissions" })
        }
        const block = appendSessionProjection(configBlock, original.data, distro)
        body = { ...input, location, permissions: [...original.data, ...block] }
        confirmRoot = async response => {
          if (!response.ok) return response
          try {
            const { data: created } = await response.clone().json()
            connection?.assertCurrent()
            if (!created || (typeof input.id === "string" && created.id !== input.id)
              || !sameLocation(readLocationRef(created.location), location)
              || !await workspaceManager.ownsLocation(workspaceId, created.location, connection?.client)) throw new Error("Foreign session")
            connection?.assertCurrent()
            modes.confirmNewRoot(created, distro, block, original.data)
            return response
          } catch {
            await response.body?.cancel().catch(() => {})
            return Response.json({ error: "Conversation permissions were not confirmed" }, { status: 502 })
          }
        }
      }
    }
    const formReply = request.method === "POST" && pathname.match(/^\/api\/session\/[^/]+\/form\/([^/]+)\/reply\/*$/)
    const control = authorizedSession && sessionControl ? { session: authorizedSession, client: await clientForRequest(), signal } : undefined
    const controlCurrent = async () => {
      if (control && !await wait(currentSessionControl(control))) return false
      connection?.assertCurrent()
      if (workspaceManager.captureWorkspaceOperation) {
        try { return workspaceOperation?.current() === true } catch { return false }
      }
      return workspaceManager.get(workspaceId)?.path === workspace.path
    }
    const result = control && sessionControl && await wait(admitSessionControl(sessionControl, {
      pathname: pathname.replace(/\/+$/, ""), query: targetUrl.searchParams, body: request.body, ...control,
    }))
    if (result && "status" in result) {
      if (result.reconcile && connection && authorizedSessionDirectory && await controlCurrent().catch(() => false)) {
        grantPendingReconciliation(connection, workspaceId, authorizedSessionDirectory)
      }
      releaseMutation?.()
      return reply.code(result.status).send(result.body)
    }
    if (formReply && sessionId && sessionId !== "global" && connection && args.humanAnswers
      && request.headers[HUMAN_ANSWER_HEADER] === "1") {
      grantPendingReconciliation(connection, workspaceId, authorizedSessionDirectory ?? runtimeLocation.directory)
      try {
        const result = await replyMissionHumanAnswer(request, workspaceId, sessionId, formReply[1],
          args.humanAnswers, connection, signal)
        if (result) {
          releaseMutation?.()
          // Native form replies succeed with an empty 204; the generated
          // client rejects any other status as UnexpectedStatus.
          return reply.code(204).send()
        }
      } catch {
        releaseMutation?.()
        return reply.code(409).send({ error: "Human answer outcome unavailable; do not replay the native answer" })
      }
    }
    const confirmPermission = result && connection && args.permissionReceipts
      ? await wait(args.permissionReceipts.prepare(workspaceId, connection, result.request, result.decision, result.message))
      : undefined
    const confirmDeletion = request.method === "DELETE" && /^\/api\/session\/[^/]+\/?$/.test(pathname)
      && connection && args.permissionReceipts && sessionId
      ? await args.permissionReceipts.prepareDeletion(workspaceId, connection, sessionId) : undefined
    connection?.assertCurrent()
    // Recheck after authorization and receipt preparation, before forwarding.
    if (control && !await controlCurrent()) {
      releaseMutation?.()
      return reply.code(403).send({ error: "Location does not belong to workspace" })
    }
    connection?.assertCurrent()
    if (deferList()) return reply.header("Retry-After", "30").header("Cache-Control", "no-store").code(503).send({ error: PENDING_DISCOVERY_DEFERRED })
    if (connection && kind && kind !== "interrupt") {
      grantPendingReconciliation(connection, workspaceId, authorizedSessionDirectory ?? runtimeLocation.directory)
    }
    let resolvedRuntimeFetch: Parameters<typeof forwardRuntimeRequest>[0]["fetch"] | undefined
    if (request.method === "POST" && /^\/api\/session\/[^/]+\/(?:prompt|command|shell)\/*$/.test(pathname)) {
      if (isPromptOrCommandPost) {
        if (!connection && !workspaceManager.getSharedServiceFetch) {
          releaseMutation?.()
          return sendPreDispatch(503, { error: "Session mutation transport is unavailable" })
        }
        resolvedRuntimeFetch = connection?.fetch ?? await wait(workspaceManager.getSharedServiceFetch!())
        if (!supportsDispatchHooks(resolvedRuntimeFetch)) {
          releaseMutation?.()
          return sendUnavailableBeforeSend()
        }
      }
      try {
        const environmentSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        const variables = await wait(workspaceManager.getSessionEnvironment(workspaceId, environmentSignal))
        const client = await clientForRequest()
        environmentSignal.throwIfAborted()
        connection?.assertCurrent()
        await wait(client.session.environment({ sessionID: sessionId!, variables }, { signal: environmentSignal }))
        environmentSignal.throwIfAborted()
        connection?.assertCurrent()
      } catch {
        signal.throwIfAborted()
        // Never log the SDK error: it can contain the complete environment body.
        releaseMutation?.()
        logger.error({ workspaceId, sessionId }, "Failed to apply profile environment")
        return sendPreDispatch(502, { error: SESSION_ENVIRONMENT_FAILED_ERROR_CODE })
      }
      if (!pathname.replace(/\/$/, "").endsWith("/shell")) {
        try {
          connection?.assertCurrent()
          await wait(syncSessionGitContext(await clientForRequest(), sessionId!, signal))
        } catch {
          // Advisory context must not turn Git recovery into another send blocker.
          // Do not log SDK bodies (they may include unrelated session context).
          logger.debug({ workspaceId, sessionId }, "Unable to update Git availability context")
        }
        if (connection) {
          await wait(syncSessionMemoryContext(connection, args.memory, sessionId!, signal))
        }
      }
      signal.throwIfAborted()
      connection?.assertCurrent()
      if (connection && !pathname.replace(/\/$/, "").endsWith("/shell") && args.accounts) {
        try {
          await wait(args.accounts.beforeSend(connection, sessionId!, AbortSignal.any([signal, AbortSignal.timeout(15_000)]), async directory => {
            const current = await connection.client.session.get({ sessionID: sessionId! }, { signal })
            return workspaceManager.get(workspaceId) === workspace
              && directory === authorizedSessionDirectory && current.location.directory === authorizedSessionDirectory
              && await workspaceManager.ownsLocation(workspaceId, current.location, connection.client, { signal })
          }))
        } catch (error) {
          releaseMutation?.()
          if (error instanceof AccountSelectionFailed) {
            return sendPreDispatch(502, { error: "PROVIDER_ACCOUNT_SELECTION_FAILED" })
          }
          throw error
        }
      }
      const modes = args.permissionModes
      if (modes && authorizedSession) {
        try {
          if (modes.mayBeSupervised(authorizedSession)) {
            const client = await clientForRequest()
            const refreshSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
            const current = () => {
              refreshSignal.throwIfAborted()
              connection?.assertCurrent()
              if (workspaceManager.get(workspaceId) !== workspace) throw new Error("Workspace changed")
            }
            await wait(modes.refresh(sessionPermissionTarget(authorizedSession, {
              client, current, signal: refreshSignal, distro: workspaceManager.getServiceWslDistro?.(workspaceId),
            })))
          }
        } catch {
          signal.throwIfAborted()
          releaseMutation?.()
          return sendPreDispatch(503, { error: "Conversation permissions unavailable" })
        }
      }
    }
    // The native session PATCH can replace the entire permission array.
    const patchSession = args.permissionModes && request.method === "PATCH" && /^\/api\/session\/[^/]+\/?$/.test(pathname)
      ? authorizedSession : undefined
    const forkSource = args.permissionModes && request.method === "POST" && /^\/api\/session\/[^/]+\/fork\/?$/.test(pathname)
      ? authorizedSession : undefined
    if (connection || workspaceManager.getSharedServiceFetch) {
      const headers = sanitizeInstanceProxyRequestHeaders(request.headers, instanceAuthHeader)
      delete headers[LOCATION_CONTEXT_HEADER]
      delete headers[PENDING_RECONCILIATION_HEADER]
      if (locationContext) Object.assign(headers, locationRequestOptions({ ...locationContext, directory: translatedDirectories.get(locationContext.directory)! }, { includeDirectory: true })?.headers)
      if (globalFormLocation) headers["x-opencode-directory"] = encodeURIComponent(translatedDirectories.get(globalFormLocation.directory)!)
      const runtimeFetch = resolvedRuntimeFetch
        ?? connection?.fetch
        ?? await wait(workspaceManager.getSharedServiceFetch!())
      if (confirmRoot) headers["content-type"] = "application/json"
      signal.throwIfAborted()
      const verifyPromptPlacementBeforeDispatch = isPromptOrCommandPost && sessionId && authorizedSession
        ? async () => {
          let fresh: Awaited<ReturnType<OpenCodeClient["session"]["get"]>>
          let client: OpenCodeClient
          try {
            connection?.assertCurrent()
            client = await clientForRequest()
            fresh = await wait(client.session.get({ sessionID: sessionId }, { signal }))
          } catch (error) {
            if (signal.aborted) throw error
            if (isInvalidRequestError(error)) {
              throw new PreDispatchHttpError(400, { error: "Invalid session ID" })
            }
            if (isSessionNotFoundError(error)) {
              throw new PreDispatchHttpError(404, { _tag: "SessionNotFoundError", sessionID: sessionId, message: "Session not found" })
            }
            throw new PreDispatchHttpError(502, { error: "opencode_unavailable_before_send" })
          }
          let stillOwned: boolean
          const sameWorkspace = () => {
            const current = workspaceManager.get(workspaceId)
            return Boolean(current && current.id === workspace.id && current.path === workspace.path)
          }
          try {
            signal.throwIfAborted()
            connection?.assertCurrent()
            stillOwned = sameWorkspace()
              && sameSessionTarget(authorizedSession, fresh)
              && await wait(workspaceManager.ownsLocation(workspaceId, fresh.location, client, { signal }))
              && (boundSessionDirectory === undefined
                || await matchesBoundSessionDirectory(fresh.location.directory, boundSessionDirectory))
            signal.throwIfAborted()
            connection?.assertCurrent()
            stillOwned = stillOwned && sameWorkspace()
          } catch (error) {
            if (signal.aborted) throw error
            throw new PreDispatchHttpError(502, { error: "opencode_unavailable_before_send" })
          }
          if (!stillOwned) {
            throw new PreDispatchHttpError(403, { error: "Location does not belong to workspace" })
          }
          try {
            assertOrdinaryMissionScheduleBody({ metadata: fresh.metadata })
          } catch (error) {
            if (error instanceof MissionScheduleInputError) {
              throw new PreDispatchHttpError(error.statusCode, { error: error.message })
            }
            throw error
          }
        }
        : undefined
      // A transcript page read by the UI: large tool images load on demand.
      const deferMedia = request.method === "GET" && /^\/api\/session\/[^/]+\/message\/?$/.test(pathname)
        && wantsDeferredMedia(request.headers)
      const forwardFetch = confirmPermission || confirmDeletion || confirmRoot || forkSource
        ? (() => {
          const wrapped = async (
            input: Parameters<typeof runtimeFetch>[0],
            init?: Parameters<typeof runtimeFetch>[1],
            mediaResponseProcessor?: undefined,
            dispatchHooks?: Parameters<typeof runtimeFetch>[3],
          ) => {
            const response = await runtimeFetch(input, init, mediaResponseProcessor, dispatchHooks)
            if (response.ok) {
              await confirmPermission?.()
              await confirmDeletion?.()
              if (forkSource) {
                try {
                  const client = await clientForRequest()
                  const forkSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
                  await recordPermissionFork(response, args.permissionModes!, forkSource, {
                    client, distro: workspaceManager.getServiceWslDistro?.(workspaceId),
                    signal: forkSignal,
                    current: () => {
                      forkSignal.throwIfAborted()
                      connection?.assertCurrent()
                      if (workspaceManager.get(workspaceId) !== workspace) throw new SessionModeConflict("Workspace changed")
                    },
                  }, location => workspaceManager.ownsLocation(workspaceId, location, client, { signal: forkSignal }))
                } catch {
                  logger.warn({ workspaceId }, "Unable to record forked conversation permissions")
                }
              }
            }
            return confirmRoot ? confirmRoot(response) : response
          }
          return supportsDispatchHooks(runtimeFetch) ? markDispatchHookAwareFetch(wrapped) : wrapped
        })()
        : runtimeFetch
      const forward = () => {
        enteredForward = true
        return forwardRuntimeRequest({
        transform: deferMedia && sessionId
          ? body => deferToolMedia((body as { data?: unknown } | null)?.data, { workspaceId, sessionId })
          : undefined,
        beforeDispatch: verifyPromptPlacementBeforeDispatch,
        request, reply, url: targetUrl.toString(), body, headers,
        fetch: forwardFetch, release: releaseMutation,
        retainMutation: ordinarySessionMutation && targetSessionId && args.sessionCleanup
          ? confirmed => { if (!confirmed) args.sessionCleanup!.markUncertain(targetSessionId) }
          : confirmRoot || patchSession ? () => {} : undefined,
        invalidate: () => connection ? connection.invalidate() : workspaceManager.invalidateSharedServiceConnection?.(),
      })
      }
      if (!patchSession) return await forward()
      const client = await clientForRequest()
      const target = sessionPermissionTarget(patchSession, {
        client, signal, distro: workspaceManager.getServiceWslDistro?.(workspaceId),
        current: () => {
          signal.throwIfAborted()
          connection?.assertCurrent()
          if (workspaceManager.get(workspaceId) !== workspace) throw new SessionModeConflict("Workspace changed")
        },
      })
      try {
        return await args.permissionModes!.withSessionLock(target, fresh => {
          assertOrdinaryMissionScheduleBody({ metadata: fresh.metadata })
          return forward()
        })
      } catch (error) {
        if (isSessionNotFoundError(error) && error.sessionID === patchSession.id) {
          releaseMutation?.()
          return reply.code(404).send({ _tag: "SessionNotFoundError", sessionID: patchSession.id, message: "Session not found" })
        }
        if (error instanceof SessionModeConflict || error instanceof MissionScheduleInputError) {
          releaseMutation?.()
          return reply.code(error instanceof MissionScheduleInputError ? error.statusCode : 409).send({ error: error.message })
        }
        throw error
      }
    }
    if (isPromptOrCommandPost || confirmRoot || patchSession || ordinarySessionMutation && targetSessionId && args.sessionCleanup) {
      releaseMutation?.()
      return sendPreDispatch(503, { error: "Session mutation transport is unavailable" })
    }
    signal.throwIfAborted()
    return reply.from(targetUrl.toString(), {
      ...(body !== request.body ? { body } : {}),
      rewriteRequestHeaders: (_originalRequest, headers) => {
        const outgoingHeaders = sanitizeInstanceProxyRequestHeaders(headers, instanceAuthHeader)
        if (globalFormLocation) {
          outgoingHeaders["x-opencode-directory"] = encodeURIComponent(translatedDirectories.get(globalFormLocation.directory)!)
        }

        if (logger.isLevelEnabled("trace")) {
          logger.trace(
            {
              workspaceId,
              method: request.method,
              targetUrl: targetUrl.toString(),
              contentType: request.headers["content-type"],
              headers: redactSecrets(outgoingHeaders),
            },
            "Proxy -> OpenCode request",
          )
        }

        return outgoingHeaders
      },
      rewriteHeaders: sanitizeInstanceProxyResponseHeaders,
      onResponse: (_proxyRequest, proxyReply, upstreamResponse) => {
        if (proxyReply.statusCode === 401) {
          workspaceManager.invalidateSharedServiceConnection?.()
        }
        const upstream = upstreamResponse.stream
        const release = () => releaseMutation?.()
        if (upstream.readableEnded || upstream.destroyed) release()
        else {
          upstream.once("end", release)
          upstream.once("close", release)
          upstream.once("error", release)
        }
        proxyReply.send(upstream)
      },
      onError: (proxyReply, { error }) => {
        workspaceManager.invalidateSharedServiceConnection?.()
        releaseMutation?.()
        logger.error({ err: error, workspaceId, targetUrl: targetUrl.toString() }, "Failed to proxy workspace request")
        if (!proxyReply.sent) {
          proxyReply.code(502).send({ error: "Workspace instance proxy failed" })
        }
      },
    })
  } catch (error) {
    releaseMutation?.()
    if (isPromptOrCommandPost && !enteredForward && !signal.aborted && !reply.sent) {
      return sendUnavailableBeforeSend()
    }
    throw error
  }
}

function appendIncomingQuery(targetUrl: URL, incomingUrl: string): URL {
  const queryIndex = incomingUrl.indexOf("?")
  const incomingSearch = queryIndex >= 0 ? incomingUrl.slice(queryIndex + 1) : ""
  for (const [key, value] of new URLSearchParams(incomingSearch)) targetUrl.searchParams.append(key, value)
  return targetUrl
}

function readNativeCwd(
  targetUrl: URL,
  body: unknown,
  locations: { directories: string[]; locations: LocationRef[]; invalid: boolean },
) {
  if (!/^\/api\/(?:shell|pty)\/?$/.test(targetUrl.pathname) || !body || typeof body !== "object" || Array.isArray(body) || Buffer.isBuffer(body)) return
  const input = body as Record<string, unknown>
  if (!("cwd" in input)) return
  if (typeof input.cwd === "string" && input.cwd.trim()) locations.directories.push(input.cwd)
  else locations.invalid = true
}

function readFileListPath(
  targetUrl: URL,
  method: string,
  defaultDirectory: string,
): { candidate?: string; invalid: boolean } {
  if (method !== "GET" || targetUrl.pathname.replace(/\/+$/, "") !== "/api/fs/list") {
    return { invalid: false }
  }
  const values = targetUrl.searchParams.getAll("path")
  if (values.length > 1) return { invalid: true }
  const requested = values[0]?.trim() || "."
  if (requested.includes("\0")) return { invalid: true }
  const windowsBase = /^[A-Za-z]:[\\/]/.test(defaultDirectory) || /^[\\/]{2}[^\\/]/.test(defaultDirectory)
  if (!windowsBase && path.win32.isAbsolute(requested) && !path.posix.isAbsolute(requested)) {
    return { candidate: path.win32.normalize(requested), invalid: false }
  }
  return {
    candidate: windowsBase
      ? path.win32.resolve(defaultDirectory, requested)
      : path.posix.resolve(defaultDirectory, requested),
    invalid: false,
  }
}

function sanitizeInstanceProxyRequestHeaders(
  headers: Record<string, string | string[] | undefined>,
  authorization: string | undefined,
) {
  const blocked = new Set([
    "authorization", "connection", "cookie", "forwarded", "host", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "proxy-connection", "set-cookie", "te", "trailer", "transfer-encoding", "upgrade",
    "x-forwarded-for", "x-forwarded-host", "x-forwarded-port", "x-forwarded-proto",
    LOCATION_CONTEXT_HEADER,
    HUMAN_ANSWER_HEADER,
    DEFERRED_MEDIA_HEADER,
    SESSION_PLACEMENT_HEADER,
    "x-codenomad-session-directory",
  ])
  const connection = headers.connection
  for (const name of (Array.isArray(connection) ? connection.join(",") : connection ?? "").split(",")) blocked.add(name.trim().toLowerCase())

  const result: Record<string, string | string[] | undefined> = {}
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase()
    if (!blocked.has(normalized) && !normalized.startsWith("x-opencode-")) result[key] = value
  }
  if (authorization) result.authorization = authorization
  return result
}

function sanitizeInstanceProxyResponseHeaders(headers: Record<string, string | string[] | undefined>) {
  const blocked = new Set([
    "proxy-authenticate",
    "set-cookie",
    "set-cookie2",
    "www-authenticate",
    "x-codenomad-before-dispatch",
  ])
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())))
}

async function allDirectoriesOwned(manager: InstanceProxyWorkspaceManager, workspaceId: string, directories: string[]) {
  return (await Promise.all(directories.map((directory) => manager.ownsDirectory(workspaceId, directory)))).every(Boolean)
}

async function allLocationsOwned(manager: InstanceProxyWorkspaceManager, workspaceId: string, locations: LocationRef[], client?: OpenCodeClient, signal?: AbortSignal) {
  const unique = new Map(locations.map((location) => [JSON.stringify([location.directory, location.workspaceID]), location]))
  return (await Promise.all([...unique.values()].map((location) => manager.ownsLocation(workspaceId, location, client, { signal })))).every(Boolean)
}

async function allPathsOwned(manager: InstanceProxyWorkspaceManager, workspaceId: string, paths: string[]) {
  return (await Promise.all(paths.map((candidate) => manager.ownsPath(workspaceId, candidate)))).every(Boolean)
}

function applyDefaultWorkspaceLocation(
  targetUrl: URL,
  body: unknown,
  method: string,
  directory: string,
  hasLocation: boolean,
  sessionRoute: boolean,
): { body: unknown; directory?: string } {
  if (hasLocation || sessionRoute) return { body }
  if (/^\/api\/(?:credential|project)(?:\/|$)/.test(targetUrl.pathname)
    || /^\/api\/permission\/saved(?:\/|$)/.test(targetUrl.pathname)) return { body }
  if (targetUrl.pathname === "/api/session" && method === "GET") {
    targetUrl.searchParams.set("directory", directory)
    return { body, directory }
  }
  if (targetUrl.pathname === "/api/session" && method === "POST") {
    const input = body && typeof body === "object" && !Array.isArray(body) && !Buffer.isBuffer(body)
      ? body as Record<string, unknown>
      : {}
    return { body: { ...input, location: { directory } }, directory }
  }
  targetUrl.searchParams.set("location[directory]", directory)
  return { body, directory }
}

function getSessionRouteId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/(?:experimental\/)?session\/([^/]+)(?:\/|$)/)
  if (!match || match[1] === "active" || match[1] === "import") return null
  return match[1]
}

function isGlobalFormAction(pathname: string, method: string): boolean {
  return (method === "POST" && /^\/api\/session\/global\/form\/[^/]+\/reply\/*$/.test(pathname))
    || (method === "DELETE" && /^\/api\/session\/global\/form\/[^/]+\/*$/.test(pathname))
}

async function authorizeSessionList(
  targetUrl: URL,
  method: string,
  manager: InstanceProxyWorkspaceManager,
  workspaceId: string,
  client?: OpenCodeClient,
  signal?: AbortSignal,
): Promise<"allowed" | "invalid" | "foreign"> {
  if (method !== "GET" || targetUrl.pathname.replace(/\/+$/, "") !== "/api/session") return "allowed"
  const cursors = targetUrl.searchParams.getAll("cursor")
  if (cursors.length > 1) return "invalid"
  if (cursors.length === 1) {
    const scope = decodeSessionListScope(cursors[0])
    if (!scope) return "invalid"
    // A project cursor embeds its original wide scope; never reinterpret it as
    // a directory cursor when Git authority is unavailable.
    if (scope.project && !(await readGitStatus()).available) return "foreign"
    signal?.throwIfAborted()
    for (const key of ["directory", "location[directory]", "project", "subpath"]) {
      targetUrl.searchParams.delete(key)
    }
    return ownsSessionListScope(manager, workspaceId, scope, client, signal)
  }

  const projects = targetUrl.searchParams.getAll("project")
  const subpaths = targetUrl.searchParams.getAll("subpath")
  const directories = targetUrl.searchParams.getAll("directory")
  if (projects.length > 1 || subpaths.length > 1 || directories.length > 1
    || (subpaths.length && !projects.length)) return "invalid"
  const directory = directories[0]
  if (directory !== undefined && !directory.trim()) return "invalid"
  if (!projects.length) {
    return "allowed"
  }
  const project = projects[0]
  const subpath = subpaths[0]
  if (!project || (subpath !== undefined && !isSafeRelativePath(subpath))) return "invalid"
  const ownership = await ownsSessionListScope(manager, workspaceId, { project, subpath }, client, signal)
  if (ownership !== "allowed") return ownership
  if (!(await readGitStatus()).available) {
    signal?.throwIfAborted()
    if (directory && !await manager.ownsLocation(workspaceId, { directory }, client, { signal })) return "foreign"
    // Narrow the initial query, preserving native directory-scoped pagination.
    // Unlike a project cursor this request has no already-established scope.
    const root = manager.getServiceDirectory?.(workspaceId) ?? manager.get(workspaceId)?.path
    if (!root) return "foreign"
    targetUrl.searchParams.delete("project")
    targetUrl.searchParams.delete("subpath")
    targetUrl.searchParams.set("directory", root)
  }
  return "allowed"
}

function isSafeRelativePath(value: string): boolean {
  return value === "" || (!path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) && !value.split(/[\\/]/).includes(".."))
}

async function ownsSessionListScope(
  manager: InstanceProxyWorkspaceManager,
  workspaceId: string,
  scope: SessionListScope,
  client?: OpenCodeClient,
  signal?: AbortSignal,
): Promise<"allowed" | "foreign"> {
  signal?.throwIfAborted()
  if (scope.directory) {
    const owned = await manager.ownsLocation(workspaceId, { directory: scope.directory }, client, { signal })
    return owned ? "allowed" : "foreign"
  }
  if (!scope.project) return "foreign"
  const serviceClient = client ?? await manager.getSharedServiceClient()
  signal?.throwIfAborted()
  const project = (await serviceClient.project.list(undefined, { signal })).find((candidate) => candidate.id === scope.project)
  signal?.throwIfAborted()
  if (!project) return "foreign"
  const directory = scope.subpath === undefined
    ? project.canonical
    : /^[A-Za-z]:[\\/]|^\\\\/.test(project.canonical)
      ? path.win32.resolve(project.canonical, scope.subpath)
      : path.posix.resolve(project.canonical, scope.subpath)
  const owned = await manager.ownsLocation(workspaceId, { directory }, client, { signal })
  return owned ? "allowed" : "foreign"
}

function getPtyRouteId(pathname: string): string | null {
  return pathname.replace(/\/+$/, "").match(/^\/api\/pty\/([^/]+)$/)?.[1] ?? null
}

function getShellRouteId(pathname: string): string | null {
  return pathname.replace(/\/+$/, "").match(/^\/api\/shell\/([^/]+)(?:\/output)?$/)?.[1] ?? null
}

function buildInstanceTargetUrl(endpoint: string, pathSuffix: string | undefined): URL | null {
  const suffix = pathSuffix ?? ""
  if (/\\|%2f|%5c/i.test(suffix) || hasDotSegment(suffix)) return null
  const targetUrl = new URL(endpoint)
  const origin = targetUrl.origin
  targetUrl.pathname = normalizeInstanceSuffix(suffix).split("/").map(encodeURIComponent).join("/")
  targetUrl.search = ""
  targetUrl.hash = ""
  return targetUrl.origin === origin ? targetUrl : null
}

function hasDotSegment(value: string): boolean {
  return value.split("/").some((segment) => {
    let decoded = segment
    for (let depth = 0; depth < 3; depth++) {
      if (decoded === "." || decoded === "..") return true
      try {
        const next = decodeURIComponent(decoded)
        if (next === decoded) break
        decoded = next
      } catch {
        break
      }
    }
    return decoded === "." || decoded === ".."
  })
}

const SESSION_SETTLEMENT_WAIT = /^\/api\/experimental\/session\/[^/]+\/wait$/

function isAllowedInstanceApiRoute(method: string, pathname: string): boolean {
  const route = pathname.replace(/\/$/, "")
  const allowed: Array<[string, RegExp]> = [
    ["GET", /^\/api\/(?:agent|command|config|integration|location|mcp|model|plugin|provider|reference|skill)$/],
    ["GET", /^\/api\/(?:mcp\/resource|websearch\/provider)$/],
    ["GET", /^\/api\/agent\/[^/]+$/],
    ["GET", /^\/api\/model\/default$/],
    ["GET", /^\/api\/permission\/request$/],
    ["GET", /^\/api\/form$/],
    ["GET", /^\/api\/project$/],
    ["GET", /^\/api\/vcs(?:\/status)?$/],
    ["GET", /^\/api\/fs\/(?:list|read\/.+)$/],
    ["GET", /^\/api\/pty(?:\/[^/]+)?$/],
    ["GET", /^\/api\/shell(?:\/[^/]+(?:\/output)?)?$/],
    ["POST", /^\/api\/(?:pty|shell)$/],
    ["PUT", /^\/api\/pty\/[^/]+$/],
    ["DELETE", /^\/api\/pty\/[^/]+$/],
    ["DELETE", /^\/api\/shell\/[^/]+$/],
    ["POST", /^\/api\/experimental\/mcp\/[^/]+\/(?:connect|disconnect)$/],
    ["DELETE", /^\/api\/credential\/[^/]+$/],
    ["PATCH", /^\/api\/credential\/[^/]+$/],
    ["POST", /^\/api\/credential\/[^/]+\/activate$/],
    ["POST", /^\/api\/integration\/[^/]+\/connect\/(?:key|oauth|command|external)$/],
    ["POST", /^\/api\/plugin\/(?:check|update)$/],
    ["GET", /^\/api\/integration\/[^/]+\/connect\/(?:oauth|command)\/[^/]+$/],
    ["DELETE", /^\/api\/integration\/[^/]+\/connect\/(?:oauth|command)\/[^/]+$/],
    ["POST", /^\/api\/integration\/[^/]+\/connect\/oauth\/[^/]+\/complete$/],
    ["GET", /^\/api\/session(?:\/active)?$/],
    ["POST", /^\/api\/session$/],
    ["POST", /^\/api\/experimental\/session\/import$/],
    ["GET", /^\/api\/session\/[^/]+(?:\/message(?:\/[^/]+)?)?$/],
    ["GET", /^\/api\/session\/[^/]+\/inbox$/],
    ["GET", /^\/api\/session\/[^/]+\/(?:permission|form)$/],
    ["DELETE", /^\/api\/session\/[^/]+$/],
    ["DELETE", /^\/api\/session\/[^/]+\/inbox\/[^/]+$/],
    ["PATCH", /^\/api\/session\/[^/]+$/],
    ["POST", /^\/api\/session\/[^/]+\/(?:agent|model|move|prompt|command|shell|compact|interrupt|background|fork|generate)$/],
    ["POST", SESSION_SETTLEMENT_WAIT],
    ["PATCH", /^\/api\/session\/[^/]+\/inbox\/[^/]+$/],
    ["POST", /^\/api\/session\/[^/]+\/revert\/stage$/],
    ["DELETE", /^\/api\/session\/[^/]+\/revert$/],
    ["PUT", /^\/api\/experimental\/session\/[^/]+\/instructions\/entries\/[^/]+$/],
    ["DELETE", /^\/api\/experimental\/session\/[^/]+\/instructions\/entries\/[^/]+$/],
    ["GET", /^\/api\/experimental\/session\/[^/]+\/instructions\/entries$/],
    ["POST", /^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/],
    ["POST", /^\/api\/session\/[^/]+\/form\/[^/]+\/reply$/],
    ["DELETE", /^\/api\/session\/[^/]+\/form\/[^/]+$/],
    ["GET", /^\/api\/experimental\/session\/[^/]+\/log$/],
  ]
  return allowed.some(([allowedMethod, pattern]) => method === allowedMethod && pattern.test(route))
}

function replaceRequestDirectories(
  targetUrl: URL,
  body: unknown,
  replacements: ReadonlyMap<string, string>,
  pathname: string,
  method: string,
): unknown {
  for (const key of ["directory", "location[directory]"]) {
    const values = targetUrl.searchParams.getAll(key)
    if (!values.some((value) => replacements.has(value))) continue
    targetUrl.searchParams.delete(key)
    for (const value of values) targetUrl.searchParams.append(key, replacements.get(value) ?? value)
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || Buffer.isBuffer(body)) return body
  const replaceLocation = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Buffer.isBuffer(value)) return value
    const location = value as Record<string, unknown>
    return typeof location.directory === "string" && replacements.has(location.directory)
      ? { ...location, directory: replacements.get(location.directory) }
      : value
  }
  const input = { ...(body as Record<string, unknown>) }
  for (const key of ["directory", "cwd"]) {
    const value = input[key]
    if (typeof value === "string" && replacements.has(value)) input[key] = replacements.get(value)
  }
  input.location = replaceLocation(input.location)
  if (pathname !== "/api/experimental/session/import" || method !== "POST") return input
  input.info = input.info && typeof input.info === "object" && !Array.isArray(input.info) && !Buffer.isBuffer(input.info)
    ? { ...(input.info as Record<string, unknown>), location: replaceLocation((input.info as Record<string, unknown>).location) }
    : input.info
  if (Array.isArray(input.messages)) {
    input.messages = input.messages.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || Buffer.isBuffer(value)) return value
      const message = value as Record<string, unknown>
      if (message.type !== "location-switched") return value
      const next: Record<string, unknown> = { ...message, location: replaceLocation(message.location) }
      if (message.previous && typeof message.previous === "object" && !Array.isArray(message.previous) && !Buffer.isBuffer(message.previous)) {
        next.previous = {
          ...(message.previous as Record<string, unknown>),
          location: replaceLocation((message.previous as Record<string, unknown>).location),
        }
      }
      return next
    })
  }
  return input
}

function stripLocationSelectors(targetUrl: URL, body: unknown, workspaceDirectory: string, serviceDirectory: string): unknown {
  for (const key of ["directory", "location[directory]"]) {
    const values = targetUrl.searchParams.getAll(key)
    if (values.includes(workspaceDirectory)) {
      targetUrl.searchParams.delete(key)
      for (const value of values) targetUrl.searchParams.append(key, value === workspaceDirectory ? serviceDirectory : value)
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || Buffer.isBuffer(body)) return body
  const input = body as Record<string, unknown>
  const canonicalInput = { ...input }
  for (const key of ["directory", "cwd"]) {
    if (canonicalInput[key] === workspaceDirectory) canonicalInput[key] = serviceDirectory
  }
  const location = input.location
  if (!location || typeof location !== "object" || Array.isArray(location) || Buffer.isBuffer(location)) return canonicalInput
  const canonicalLocation = { ...(location as Record<string, unknown>) }
  if (canonicalLocation.directory === workspaceDirectory) canonicalLocation.directory = serviceDirectory
  return { ...canonicalInput, location: canonicalLocation }
}

function readPromptFilePaths(pathname: string, method: string, body: unknown) {
  const result = { paths: [] as string[], invalid: false }
  if (method !== "POST" || !/^\/api\/session\/[^/]+\/(?:prompt|command)\/?$/.test(pathname)) return result
  if (!body || typeof body !== "object" || Array.isArray(body) || Buffer.isBuffer(body)) return result
  const files = (body as Record<string, unknown>).files
  if (files === undefined) return result
  if (!Array.isArray(files)) return { paths: [], invalid: true }

  for (const file of files) {
    if (!file || typeof file !== "object" || Array.isArray(file) || Buffer.isBuffer(file)) {
      result.invalid = true
      continue
    }
    const uri = (file as Record<string, unknown>).uri
    if (typeof uri !== "string" || !uri.trim()) {
      result.invalid = true
      continue
    }
    const parsed = parsePromptFileUri(uri)
    if (parsed.invalid) result.invalid = true
    else if (parsed.path) result.paths.push(parsed.path)
  }
  return result
}

function parsePromptFileUri(value: string): { path?: string; invalid: boolean } {
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) return { path: value, invalid: value.includes("\0") }
  let uri: URL
  try {
    uri = new URL(value)
  } catch {
    return { invalid: true }
  }
  if (["data:", "http:", "https:"].includes(uri.protocol)) return { invalid: false }
  if (uri.protocol !== "file:" || (uri.hostname && uri.hostname !== "localhost") || uri.search || uri.hash || /%2f|%5c/i.test(uri.pathname)) {
    return { invalid: true }
  }
  try {
    const decoded = decodeURIComponent(uri.pathname)
    const localPath = /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded
    return { path: localPath, invalid: !localPath || localPath.includes("\0") }
  } catch {
    return { invalid: true }
  }
}

function replacePromptFileUris(body: unknown, replacements: ReadonlyMap<string, string>): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body) || Buffer.isBuffer(body)) return body
  const input = body as Record<string, unknown>
  if (!Array.isArray(input.files)) return body
  return {
    ...input,
    files: input.files.map((file) => {
      if (!file || typeof file !== "object" || Array.isArray(file) || Buffer.isBuffer(file)) return file
      const source = file as Record<string, unknown>
      if (typeof source.uri !== "string" || !/^file:/i.test(source.uri)) return file
      const parsed = parsePromptFileUri(source.uri)
      const translated = parsed.path ? replacements.get(parsed.path) : undefined
      if (!translated || translated === parsed.path) return file
      const uri = new URL("file:///")
      uri.pathname = translated.replace(/\\/g, "/")
      return { ...source, uri: uri.href }
    }),
  }
}

function prepareSessionImport(pathname: string, method: string, body: unknown, directory: string) {
  const result = { body, directories: [] as string[], locations: [] as LocationRef[], invalid: false }
  if (pathname !== "/api/experimental/session/import" || method !== "POST") return result
  return prepareLocationImport(body, directory)
}

function normalizeInstanceSuffix(pathSuffix: string | undefined) {
  if (!pathSuffix || pathSuffix === "/") {
    return "/"
  }
  const trimmed = pathSuffix.replace(/^\/+/, "")
  return trimmed.length === 0 ? "/" : `/${trimmed}`
}

function findUiEntry(dir: string): string {
  const name = "index.html"
  if (!dir || !fs.existsSync(path.join(dir, name))) return name
  try {
    const entries = fs.readdirSync(dir)
    return entries.includes(name) ? name : entries.find(entry => entry.toLowerCase() === name) ?? name
  } catch { return name }
}

function setupStaticUi(
  app: FastifyInstance,
  uiDir: string,
  uiEntry: string,
  authManager: AuthManager,
  previewManager: PreviewManager,
  logger: Logger,
  remotePreviewsAllowed: () => boolean,
  entryScheme: (request: FastifyRequest) => "http" | "https" | "either",
) {
  if (!uiDir) {
    app.log.warn("UI static directory not provided; API endpoints only")
    return
  }

  if (!fs.existsSync(uiDir)) {
    app.log.warn({ uiDir }, "UI static directory missing; API endpoints only")
    return
  }

  const identityRefused = new AsyncLocalStorage<{ original?: string }>()
  const negotiate = (request: FastifyRequest) => {
    // Only GET applies Range; Fastify's sender also sees the raw HEAD headers.
    if (request.method === "HEAD") delete request.raw.headers.range
    // Expand the wildcard for fastify-static, which maps it to gzip alone.
    const encodings = request.headers["accept-encoding"]?.toLowerCase().split(",") ?? []
    const explicit = new Map(encodings.map(entry => [entry.split(";", 1)[0]!.trim(), entry]))
    const quality = (entry: string) => Number(/;\s*q\s*=\s*([01](?:\.\d{0,3})?)\s*$/.exec(entry)?.[1] ?? 1)
    const identity = explicit.get("identity"), wildcard = explicit.get("*")
    const identityQuality = identity === undefined ? undefined : quality(identity)
    if (wildcard || identityQuality !== undefined) {
      request.headers["accept-encoding"] = ["br", "gzip", "deflate"]
        .map(coding => explicit.get(coding) ?? wildcard?.replace("*", coding))
        .filter(entry => entry !== undefined && quality(entry) >= (identityQuality ?? 0)).join(",")
    }
    return (identityQuality ?? (wildcard && quality(wildcard))) === 0
  }
  app.addHook("preHandler", (request, reply, done) => {
    const session = authManager.getSessionFromRequest(request)
    if (session && proxyPreviewFallbackFromReferer(request, reply, previewManager, logger, remotePreviewsAllowed, entryScheme)) {
      return
    }
    if (!("previewCapability" in request.routeOptions.config)
      && (request.routeOptions.url === "/" || request.routeOptions.url === "/*") && negotiate(request)) {
      return identityRefused.run({}, done)
    }
    done()
  })

  app.addHook("onSend", (request, reply, payload, done) => {
    if (identityRefused.getStore() !== undefined && reply.statusCode === 406) {
      reply.header("vary", "Origin, Accept-Encoding").removeHeader("content-length").removeHeader("content-type")
      return done(null, "")
    }
    done(null, payload)
  })

  app.register(fastifyStatic, {
    root: uiDir,
    prefix: "/",
    preCompressed: true,
    allowedPath: (file, _root, request) => {
      // Both authorization checks use logical paths, including a selected index.
      const refused = identityRefused.getStore()
      if (refused) refused.original = path.basename(file)
      return !isHtmlBundlePath(file) || Boolean(authManager.getSessionFromRequest(request))
    },
    onFile: (file) => {
      const refused = identityRefused.getStore()
      if (!refused) return
      const selected = path.basename(file)
      if (/\.(?:br|gz|deflate)$/.test(selected) && selected !== refused.original) return
      throw Object.assign(new Error("No acceptable static representation"), { statusCode: 406 })
    },
    setHeaders: (reply, file) => {
      if (isHtmlBundlePath(file)) reply.header("cache-control", "no-store")
    },
  })

  const indexPath = path.join(uiDir, uiEntry)

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const url = request.raw.url ?? ""
    if (isApiRequest(url)) {
      reply.code(404).send({ message: "Not Found" })
      return
    }

    const session = authManager.getSessionFromRequest(request)
    if (session && proxyPreviewFallbackFromReferer(request, reply, previewManager, logger, remotePreviewsAllowed, entryScheme)) {
      return
    }

    if (!session) {
      if (wantsHtml(request)) reply.redirect("/login")
      else reply.header("cache-control", "no-store").code(404).send({ message: "Not Found" })
      return
    }

    if (fs.existsSync(indexPath)) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return reply.header("cache-control", "no-store").type("text/html").send(fs.readFileSync(indexPath, "utf-8"))
      }
      const rejectIdentity = identityRefused.getStore() !== undefined || negotiate(request)
      return rejectIdentity ? identityRefused.run({}, () => reply.sendFile(uiEntry)) : reply.sendFile(uiEntry)
    } else {
      reply.code(404).send({ message: "UI bundle missing" })
    }
  })
}

function setupDevProxy(
  app: FastifyInstance,
  upstreamBase: string,
  authManager: AuthManager,
  previewManager: PreviewManager,
  logger: Logger,
  remotePreviewsAllowed: () => boolean,
) {
  app.log.info({ upstreamBase }, "Proxying UI requests to development server")
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const url = request.raw.url ?? ""
    if (isApiRequest(url)) {
      reply.code(404).send({ message: "Not Found" })
      return
    }

    const session = authManager.getSessionFromRequest(request)
    if (session && proxyPreviewFallbackFromReferer(request, reply, previewManager, logger, remotePreviewsAllowed)) {
      return
    }

    if (!session && wantsHtml(request)) {
      reply.redirect("/login")
      return
    }

    void proxyToDevServer(request, reply, upstreamBase)
  })
}

function proxyPreviewFallbackFromReferer(
  request: FastifyRequest,
  reply: FastifyReply,
  previewManager: PreviewManager,
  logger: Logger,
  remotePreviewsAllowed: () => boolean,
  entryScheme?: (request: FastifyRequest) => "http" | "https" | "either",
): boolean {
  // Remote Control serves preview content only while its host allows it.
  if (isRemoteRequest(request) && !remotePreviewsAllowed()) {
    return false
  }
  const rawUrl = request.raw.url ?? request.url ?? ""
  const entry = request.method === "GET" || request.method === "HEAD" ? routedPath(rawUrl) : null
  const pathname = rawUrl.split("?")[0] ?? ""
  if (!isPreviewFallbackPath(pathname)) {
    return false
  }

  const refererHeader = request.headers.referer ?? request.headers.referrer
  const referer = Array.isArray(refererHeader) ? refererHeader[0] : refererHeader
  if (!referer) {
    return false
  }
  const parsed = parsePreviewUpgradePath(referer)
  if (!parsed) return false

  if (entryScheme && (entry === "/" || entry === PAIR_PAGE_PATH)) {
    // A preview's same-origin resource may use this path; an external link is an app navigation.
    const host = request.headers.host
    if (!host || /[\s/\\@?#]/.test(host)) return false
    try {
      const scheme = entryScheme(request)
      if (scheme === "either") {
        // A shared HTTP listener cannot distinguish direct HTTP from a TLS terminator by Host.
        if (request.headers["sec-fetch-site"] === "cross-site") return false
        const source = new URL(referer, `https://${host}`)
        if (!/^https?:$/.test(source.protocol) || source.host !== new URL(`${source.protocol}//${host}`).host
          || !previewManager.get(parsed.token)) return false
      } else {
        const target = new URL(`${scheme}://${host}`)
        if (new URL(referer, target).origin !== target.origin) return false
      }
    } catch { return false }
  }

  void proxyPreviewAssetRequest({
    request,
    reply,
    previewManager,
    logger,
    token: parsed.token,
  })
  return true
}

function isPreviewFallbackPath(pathname: string): boolean {
  if (!pathname || pathname === "/") return false
  if (pathname.startsWith("/api/") || pathname === "/api") return false
  if (pathname.startsWith("/workspaces/")) return false
  if (pathname.startsWith("/sidecars/")) return false
  if (pathname.startsWith("/previews/")) return false
  if (pathname.startsWith("/auth/") || pathname === "/login") return false
  return true
}

async function proxyToDevServer(request: FastifyRequest, reply: FastifyReply, upstreamBase: string) {
  try {
    const targetUrl = new URL(request.raw.url ?? "/", upstreamBase)
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: buildProxyHeaders(request.headers),
    })

    response.headers.forEach((value, key) => {
      reply.header(key, value)
    })

    reply.code(response.status)

    if (!response.body || request.method === "HEAD") {
      reply.send()
      return
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    reply.send(buffer)
  } catch (error) {
    request.log.error({ err: error }, "Failed to proxy UI request to dev server")
    if (!reply.sent) {
      reply.code(502).send("UI dev server is unavailable")
    }
  }
}

function isApiRequest(rawUrl: string | null | undefined) {
  if (!rawUrl) return false
  const pathname = rawUrl.split("?")[0] ?? ""
  return pathname === "/api" || pathname.startsWith("/api/")
}

function buildProxyHeaders(headers: FastifyRequest["headers"]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (!value || key.toLowerCase() === "host") continue
    result[key] = Array.isArray(value) ? value.join(",") : value
  }
  return result
}

function getHeaderValue(headers: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const value = headers[key.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

const sourcePreviewRewrites = new PreviewBodyBudget()

export function rewritePreviewBodyUrls(body: string, publicBase: string, kind: "html" | "css" | "js", targetOrigin = "http://localhost", maxUnits = Infinity): string {
  let units = body.length
  const grow = (added: number) => {
    units += added
    if (units > maxUnits) throw new Error("Preview document too large")
  }
  if (kind === "css") {
    return rewriteCssPreviewUrls(body, publicBase, grow)
  }
  if (kind === "js") {
    return rewritePreviewJavaScriptImports(body, publicBase, grow)
  }

  const rewritten = rewriteCssPreviewUrls(
    body
      .replace(/\b(src|href|action|poster|data)=(["'])\/(?!\/)([^"']*)\2/gi, (_match, attr: string, quote: string, pathValue: string) => {
        grow(publicBase.length)
        return `${attr}=${quote}${publicBase}/${pathValue}${quote}`
      })
      .replace(/\bsrcset=(["'])([^"']*)\1/gi, (_match, quote: string, value: string) => {
        return `srcset=${quote}${rewriteSrcsetPreviewUrls(value, publicBase, grow)}${quote}`
      }),
    publicBase,
    grow,
  )
  const withInlineModules = rewritten.replace(/(<script\b([^>]*)>)([\s\S]*?)(<\/script>)/gi, (script, opening: string, attributes: string, source: string, closing: string) => {
    if (/\btype\s*=\s*(["'])module\1/i.test(attributes)) {
      return `${opening}${rewritePreviewJavaScriptImports(source, publicBase, grow)}${closing}`
    }
    if (/\btype\s*=\s*(["'])importmap\1/i.test(attributes)) {
      return `${opening}${rewritePreviewImportMap(source, publicBase, grow)}${closing}`
    }
    return script
  })
  const bridge = buildPreviewRuntimeBridge(publicBase, targetOrigin)
  grow(bridge.length)
  return /<head(?:\s[^>]*)?>/i.test(withInlineModules)
    ? withInlineModules.replace(/<head(?:\s[^>]*)?>/i, head => `${head}${bridge}`)
    : withInlineModules.startsWith("\ufeff") ? `\ufeff${bridge}${withInlineModules.slice(1)}` : `${bridge}${withInlineModules}`
}

function rewriteCssPreviewUrls(body: string, publicBase: string, grow: (units: number) => void): string {
  return body.replace(/url\((\s*)(["']?)\/(?!\/)([^"')]+)\2(\s*)\)/gi, (_match, before: string, quote: string, pathValue: string, after: string) => {
    grow(publicBase.length)
    return `url(${before}${quote}${publicBase}/${pathValue}${quote}${after})`
  })
}

function rewriteSrcsetPreviewUrls(value: string, publicBase: string, grow: (units: number) => void): string {
  return value
    .split(",")
    .map((entry) => {
      const trimmed = entry.trimStart()
      if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return entry
      grow(publicBase.length)
      const leading = entry.slice(0, entry.length - trimmed.length)
      return `${leading}${publicBase}${trimmed}`
    })
    .join(",")
}

async function proxySideCarRequest(args: {
  request: FastifyRequest
  reply: FastifyReply
  sidecarManager: SideCarManager
  logger: Logger
  sessionCookie: string
  pathSuffix?: string
}) {
  const sidecarId = (args.request.params as { id?: string }).id ?? ""
  const sidecar = await args.sidecarManager.get(sidecarId)
  if (!sidecar) {
    args.reply.code(404).send({ error: "SideCar not found" })
    return
  }

  const pathname = (args.request.raw.url ?? args.request.url ?? "").split("?")[0] ?? ""
  const queryIndex = (args.request.raw.url ?? args.request.url ?? "").indexOf("?")
  const search = queryIndex >= 0 ? (args.request.raw.url ?? args.request.url ?? "").slice(queryIndex) : ""
  const pathSuffix = args.pathSuffix ?? ""
  const requestPath = pathSuffix ? `${args.sidecarManager.buildProxyBasePath(sidecarId)}/${pathSuffix.replace(/^\/+/, "")}` : args.sidecarManager.buildProxyBasePath(sidecarId)
  const targetPath = args.sidecarManager.buildTargetPath(sidecarId, requestPath, search)
  const targetOrigin = args.sidecarManager.buildTargetOrigin(sidecar)
  const targetUrl = `${targetOrigin}${targetPath}`
  if (blocksHostProxyTarget(args.request.server.server, new URL(targetUrl))) {
    return args.reply.code(404).send({ error: "Not found" })
  }
  args.logger.debug({ sidecarId: sidecar.id, targetUrl, pathname, prefixMode: sidecar.prefixMode }, "Proxying request to SideCar")

  await proxyTargetRequest({
    reply: args.reply,
    logger: args.logger,
    targetUrl,
    targetOrigin,
    sessionCookie: args.sessionCookie,
    logContext: { sidecarId: sidecar.id },
    errorMessage: "SideCar proxy failed",
    rewriteHeaders: (headers) => sidecarResponseCookies(rewriteSideCarResponseHeaders(headers, sidecarId, targetOrigin, sidecar.prefixMode), args.sessionCookie),
  })
}

async function proxyPreviewRequest(args: {
  request: FastifyRequest
  reply: FastifyReply
  previewManager: PreviewManager
  logger: Logger
  token?: string
  publicBase?: string
  pathSuffix?: string
}) {
  const token = args.token ?? (args.request.params as { token?: string }).token ?? ""
  const preview = args.previewManager.get(token)
  if (!preview) {
    args.reply.code(404).send({ error: "Preview not found" })
    return
  }

  const rawUrl = args.request.raw.url ?? args.request.url ?? ""
  const queryIndex = rawUrl.indexOf("?")
  const search = queryIndex >= 0 ? rawUrl.slice(queryIndex) : ""
  const pathSuffix = args.pathSuffix ?? ""
  const publicBase = args.publicBase ?? args.previewManager.buildProxyBasePath(token)
  const requestPath = pathSuffix ? `${publicBase}/${pathSuffix.replace(/^\/+/, "")}` : publicBase
  const targetUrl = args.previewManager.buildTargetUrl(token, requestPath, search)
  if (!targetUrl) {
    args.reply.code(404).send({ error: "Preview not found" })
    return
  }

  args.logger.debug({ previewToken: token, targetUrl: targetUrl.toString() }, "Proxying request to preview")
  await proxyPreviewTargetRequest({
    request: args.request,
    reply: args.reply,
    logger: args.logger,
    targetUrl: targetUrl.toString(),
    targetOrigin: targetUrl.origin,
    publicBase,
    logContext: { previewToken: token },
    errorMessage: "Preview proxy failed",
    rewriteHeaders: (headers) => rewritePreviewResponseHeaders(headers, token, targetUrl.origin, publicBase),
  })
}

async function proxyPreviewAssetRequest(args: {
  request: FastifyRequest
  reply: FastifyReply
  previewManager: PreviewManager
  logger: Logger
  token: string
}) {
  const rawUrl = args.request.raw.url ?? args.request.url ?? ""
  const queryIndex = rawUrl.indexOf("?")
  const search = queryIndex >= 0 ? rawUrl.slice(queryIndex) : ""
  const pathname = rawUrl.split("?")[0] ?? "/"
  const targetUrl = args.previewManager.buildTargetUrl(args.token, pathname, search)
  if (!targetUrl) {
    args.reply.code(404).send({ error: "Preview not found" })
    return
  }

  args.logger.debug({ previewToken: args.token, targetUrl: targetUrl.toString() }, "Proxying preview fallback asset")
  await proxyPreviewTargetRequest({
    request: args.request,
    reply: args.reply,
    logger: args.logger,
    targetUrl: targetUrl.toString(),
    targetOrigin: targetUrl.origin,
    publicBase: args.previewManager.buildProxyBasePath(args.token),
    logContext: { previewToken: args.token, previewFallback: true },
    errorMessage: "Preview proxy failed",
    rewriteHeaders: (headers) => rewritePreviewResponseHeaders(headers, args.token, targetUrl.origin),
  })
}

async function proxyPreviewTargetRequest(args: {
  request: FastifyRequest
  reply: FastifyReply
  logger: Logger
  targetUrl: string
  targetOrigin: string
  publicBase: string
  logContext: Record<string, unknown>
  errorMessage: string
  rewriteHeaders: (headers: Record<string, string | string[] | undefined>) => Record<string, string | string[] | undefined>
}) {
  if (blocksHostProxyTarget(args.request.server.server, new URL(args.targetUrl))) {
    return args.reply.code(404).send({ error: "Not found" })
  }
  const target = withoutQuery(args.targetUrl)
  await args.reply.from(target.url, {
    queryString: () => target.query,
    rewriteRequestHeaders: (_originalRequest, headers) => {
      const next = sanitizeSideCarProxyRequestHeaders(headers as Record<string, string | string[] | undefined>, args.targetOrigin)
      next["accept-encoding"] = "identity"
      // Like preview upgrades, forward no cookies: a frame's document request
      // carries the app's own (CodeNomad session, SideCar service cookies).
      delete next.cookie
      return next
    },
    rewriteHeaders: (headers) => {
      const next = args.rewriteHeaders(headers as Record<string, string | string[] | undefined>)
      if (args.request.headers.origin === "null") {
        next["access-control-allow-origin"] = "null"
        delete next["access-control-allow-credentials"]
      }
      return next
    },
    onResponse: (_proxyRequest, proxyReply, upstreamResponse) => {
      const upstream = upstreamResponse.stream
      const headers = upstreamResponse.headers as Record<string, string | string[] | undefined>
      const type = getHeaderValue(headers, "content-type") ?? ""
      const kind = previewBodyKind(type)
      if (!kind) {
        proxyReply.send(upstream)
        return
      }
      const disconnect = new AbortController()
      const upstreamFailure = new AbortController()
      const failUpstream = (error: Error) => upstreamFailure.abort(error)
      // A paused upstream can fail before it receives a rewrite slot.
      upstream.on("error", failUpstream)
      const stop = () => disconnect.abort()
      proxyReply.raw.once("close", stop)
      if (proxyReply.raw.destroyed) stop()
      const encoding = getHeaderValue(headers, "content-encoding") ?? ""
      for (const name of ["content-length", "content-encoding", "etag", "last-modified", "content-range", "accept-ranges", "content-digest", "repr-digest", "digest", "content-md5"]) {
        proxyReply.removeHeader(name)
      }
      let body = upstream
      void (async () => {
        try {
          if (upstreamResponse.statusCode === 206 || headers["content-range"] !== undefined) throw new Error("Partial preview document")
          if (args.request.method === "HEAD" || [204, 205, 304].includes(upstreamResponse.statusCode)) {
            proxyReply.send(upstream)
            return
          }
          const signal = AbortSignal.any([disconnect.signal, upstreamFailure.signal])
          await sourcePreviewRewrites.run(() => (body = previewDocumentStream(upstream, encoding)), signal, async (bytes, deadline) => {
            const rewritten = rewritePreviewText(bytes, type,
              (text, maxUnits) => rewritePreviewBodyUrls(text, args.publicBase, kind, args.targetOrigin, maxUnits),
              sourcePreviewRewrites.bytes)
            deadline.throwIfAborted()
            const abortSend = () => proxyReply.raw.destroy()
            deadline.addEventListener("abort", abortSend, { once: true })
            try {
              const sent = finished(proxyReply.raw, { cleanup: true })
              proxyReply.send(rewritten)
              await sent
            } finally {
              deadline.removeEventListener("abort", abortSend)
            }
          })
        } catch (error) {
          body.destroy()
          upstream.destroy()
          if (disconnect.signal.aborted || proxyReply.sent) return
          args.logger.debug({ err: error }, args.errorMessage)
          proxyReply.removeHeader("location")
          proxyReply.type("application/json").code(502).send({ error: args.errorMessage })
        } finally {
          upstream.off("error", failUpstream)
          proxyReply.raw.removeListener("close", stop)
        }
      })()
    },
    onError: (proxyReply, { error }) => {
      args.logger.error({ ...args.logContext, err: error, targetUrl: args.targetUrl }, args.errorMessage)
      if (!proxyReply.sent) proxyReply.code(error.cause instanceof ProxyDestinationDenied ? 404 : 502).send({ error: args.errorMessage })
    },
  })
}

async function proxyTargetRequest(args: {
  reply: FastifyReply
  logger: Logger
  targetUrl: string
  targetOrigin: string
  sessionCookie: string
  logContext: Record<string, unknown>
  errorMessage: string
  rewriteHeaders: (headers: Record<string, string | string[] | undefined>) => Record<string, string | string[] | undefined>
}) {
  const target = withoutQuery(args.targetUrl)
  await args.reply.from(target.url, {
    queryString: () => target.query,
    rewriteRequestHeaders: (_originalRequest, headers) =>
      sanitizeSideCarProxyRequestHeaders(headers as Record<string, string | string[] | undefined>, args.targetOrigin, args.sessionCookie),
    rewriteHeaders: args.rewriteHeaders,
    onError: (reply, { error }) => {
      args.logger.error({ ...args.logContext, err: error, targetUrl: args.targetUrl }, args.errorMessage)
      if (!reply.sent) {
        reply.code(error.cause instanceof ProxyDestinationDenied ? 404 : 502).send({ error: args.errorMessage })
      }
    },
  })
}

function parseSideCarUpgradePath(rawUrl: string): { sidecarId: string; pathname: string; search: string } | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl, "http://localhost")
  } catch {
    return null
  }

  const match = parsed.pathname.match(/^\/sidecars\/([^/]+)(?:\/.*)?$/)
  if (!match) {
    return null
  }

  try {
    return {
      sidecarId: decodeURIComponent(match[1] ?? ""),
      pathname: parsed.pathname,
      search: parsed.search,
    }
  } catch {
    return null
  }
}

export function parsePreviewCapabilityHost(host: string | undefined): string | null {
  const hostname = host?.replace(/:\d+$/, "").toLowerCase() ?? ""
  return hostname.match(/^([0-9a-f-]{36})\.preview\.localhost$/)?.[1] ?? null
}

async function proxySideCarWebSocketUpgrade(args: {
  server: object
  request: import("http").IncomingMessage
  socket: Socket
  head: Buffer
  sidecarId: string
  incomingPath: string
  search: string
  sidecarManager: SideCarManager
  authManager: AuthManager
  logger: Logger
}) {
  const { request, socket, head, sidecarId, incomingPath, search, sidecarManager, authManager, logger } = args

  if (!isWebSocketUpgradeRequest(request)) {
    rejectUpgrade(socket, 400, "Bad Request")
    return
  }

  const session = authManager.getSessionFromHeaders(request.headers)
  if (!session) {
    rejectUpgrade(socket, 401, "Unauthorized")
    return
  }

  const sidecar = await sidecarManager.get(sidecarId)
  if (!sidecar) {
    rejectUpgrade(socket, 404, "Not Found")
    return
  }

  const targetOrigin = sidecarManager.buildTargetOrigin(sidecar)
  const targetPath = sidecarManager.buildTargetPath(sidecarId, incomingPath, search)
  const targetUrl = new URL(`${targetOrigin}${targetPath}`)
  logger.debug({ sidecarId, targetUrl: targetUrl.toString(), prefixMode: sidecar.prefixMode }, "Proxying websocket to SideCar")

  proxyTargetWebSocketUpgrade({
    server: args.server,
    request,
    socket,
    head,
    targetUrl,
    logger,
    logContext: { sidecarId },
    proxyLabel: "SideCar",
    sessionCookie: authManager.getCookieName(),
  })
}

async function proxyPreviewWebSocketUpgrade(args: {
  server: object
  request: import("http").IncomingMessage
  socket: Socket
  head: Buffer
  token: string
  incomingPath: string
  search: string
  previewManager: PreviewManager
  authManager: AuthManager
  logger: Logger
}) {
  const { request, socket, head, token, incomingPath, search, previewManager, authManager, logger } = args

  if (!isWebSocketUpgradeRequest(request)) {
    rejectUpgrade(socket, 400, "Bad Request")
    return
  }

  const session = authManager.getSessionFromHeaders(request.headers)
  if (!session && !previewManager.get(token)) {
    rejectUpgrade(socket, 401, "Unauthorized")
    return
  }

  const targetUrl = previewManager.buildTargetUrl(token, incomingPath, search)
  if (!targetUrl) {
    rejectUpgrade(socket, 404, "Not Found")
    return
  }

  logger.debug({ previewToken: token, targetUrl: targetUrl.toString() }, "Proxying websocket to preview")
  proxyTargetWebSocketUpgrade({
    server: args.server,
    request,
    socket,
    head,
    targetUrl,
    logger,
    logContext: { previewToken: token },
    proxyLabel: "preview",
    stripCookies: true,
  })
}

function proxyTargetWebSocketUpgrade(args: {
  server: object
  request: import("http").IncomingMessage
  socket: Socket
  head: Buffer
  targetUrl: URL
  logger: Logger
  logContext: Record<string, unknown>
  proxyLabel: string
  stripCookies?: boolean
  sessionCookie?: string
}) {
  if (blocksHostProxyTarget(args.server, args.targetUrl)) {
    return rejectUpgrade(args.socket, 404, "Not Found")
  }
  const headers = sanitizeSideCarProxyRequestHeaders(args.request.headers, args.targetUrl.origin, args.sessionCookie)
  if (args.stripCookies) delete headers.cookie
  proxyWebSocket({ ...args, headers, responseHeaders: incoming => {
    if (args.stripCookies) {
      const result = { ...incoming }
      delete result["set-cookie"]
      delete result["set-cookie2"]
      return result
    }
    return args.sessionCookie ? sidecarResponseCookies(incoming, args.sessionCookie) : incoming
  } })
}

function isWebSocketUpgradeRequest(request: import("http").IncomingMessage): boolean {
  const upgrade = request.headers.upgrade
  if (typeof upgrade !== "string" || upgrade.toLowerCase() !== "websocket") {
    return false
  }
  const connection = request.headers.connection
  const connectionValue = Array.isArray(connection) ? connection.join(",") : connection ?? ""
  return connectionValue.toLowerCase().split(",").map((part) => part.trim()).includes("upgrade")
}

function rejectUpgrade(socket: Socket, statusCode: number, statusText: string) {
  if (socket.destroyed) {
    return
  }
  socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

function rewriteSideCarResponseHeaders(
  headers: Record<string, string | string[] | undefined>,
  sidecarId: string,
  targetOrigin: string,
  prefixMode: "strip" | "preserve",
) {
  if (prefixMode === "preserve") {
    return headers
  }

  const next = { ...headers }
  const locationHeader = next.location
  const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader
  if (!location) {
    return next
  }

  const publicBase = `/sidecars/${encodeURIComponent(sidecarId)}`

  if (location.startsWith("/")) {
    next.location = `${publicBase}${location}`
    return next
  }

  try {
    const parsed = new URL(location)
    if (parsed.origin === targetOrigin) {
      next.location = `${publicBase}${parsed.pathname}${parsed.search}${parsed.hash}`
    }
  } catch {
    // Relative redirects should continue to resolve against the public sidecar path.
  }

  return next
}

function rewritePreviewResponseHeaders(
  headers: Record<string, string | string[] | undefined>,
  token: string,
  targetOrigin: string,
  publicBase = `/previews/${encodeURIComponent(token)}`,
) {
  const next = { ...headers }
  delete next["x-frame-options"]
  delete next["content-security-policy"]
  delete next["content-security-policy-report-only"]
  delete next["set-cookie"]
  delete next["set-cookie2"]
  // Path previews share CodeNomad's origin: keep every document opaque however it
  // is opened, and keep the capability path out of Referer headers to other sites.
  if (publicBase) {
    next["content-security-policy"] = `sandbox ${PREVIEW_SANDBOX_FLAGS}`
    next["referrer-policy"] = "same-origin"
  }

  const locationHeader = next.location
  const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader
  if (!location) {
    return next
  }

  if (location.startsWith("//")) {
    const parsed = new URL(location, targetOrigin)
    next.location = parsed.origin === targetOrigin
      ? `${publicBase}${parsed.pathname}${parsed.search}${parsed.hash}`
      : parsed.href
    return next
  }
  if (location.startsWith("/")) {
    next.location = `${publicBase}${location}`
    return next
  }

  try {
    const parsed = new URL(location)
    if (parsed.origin === targetOrigin) {
      next.location = `${publicBase}${parsed.pathname}${parsed.search}${parsed.hash}`
    }
  } catch {
    // Relative redirects should continue to resolve against the current preview path.
  }

  return next
}

function sanitizeSideCarProxyRequestHeaders(
  headers: Record<string, string | string[] | undefined>,
  targetOrigin: string,
  sessionCookie?: string,
): Record<string, string | string[] | undefined> {
  const blockedHeaders = getBlockedSideCarRequestHeaders()
  const next: Record<string, string | string[] | undefined> = {}

  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue
    if (blockedHeaders.has(key.toLowerCase())) continue
    const forwarded = key.toLowerCase() === "cookie" && sessionCookie ? sidecarRequestCookies(value, sessionCookie) : value
    if (forwarded !== undefined) next[key] = forwarded
  }

  next.origin = targetOrigin
  return next
}

function getBlockedSideCarRequestHeaders(): Set<string> {
  return new Set([
    "host",
    "expect",
    "authorization",
    "proxy-authorization",
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-proto",
  ])
}
