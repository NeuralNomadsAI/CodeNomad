import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify"
import cors from "@fastify/cors"
import fastifyStatic from "@fastify/static"
import replyFrom from "@fastify/reply-from"
import fs from "fs"
import { connect as connectTcp, type Socket } from "net"
import path from "path"
import type { Readable } from "stream"
import { connect as connectTls, type TLSSocket } from "tls"
import { fetch } from "undici"
import type { Logger } from "../logger"
import { WorkspaceManager } from "../workspaces/manager"
import { isInvalidRequestError, isPtyNotFoundError, isSessionNotFoundError, isShellNotFoundError, type LocationRef, type OpenCodeClient } from "@opencode-ai/client"

import type { SettingsService } from "../settings/service"
import { FileSystemBrowser } from "../filesystem/browser"
import { EventBus } from "../events/bus"
import { registerWorkspaceRoutes } from "./routes/workspaces"
import { registerSettingsRoutes } from "./routes/settings"
import { registerFilesystemRoutes } from "./routes/filesystem"
import { registerConfigFileRoutes } from "./routes/config-files"
import { registerMetaRoutes } from "./routes/meta"
import { registerEventRoutes } from "./routes/events"
import { registerStorageRoutes } from "./routes/storage"
import { registerYoloRoutes } from "./routes/yolo"
import { registerWorktreeRoutes } from "./routes/worktrees"
import { registerSpeechRoutes } from "./routes/speech"
import { registerOpenCodeUpdateRoutes } from "./routes/opencode-update"
import { registerRemoteControlRoutes } from "./routes/remote-control"
import { registerSideCarRoutes } from "./routes/sidecars"
import { registerPreviewRoutes } from "./routes/previews"
import { registerUsageRoutes } from "./routes/usage"
import { ServerMeta } from "../api-types"
import { InstanceStore } from "../storage/instance-store"
import type { AutoAcceptManager } from "../permissions/auto-accept-manager"
import type { AuthManager } from "../auth/manager"
import { registerAuthRoutes } from "./routes/auth"
import { sendUnauthorized, wantsHtml } from "../auth/http-auth"
import type { SpeechService } from "../speech/service"
import { ClientConnectionManager } from "../clients/connection-manager"
import type { SideCarManager } from "../sidecars/manager"
import type { PreviewManager } from "../previews/manager"
import { buildPreviewRuntimeBridge, rewritePreviewImportMap, rewritePreviewJavaScriptImports } from "../previews/runtime-bridge"
import type { RemoteControlManager } from "../remote-control/manager"
import { createOpenCodeUpdateService } from "../opencode-update/service"
import { WorktreeDeletionFence } from "../workspaces/worktree-session-evacuation"
import type { NativeParent } from "../native-parent"
import { isAutomationPluginRequest, registerAutomationPluginRoute } from "./routes/automation-plugin"
import { DeveloperCdp } from "../developer-cdp"

interface HttpServerDeps {
  bindHost: string
  bindPort: number
  /** When bindPort is 0, try this first. */
  defaultPort: number
  protocol: "http" | "https"
  httpsOptions?: { key: string | Buffer; cert: string | Buffer; ca?: string | Buffer }
  workspaceManager: WorkspaceManager
  settings: SettingsService
  fileSystemBrowser: FileSystemBrowser
  eventBus: EventBus
  serverMeta: ServerMeta
  instanceStore: InstanceStore
  speechService: SpeechService
  sidecarManager: SideCarManager
  previewManager: PreviewManager
  authManager: AuthManager
  clientConnectionManager: ClientConnectionManager
  remoteControlManager: RemoteControlManager
  yoloManager: AutoAcceptManager
  uiStaticDir: string
  uiDevServerUrl?: string
  logger: Logger
  nativeParent: NativeParent
  automationBridgeToken: string
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

export function createHttpServer(deps: HttpServerDeps) {
  // Fastify's type-level RawServer inference gets noisy when toggling HTTP vs HTTPS.
  // We keep the runtime behavior correct and cast the instance to a generic FastifyInstance.
  const app = Fastify(
    ({
      logger: false,
      ...(deps.protocol === "https" && deps.httpsOptions ? { https: deps.httpsOptions } : {}),
    } as unknown) as any,
  ) as unknown as FastifyInstance
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

  app.addHook("onRequest", (request, _reply, done) => {
    ;(request as FastifyRequest & { __logMeta?: { start: bigint } }).__logMeta = {
      start: process.hrtime.bigint(),
    }
    done()
  })

  app.addHook("onResponse", (request, reply, done) => {
    const meta = (request as FastifyRequest & { __logMeta?: { start: bigint } }).__logMeta
    const durationMs = meta ? Number((process.hrtime.bigint() - meta.start) / BigInt(1_000_000)) : undefined
    const base = {
      method: request.method,
      url: request.url,
      status: reply.statusCode,
      durationMs,
    }
    apiLogger.debug(base, "HTTP request completed")
    if (apiLogger.isLevelEnabled("trace")) {
      apiLogger.trace({
        ...base,
        params: redactSecrets(request.params),
        query: redactSecrets(request.query),
        body: typeof request.body === "string" ? "<redacted>" : redactSecrets(request.body),
      }, "HTTP request payload")
    }
    done()
  })

  const allowedDevOrigins = new Set(["http://localhost:3000", "http://127.0.0.1:3000"])
  const getSelfOrigins = (): Set<string> => {
    const origins = new Set<string>()
    const candidates: Array<string | undefined> = [deps.serverMeta.localUrl]
    for (const candidate of candidates) {
      if (!candidate) continue
      try {
        origins.add(new URL(candidate).origin)
      } catch {
        // ignore
      }
    }
    return origins
  }

  app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) {
        cb(null, true)
        return
      }

      const selfOrigins = getSelfOrigins()
      if (selfOrigins.has(origin)) {
        cb(null, true)
        return
      }

      if (origin === "null") {
        cb(null, true)
        return
      }

       if (allowedDevOrigins.has(origin)) {
         cb(null, true)
         return
       }

      cb(null, false)
    },
    credentials: true,
  })

  app.register(replyFrom, {
    contentTypesToEncode: [],
    undici: {
      connections: 16,
      pipelining: 1,
      bodyTimeout: 0,
      headersTimeout: 0,
    },
  })

  registerAuthRoutes(app, { authManager: deps.authManager })

  app.addHook("preHandler", (request, reply, done) => {
    const rawUrl = request.raw.url ?? request.url
    const pathname = (rawUrl.split("?")[0] ?? "").trim()

    const publicApiPaths = new Set(["/api/auth/login", "/api/auth/token", "/api/auth/status", "/api/auth/logout"])
    const publicPagePaths = new Set(["/login"])
    if (deps.authManager.isTokenBootstrapEnabled()) {
      publicPagePaths.add("/auth/token")
    }

    const encodedPreviewToken = pathname.match(/^\/previews\/([^/]+)(?:\/|$)/)?.[1]
    const hostPreviewToken = parsePreviewCapabilityHost(request.headers.host)
    let isPreviewCapability = false
    if (hostPreviewToken) {
      isPreviewCapability = Boolean(deps.previewManager.get(hostPreviewToken))
    } else if (encodedPreviewToken) {
      try {
        isPreviewCapability = Boolean(deps.previewManager.get(decodeURIComponent(encodedPreviewToken)))
      } catch {
        // Malformed capability paths remain subject to normal authentication.
      }
    }

    if (request.headers.origin === "null" && !isPreviewCapability) {
      reply.code(403).send({ error: "Opaque origins may access preview capabilities only" })
      return
    }

    const isAutomationBridge = isAutomationPluginRequest(request, {
      authManager: deps.authManager,
      bridgeToken: deps.automationBridgeToken,
    })
    if (publicApiPaths.has(pathname) || publicPagePaths.has(pathname) || isPreviewCapability || isAutomationBridge) {
      done()
      return
    }

    const session = deps.authManager.getSessionFromRequest(request)

    const requiresAuthForApi = pathname.startsWith("/api/") || pathname.startsWith("/workspaces/") || pathname.startsWith("/sidecars/") || pathname.startsWith("/previews/")
    if (requiresAuthForApi && !session) {
      sendUnauthorized(request, reply)
      return
    }

    if (!session && wantsHtml(request)) {
      reply.redirect("/login")
      return
    }

    done()
  })

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
    const indexPath = path.join(uiDir, "index.html")
    if (uiDir && fs.existsSync(indexPath)) {
      reply.type("text/html").send(fs.readFileSync(indexPath, "utf-8"))
      return
    }

    reply.code(404).send({ message: "UI bundle missing" })
  })

  const worktreeDeletionFence = new WorktreeDeletionFence()
  registerWorkspaceRoutes(app, { workspaceManager: deps.workspaceManager, worktreeDeletionFence })
  registerSettingsRoutes(app, { settings: deps.settings, logger: apiLogger })
  registerOpenCodeUpdateRoutes(app, {
    service: createOpenCodeUpdateService(deps.settings, deps.workspaceManager),
    logger: apiLogger,
  })
  registerFilesystemRoutes(app, { fileSystemBrowser: deps.fileSystemBrowser })
  registerConfigFileRoutes(app)
  registerMetaRoutes(app, { serverMeta: deps.serverMeta })
  registerEventRoutes(app, {
    eventBus: deps.eventBus,
    registerClient: registerSseClient,
    logger: sseLogger,
    connectionManager: deps.clientConnectionManager,
  })
  registerWorktreeRoutes(app, { workspaceManager: deps.workspaceManager, worktreeDeletionFence })
  registerStorageRoutes(app, {
    instanceStore: deps.instanceStore,
    eventBus: deps.eventBus,
    workspaceManager: deps.workspaceManager,
  })
  registerRemoteControlRoutes(app, { manager: deps.remoteControlManager })
  registerSpeechRoutes(app, { speechService: deps.speechService })
  registerSideCarRoutes(app, { sidecarManager: deps.sidecarManager })
  registerPreviewRoutes(app, { previewManager: deps.previewManager })
  const developerCdp = new DeveloperCdp()
  registerAutomationPluginRoute(app, {
    authManager: deps.authManager,
    bridgeToken: deps.automationBridgeToken,
    nativeParent: deps.nativeParent,
    developerCdp,
    workspaceManager: deps.workspaceManager,
  })
  app.addHook("onClose", async () => developerCdp.close())
  registerUsageRoutes(app)
  registerSideCarProxyRoutes(app, { sidecarManager: deps.sidecarManager, logger: proxyLogger })
  registerPreviewProxyRoutes(app, { previewManager: deps.previewManager, logger: proxyLogger })
  setupSideCarWebSocketProxy(app, {
    sidecarManager: deps.sidecarManager,
    authManager: deps.authManager,
    logger: proxyLogger,
  })
  setupPreviewWebSocketProxy(app, {
    previewManager: deps.previewManager,
    authManager: deps.authManager,
    logger: proxyLogger,
  })
  registerYoloRoutes(app, { yoloManager: deps.yoloManager })
  registerInstanceProxyRoutes(app, { workspaceManager: deps.workspaceManager, logger: proxyLogger, worktreeDeletionFence })


  if (deps.uiDevServerUrl) {
    setupDevProxy(app, deps.uiDevServerUrl, deps.authManager, deps.previewManager, proxyLogger)
  } else {
    setupStaticUi(app, deps.uiStaticDir, deps.authManager, deps.previewManager, proxyLogger)
  }

  return {
    instance: app,
    start: async (): Promise<HttpServerStartResult> => {
      const attemptListen = async (requestedPort: number) => {
        const addressInfo = await app.listen({ port: requestedPort, host: deps.bindHost })
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

      const displayHost = deps.bindHost === "127.0.0.1" ? "localhost" : deps.bindHost
      const serverUrl = `${deps.protocol}://${displayHost}:${actualPort}`

      deps.logger.info({ port: actualPort, host: deps.bindHost, protocol: deps.protocol }, "HTTP server listening")

      return { port: actualPort, url: serverUrl, displayHost }
    },
    stop: () => {
      closeSseClients()
      return app.close()
    },
  }
}

export interface InstanceProxyWorkspaceManager {
  get(id: string): ReturnType<WorkspaceManager["get"]>
  getSharedServiceEndpoint(id: string): ReturnType<WorkspaceManager["getSharedServiceEndpoint"]>
  invalidateSharedServiceConnection?(): void
  getInstanceAuthorizationHeader(id: string): string | undefined
  getServiceDirectory?(id: string): string | undefined
  getServiceDirectoryForPath?(id: string, directory: string): Promise<string | undefined>
  getWorktreeIdentityForPath(id: string, directory: string): Promise<string | undefined>
  getServicePathForPath?(id: string, candidate: string): Promise<string | undefined>
  getSharedServiceClient(): Promise<OpenCodeClient>
  ownsLocation(id: string, location: LocationRef): ReturnType<WorkspaceManager["ownsLocation"]>
  ownsLocationWorkspace(id: string, workspaceID: string): ReturnType<WorkspaceManager["ownsLocationWorkspace"]>
  ownsDirectory(id: string, directory: string): Promise<boolean>
  ownsPath(id: string, candidate: string): Promise<boolean>
}

interface InstanceProxyDeps {
  workspaceManager: InstanceProxyWorkspaceManager
  logger: Logger
  worktreeDeletionFence: WorktreeDeletionFence
}

interface SideCarProxyDeps {
  sidecarManager: SideCarManager
  logger: Logger
}

interface SideCarWebSocketProxyDeps extends SideCarProxyDeps {
  authManager: AuthManager
}

interface PreviewProxyDeps {
  previewManager: PreviewManager
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
      pathSuffix: request.params["*"] ?? "",
    })
  }

  app.all("/sidecars/:id", proxyBaseHandler)
  app.all("/sidecars/:id/*", proxyWildcardHandler)
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

    previewApp.all("/", { constraints: { host: capabilityHost } }, hostHandler)
    previewApp.all("/*", { constraints: { host: capabilityHost } }, hostHandler)
    previewApp.all("/previews/:token", async (request: FastifyRequest<{ Params: { token: string } }>, reply) => {
      await proxyPreviewRequest({ request, reply, previewManager: deps.previewManager, logger: deps.logger, pathSuffix: "" })
    })
    previewApp.all("/previews/:token/*", async (request: FastifyRequest<{ Params: { token: string; "*": string } }>, reply) => {
      await proxyPreviewRequest({
        request,
        reply,
        previewManager: deps.previewManager,
        logger: deps.logger,
        pathSuffix: request.params["*"] ?? "",
      })
    })
  })
}

function setupSideCarWebSocketProxy(app: FastifyInstance, deps: SideCarWebSocketProxyDeps) {
  app.server.on("upgrade", (request, socket, head) => {
    if (parsePreviewCapabilityHost(request.headers.host)) return
    const rawUrl = request.url ?? "/"
    const parsed = parseSideCarUpgradePath(rawUrl)
    if (!parsed) {
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
    })
  })
}

function setupPreviewWebSocketProxy(app: FastifyInstance, deps: PreviewWebSocketProxyDeps) {
  app.server.on("upgrade", (request, socket, head) => {
    const rawUrl = request.url ?? "/"
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

    void proxyPreviewWebSocketUpgrade({
      request,
      socket: socket as Socket,
      head,
      token: parsed.token,
      incomingPath: parsed.pathname,
      search: parsed.search,
      previewManager: deps.previewManager,
      authManager: deps.authManager,
      logger: deps.logger,
    })
  })
}

export function registerInstanceProxyRoutes(app: FastifyInstance, deps: InstanceProxyDeps) {
  app.register(async (instance) => {
    instance.removeAllContentTypeParsers()
    instance.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
      try {
        done(null, body.length ? JSON.parse(body.toString()) : {})
      } catch {
        done(Object.assign(new Error("Invalid JSON request body"), { statusCode: 400 }), undefined)
      }
    })
    instance.addContentTypeParser("*", (req, body, done) => done(null, body))

    const proxyBaseHandler = async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      await proxyWorkspaceRequest({
        request,
        reply,
        workspaceManager: deps.workspaceManager,
        worktreeDeletionFence: deps.worktreeDeletionFence,
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
        pathSuffix: request.params["*"] ?? "",
        logger: deps.logger,
      })
    }

    instance.all("/workspaces/:id/instance", proxyBaseHandler)
    instance.all("/workspaces/:id/instance/*", proxyWildcardHandler)
  })
}

async function proxyWorkspaceRequest(args: {
  request: FastifyRequest
  reply: FastifyReply
  workspaceManager: InstanceProxyWorkspaceManager
  worktreeDeletionFence: WorktreeDeletionFence
  logger: Logger
  pathSuffix?: string
}) {
  const { request, reply, workspaceManager, logger, worktreeDeletionFence } = args
  const workspaceId = (request.params as { id: string }).id
  const workspace = workspaceManager.get(workspaceId)

  if (!workspace) {
    reply.code(404).send({ error: "Workspace not found" })
    return
  }

  const rawInstancePath = (request.raw.url ?? "").split("?", 1)[0]?.match(/\/instance(?:\/(.*))?$/)?.[1] ?? ""
  if (/\\|%2f|%5c/i.test(rawInstancePath) || hasDotSegment(rawInstancePath)) {
    reply.code(400).send({ error: "Invalid workspace instance path" })
    return
  }
  const routeUrl = buildInstanceTargetUrl("http://127.0.0.1", args.pathSuffix)
  if (!routeUrl) {
    reply.code(400).send({ error: "Invalid workspace instance path" })
    return
  }
  const pathname = decodeURIComponent(routeUrl.pathname)
  if (!isAllowedInstanceApiRoute(request.method, pathname)) {
    reply.code(403).send({ error: "OpenCode route is not available through a workspace" })
    return
  }

  const endpoint = await workspaceManager.getSharedServiceEndpoint(workspaceId)
  if (!endpoint) {
    reply.code(502).send({ error: "OpenCode service is not ready" })
    return
  }

  const targetUrl = buildInstanceTargetUrl(endpoint.url, args.pathSuffix)
  if (!targetUrl) {
    reply.code(400).send({ error: "Invalid workspace instance path" })
    return
  }
  appendIncomingQuery(targetUrl, request.raw.url ?? "")
  if (pathname.replace(/\/+$/, "") === "/api/session/active") {
    if (request.method !== "GET") {
      reply.code(405).send({ error: "Method not allowed" })
      return
    }
    const client = await workspaceManager.getSharedServiceClient()
    const active = await client.session.active()
    const entries = await Promise.all(Object.entries(active).map(async ([sessionId, status]) => {
      try {
        const session = await client.session.get({ sessionID: sessionId })
        return await workspaceManager.ownsDirectory(workspaceId, session.location.directory) ? [sessionId, status] as const : null
      } catch {
        return null
      }
    }))
    reply.send(Object.fromEntries(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null)))
    return
  }
  if (pathname.replace(/\/+$/, "") === "/api/project") {
    const projects = await (await workspaceManager.getSharedServiceClient()).project.list()
    const ownedProjects = await Promise.all(projects.map(async (project) => {
      if (!await workspaceManager.ownsDirectory(workspaceId, project.canonical)) return null
      const sandboxes = (await Promise.all(project.sandboxes.map(async (directory) => (
        await workspaceManager.ownsDirectory(workspaceId, directory) ? directory : null
      )))).filter((directory): directory is string => directory !== null)
      return { ...project, sandboxes }
    }))
    reply.send(ownedProjects.filter((project): project is NonNullable<typeof project> => project !== null))
    return
  }
  const sessionListHasScope = request.method === "GET"
    && pathname.replace(/\/+$/, "") === "/api/session"
    && (targetUrl.searchParams.has("cursor") || targetUrl.searchParams.has("project") || targetUrl.searchParams.has("workspace"))
  const sessionListScope = await authorizeSessionList(targetUrl, request.method, workspaceManager, workspaceId)
  if (sessionListScope !== "allowed") {
    reply.code(sessionListScope === "invalid" ? 400 : 403).send({ error: "Session list does not belong to workspace" })
    return
  }
  const serviceDirectory = workspaceManager.getServiceDirectory?.(workspaceId) ?? workspace.path
  let globalFormLocation: LocationRef | undefined
  if (isGlobalFormAction(pathname, request.method)) {
    const directoryHeader = request.headers["x-opencode-directory"]
    const workspaceHeader = request.headers["x-opencode-workspace"]
    if (Array.isArray(directoryHeader) || Array.isArray(workspaceHeader)) {
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
    if (workspaceHeader !== undefined && !workspaceHeader.trim()) {
      reply.code(400).send({ error: "Invalid Form location" })
      return
    }
    if (directory !== undefined || workspaceHeader !== undefined) {
      globalFormLocation = {
        directory: directory ?? workspace.path,
        ...(workspaceHeader ? { workspaceID: workspaceHeader } : {}),
      }
    }
  }
  const imported = prepareSessionImport(
    pathname,
    request.method,
    stripLocationSelectors(targetUrl, request.body, workspace.path, serviceDirectory),
    serviceDirectory,
  )
  const requestLocations = readRequestDirectories(targetUrl, imported.body, workspace.path)
  if (globalFormLocation) {
    requestLocations.directories.push(globalFormLocation.directory)
    requestLocations.locations.push(globalFormLocation)
  }
  requestLocations.directories.push(...imported.directories)
  requestLocations.locations.push(...imported.locations)
  requestLocations.invalid ||= imported.invalid
  readNativeCwd(targetUrl, imported.body, requestLocations)
  const promptFiles = readPromptFilePaths(pathname, request.method, imported.body)
  if (requestLocations.invalid
    || !(await allDirectoriesOwned(workspaceManager, workspaceId, requestLocations.directories))
    || !(await allLocationsOwned(workspaceManager, workspaceId, requestLocations.locations))) {
    reply.code(requestLocations.invalid ? 400 : 403).send({ error: "Location does not belong to workspace" })
    return
  }
  const translatedDirectories = new Map<string, string>()
  for (const directory of new Set(requestLocations.directories)) {
    const translated = workspaceManager.getServiceDirectoryForPath
      ? await workspaceManager.getServiceDirectoryForPath(workspaceId, directory)
      : directory
    if (!translated) {
      reply.code(403).send({ error: "Location does not belong to workspace" })
      return
    }
    translatedDirectories.set(directory, translated)
  }
  const mutationIdentities = new Set<string>()
  if (request.method !== "GET" && request.method !== "HEAD") {
    for (const directory of requestLocations.directories) {
      const identity = await workspaceManager.getWorktreeIdentityForPath(workspaceId, directory)
      if (!identity) {
        reply.code(403).send({ error: "Location does not belong to workspace" })
        return
      }
      mutationIdentities.add(identity)
    }
  }
  const serviceBody = replaceRequestDirectories(targetUrl, imported.body, translatedDirectories, pathname, request.method)
  if (promptFiles.invalid || !(await allPathsOwned(workspaceManager, workspaceId, promptFiles.paths))) {
    reply.code(promptFiles.invalid ? 400 : 403).send({ error: "Prompt file does not belong to workspace" })
    return
  }
  const translatedPromptPaths = new Map<string, string>()
  for (const candidate of new Set(promptFiles.paths)) {
    const translated = workspaceManager.getServicePathForPath
      ? await workspaceManager.getServicePathForPath(workspaceId, candidate)
      : candidate
    if (!translated) {
      reply.code(403).send({ error: "Prompt file does not belong to workspace" })
      return
    }
    translatedPromptPaths.set(candidate, translated)
  }
  const promptBody = replacePromptFileUris(serviceBody, translatedPromptPaths)

  const requestedDirectory = requestLocations.directories[0]
  const runtimeLocation = { directory: requestedDirectory ? translatedDirectories.get(requestedDirectory) ?? serviceDirectory : serviceDirectory }
  if (pathname.replace(/\/+$/, "") === "/api/pty" && request.method === "GET") {
    const result = await (await workspaceManager.getSharedServiceClient()).pty.list({ location: runtimeLocation })
    const ownership = await Promise.all(result.data.map((pty) => workspaceManager.ownsDirectory(workspaceId, pty.cwd)))
    reply.send({ ...result, data: result.data.filter((_, index) => ownership[index]) })
    return
  }

  const ptyId = getPtyRouteId(pathname)
  if (ptyId) {
    try {
      const pty = await (await workspaceManager.getSharedServiceClient()).pty.get({ ptyID: ptyId, location: runtimeLocation })
      if (!(await workspaceManager.ownsDirectory(workspaceId, pty.data.cwd))) {
        reply.code(403).send({ error: "PTY does not belong to workspace" })
        return
      }
    } catch (error) {
      if (isPtyNotFoundError(error)) {
        reply.code(404).send({ error: "PTY not found" })
        return
      }
      throw error
    }
  }

  if (pathname.replace(/\/+$/, "") === "/api/shell" && request.method === "GET") {
    const result = await (await workspaceManager.getSharedServiceClient()).shell.list({ location: runtimeLocation })
    const ownership = await Promise.all(result.data.map((shell) => workspaceManager.ownsDirectory(workspaceId, shell.cwd)))
    reply.send({ ...result, data: result.data.filter((_, index) => ownership[index]) })
    return
  }

  const shellId = getShellRouteId(pathname)
  if (shellId) {
    try {
      const shell = await (await workspaceManager.getSharedServiceClient()).shell.get({ id: shellId, location: runtimeLocation })
      if (!(await workspaceManager.ownsDirectory(workspaceId, shell.data.cwd))) {
        reply.code(403).send({ error: "Shell does not belong to workspace" })
        return
      }
    } catch (error) {
      if (isShellNotFoundError(error)) {
        reply.code(404).send({ error: "Shell not found" })
        return
      }
      throw error
    }
  }

  const sessionId = getSessionRouteId(pathname)
  if (sessionId && !isGlobalFormAction(pathname, request.method)) {
    let session
    try {
      session = await (await workspaceManager.getSharedServiceClient()).session.get({ sessionID: sessionId })
    } catch (error) {
      if (isInvalidRequestError(error)) {
        reply.code(400).send({ error: "Invalid session ID" })
        return
      }
      if (isSessionNotFoundError(error)) {
        reply.code(404).send({ error: "Session not found" })
        return
      }
      throw error
    }
    if (!(await workspaceManager.ownsDirectory(workspaceId, session.location.directory))) {
      reply.code(403).send({ error: "Session does not belong to workspace" })
      return
    }
    const sessionWorktree = await workspaceManager.getWorktreeIdentityForPath(workspaceId, session.location.directory)
    if (!sessionWorktree) {
      reply.code(403).send({ error: "Session does not belong to workspace" })
      return
    }
    mutationIdentities.add(sessionWorktree)
  }

  const body = applyDefaultWorkspaceLocation(targetUrl, promptBody, request.method, serviceDirectory, requestLocations.directories.length > 0 || sessionListHasScope, Boolean(sessionId) && !isGlobalFormAction(pathname, request.method))
  const instanceAuthHeader = workspaceManager.getInstanceAuthorizationHeader(workspaceId)
  const releaseMutation = request.method === "GET" || request.method === "HEAD"
    ? undefined
    : worktreeDeletionFence.enter([...mutationIdentities])
  if (request.method !== "GET" && request.method !== "HEAD" && !releaseMutation) {
    reply.code(409).send({ error: "Worktree deletion is in progress" })
    return
  }
  logger.debug({ workspaceId, method: request.method, targetUrl: targetUrl.toString() }, "Proxying request to instance")

  try {
    return reply.from(targetUrl.toString(), {
      ...(body !== request.body ? { body } : {}),
      rewriteRequestHeaders: (_originalRequest, headers) => {
        const outgoingHeaders = sanitizeInstanceProxyRequestHeaders(headers, instanceAuthHeader)
        if (globalFormLocation) {
          outgoingHeaders["x-opencode-directory"] = encodeURIComponent(translatedDirectories.get(globalFormLocation.directory)!)
          if (globalFormLocation.workspaceID) outgoingHeaders["x-opencode-workspace"] = globalFormLocation.workspaceID
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
        const upstream = upstreamResponse as typeof upstreamResponse & { readableEnded?: boolean; destroyed?: boolean }
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
    throw error
  }
}

function appendIncomingQuery(targetUrl: URL, incomingUrl: string): URL {
  const queryIndex = incomingUrl.indexOf("?")
  const incomingSearch = queryIndex >= 0 ? incomingUrl.slice(queryIndex + 1) : ""
  for (const [key, value] of new URLSearchParams(incomingSearch)) targetUrl.searchParams.append(key, value)
  return targetUrl
}

function readRequestDirectories(
  targetUrl: URL,
  body: unknown,
  defaultDirectory: string,
): { directories: string[]; locations: LocationRef[]; invalid: boolean } {
  const directories: string[] = []
  const locations: LocationRef[] = []
  let invalid = false
  for (const key of ["location[directory]", "directory"]) {
    for (const value of targetUrl.searchParams.getAll(key)) {
      if (value.trim()) directories.push(value)
      else invalid = true
    }
  }
  const queryWorkspaces = targetUrl.searchParams.getAll("location[workspace]")
  const queryDirectories = targetUrl.searchParams.getAll("location[directory]")
  if (queryWorkspaces.length > 1 || queryDirectories.length > 1) invalid = true
  if (queryWorkspaces.length === 1) {
    const workspaceID = queryWorkspaces[0]
    if (!workspaceID.trim()) invalid = true
    else locations.push({ directory: queryDirectories[0] ?? defaultDirectory, workspaceID })
  }
  if (targetUrl.pathname.replace(/\/+$/, "") !== "/api/session" && targetUrl.searchParams.has("workspace")) invalid = true
  if (targetUrl.searchParams.has("workspaceID") || targetUrl.searchParams.has("location[workspaceID]")) invalid = true

  if (body && typeof body === "object" && !Array.isArray(body) && !Buffer.isBuffer(body)) {
    const input = body as Record<string, unknown>
    if ("directory" in input) {
      if (typeof input.directory === "string" && input.directory.trim()) directories.push(input.directory)
      else invalid = true
    }
    if ("location" in input) {
      const location = input.location
      if (location && typeof location === "object" && !Array.isArray(location)) {
        const source = location as Record<string, unknown>
        const directory = source.directory
        if (typeof directory === "string" && directory.trim()) directories.push(directory)
        else invalid = true
        if (source.workspace !== undefined) invalid = true
        if (source.workspaceID !== undefined) {
          if (typeof source.workspaceID === "string" && source.workspaceID.trim() && typeof directory === "string" && directory.trim()) {
            locations.push({ directory, workspaceID: source.workspaceID })
          } else invalid = true
        }
      } else if (location !== null && location !== undefined) {
        invalid = true
      }
    }
    if (/^\/api\/session\/[^/]+\/move\/?$/.test(targetUrl.pathname) && "workspaceID" in input) {
      if (typeof input.workspaceID === "string" && input.workspaceID.trim() && typeof input.directory === "string" && input.directory.trim()) {
        locations.push({ directory: input.directory, workspaceID: input.workspaceID })
      } else invalid = true
    } else if ("workspaceID" in input) {
      invalid = true
    }
  }
  return { directories, locations, invalid }
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

function sanitizeInstanceProxyRequestHeaders(
  headers: Record<string, string | string[] | undefined>,
  authorization: string | undefined,
) {
  const blocked = new Set([
    "authorization", "connection", "cookie", "forwarded", "host", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "proxy-connection", "set-cookie", "te", "trailer", "transfer-encoding", "upgrade",
    "x-forwarded-for", "x-forwarded-host", "x-forwarded-port", "x-forwarded-proto",
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
  const blocked = new Set(["proxy-authenticate", "set-cookie", "set-cookie2", "www-authenticate"])
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())))
}

export function redactSecrets(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (typeof value !== "object") return value
  if (Buffer.isBuffer(value)) return "<redacted>"
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return "<redacted>"
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    /(authorization|cookie|key|code|token|password|secret)/i.test(key) ? "<redacted>" : redactSecrets(entry),
  ]))
}

async function allDirectoriesOwned(manager: InstanceProxyWorkspaceManager, workspaceId: string, directories: string[]) {
  return (await Promise.all(directories.map((directory) => manager.ownsDirectory(workspaceId, directory)))).every(Boolean)
}

async function allLocationsOwned(manager: InstanceProxyWorkspaceManager, workspaceId: string, locations: LocationRef[]) {
  const unique = new Map(locations.map((location) => [`${location.directory}\0${location.workspaceID ?? ""}`, location]))
  return (await Promise.all([...unique.values()].map((location) => manager.ownsLocation(workspaceId, location)))).every(Boolean)
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
): unknown {
  if (hasLocation || sessionRoute) return body
  if (targetUrl.pathname === "/api/session" && method === "GET") {
    targetUrl.searchParams.set("directory", directory)
    return body
  }
  if (targetUrl.pathname === "/api/session" && method === "POST") {
    const input = body && typeof body === "object" && !Array.isArray(body) && !Buffer.isBuffer(body)
      ? body as Record<string, unknown>
      : {}
    return { ...input, location: { directory } }
  }
  targetUrl.searchParams.set("location[directory]", directory)
  return body
}

function getSessionRouteId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/(?:experimental\/)?session\/([^/]+)(?:\/|$)/)
  if (!match || match[1] === "active" || match[1] === "import") return null
  return match[1]
}

function isGlobalFormAction(pathname: string, method: string): boolean {
  return method === "POST" && /^\/api\/session\/global\/form\/[^/]+\/(?:reply|cancel)\/?$/.test(pathname)
}

async function authorizeSessionList(
  targetUrl: URL,
  method: string,
  manager: InstanceProxyWorkspaceManager,
  workspaceId: string,
): Promise<"allowed" | "invalid" | "foreign"> {
  if (method !== "GET" || targetUrl.pathname.replace(/\/+$/, "") !== "/api/session") return "allowed"
  const cursors = targetUrl.searchParams.getAll("cursor")
  if (cursors.length > 1) return "invalid"
  if (cursors.length === 1) {
    const scope = decodeSessionListCursor(cursors[0])
    if (!scope) return "invalid"
    for (const key of ["directory", "workspace", "location[directory]", "location[workspace]", "project", "subpath"]) {
      targetUrl.searchParams.delete(key)
    }
    return ownsSessionListScope(manager, workspaceId, scope)
  }

  const projects = targetUrl.searchParams.getAll("project")
  const subpaths = targetUrl.searchParams.getAll("subpath")
  const workspaces = targetUrl.searchParams.getAll("workspace")
  const directories = targetUrl.searchParams.getAll("directory")
  if (projects.length > 1 || subpaths.length > 1 || workspaces.length > 1 || directories.length > 1
    || (subpaths.length && !projects.length)) return "invalid"
  const workspace = workspaces[0]
  const directory = directories[0]
  if ((workspace !== undefined && !workspace.trim()) || (directory !== undefined && !directory.trim())) return "invalid"
  if (!projects.length) {
    if (workspace && directory) return ownsSessionListScope(manager, workspaceId, { workspace, directory })
    if (workspace) return ownsSessionListScope(manager, workspaceId, { workspace })
    return "allowed"
  }
  const project = projects[0]
  const subpath = subpaths[0]
  if (!project || (subpath !== undefined && !isSafeRelativePath(subpath))) return "invalid"
  return ownsSessionListScope(manager, workspaceId, { ...(workspace ? { workspace } : {}), project, subpath })
}

type SessionListScope = {
  workspace?: string
  directory?: string
  project?: string
  subpath?: string
}

function decodeSessionListCursor(cursor: string): SessionListScope | null {
  if (!cursor || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const anchor = value.anchor as Record<string, unknown> | undefined
    if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)
      || typeof anchor.id !== "string" || !anchor.id
      || typeof anchor.time !== "number" || !Number.isFinite(anchor.time)
      || (anchor.direction !== "previous" && anchor.direction !== "next")) return null
    if (value.workspace !== undefined && (typeof value.workspace !== "string" || !value.workspace.trim())) return null
    if (value.search !== undefined && typeof value.search !== "string") return null
    if (value.order !== undefined && value.order !== "asc" && value.order !== "desc") return null
    if (typeof value.directory === "string" && value.directory.trim() && value.project === undefined && value.subpath === undefined) {
      return { ...(typeof value.workspace === "string" ? { workspace: value.workspace } : {}), directory: value.directory }
    }
    if (typeof value.project === "string" && value.project.trim() && value.directory === undefined) {
      if (value.subpath === undefined) {
        return { ...(typeof value.workspace === "string" ? { workspace: value.workspace } : {}), project: value.project }
      }
      if (typeof value.subpath === "string" && isSafeRelativePath(value.subpath)) {
        return { ...(typeof value.workspace === "string" ? { workspace: value.workspace } : {}), project: value.project, subpath: value.subpath }
      }
    }
    if (typeof value.workspace === "string" && value.directory === undefined && value.project === undefined && value.subpath === undefined) {
      return { workspace: value.workspace }
    }
    return null
  } catch {
    return null
  }
}

function isSafeRelativePath(value: string): boolean {
  return value === "" || (!path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) && !value.split(/[\\/]/).includes(".."))
}

async function ownsSessionListScope(
  manager: InstanceProxyWorkspaceManager,
  workspaceId: string,
  scope: SessionListScope,
): Promise<"allowed" | "foreign"> {
  if (scope.directory) {
    const owned = scope.workspace
      ? await manager.ownsLocation(workspaceId, { directory: scope.directory, workspaceID: scope.workspace })
      : await manager.ownsDirectory(workspaceId, scope.directory)
    return owned ? "allowed" : "foreign"
  }
  if (!scope.project) return scope.workspace && await manager.ownsLocationWorkspace(workspaceId, scope.workspace) ? "allowed" : "foreign"
  const project = (await (await manager.getSharedServiceClient()).project.list()).find((candidate) => candidate.id === scope.project)
  if (!project) return "foreign"
  const directory = scope.subpath === undefined
    ? project.canonical
    : /^[A-Za-z]:[\\/]|^\\\\/.test(project.canonical)
      ? path.win32.resolve(project.canonical, scope.subpath)
      : path.posix.resolve(project.canonical, scope.subpath)
  const owned = scope.workspace
    ? await manager.ownsLocation(workspaceId, { directory, workspaceID: scope.workspace })
    : await manager.ownsDirectory(workspaceId, directory)
  return owned ? "allowed" : "foreign"
}

function getPtyRouteId(pathname: string): string | null {
  return pathname.replace(/\/+$/, "").match(/^\/api\/pty\/([^/]+)$/)?.[1] ?? null
}

function getShellRouteId(pathname: string): string | null {
  return pathname.replace(/\/+$/, "").match(/^\/api\/shell\/([^/]+)(?:\/output|\/timeout)?$/)?.[1] ?? null
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

function isAllowedInstanceApiRoute(method: string, pathname: string): boolean {
  const route = pathname.replace(/\/+$/, "")
  const allowed: Array<[string, RegExp]> = [
    ["GET", /^\/api\/(?:agent|command|config|integration|location|mcp|model|plugin|provider|reference|skill)$/],
    ["GET", /^\/api\/(?:mcp\/resource|websearch\/provider)$/],
    ["GET", /^\/api\/agent\/[^/]+$/],
    ["GET", /^\/api\/model\/default$/],
    ["GET", /^\/api\/(?:permission|question)\/request$/],
    ["GET", /^\/api\/form\/request$/],
    ["GET", /^\/api\/project\/current$/],
    ["GET", /^\/api\/project$/],
    ["GET", /^\/api\/vcs(?:\/status)?$/],
    ["GET", /^\/api\/fs\/(?:list|read\/.+)$/],
    ["GET", /^\/api\/(?:pty|shell)(?:\/[^/]+(?:\/output)?)?$/],
    ["POST", /^\/api\/(?:pty|shell)$/],
    ["PUT", /^\/api\/pty\/[^/]+$/],
    ["DELETE", /^\/api\/pty\/[^/]+$/],
    ["DELETE", /^\/api\/shell\/[^/]+$/],
    ["PATCH", /^\/api\/shell\/[^/]+\/timeout$/],
    ["POST", /^\/api\/mcp\/[^/]+\/(?:connect|disconnect)$/],
    ["DELETE", /^\/api\/credential\/[^/]+$/],
    ["POST", /^\/api\/integration\/[^/]+\/connect\/(?:key|oauth|command)$/],
    ["GET", /^\/api\/integration\/[^/]+\/connect\/(?:oauth|command)\/[^/]+$/],
    ["DELETE", /^\/api\/integration\/[^/]+\/connect\/(?:oauth|command)\/[^/]+$/],
    ["POST", /^\/api\/integration\/[^/]+\/connect\/oauth\/[^/]+\/complete$/],
    ["GET", /^\/api\/session(?:\/active)?$/],
    ["POST", /^\/api\/session(?:\/import)?$/],
    ["GET", /^\/api\/session\/[^/]+(?:\/message(?:\/[^/]+)?)?$/],
    ["PATCH", /^\/api\/session\/[^/]+\/message\/[^/]+$/],
    ["GET", /^\/api\/session\/[^/]+\/inbox$/],
    ["GET", /^\/api\/session\/[^/]+\/(?:permission|form)$/],
    ["DELETE", /^\/api\/session\/[^/]+$/],
    ["DELETE", /^\/api\/session\/[^/]+\/inbox\/[^/]+$/],
    ["POST", /^\/api\/session\/[^/]+\/(?:agent|model|rename|move|prompt|command|shell|compact|interrupt|background|fork)$/],
    ["POST", /^\/api\/session\/[^/]+\/inbox\/[^/]+\/(?:steer|queue)$/],
    ["POST", /^\/api\/session\/[^/]+\/revert\/(?:stage|clear)$/],
    ["PUT", /^\/api\/session\/[^/]+\/instructions\/entries\/[^/]+$/],
    ["DELETE", /^\/api\/session\/[^/]+\/instructions\/entries\/[^/]+$/],
    ["POST", /^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/],
    ["POST", /^\/api\/session\/[^/]+\/question\/[^/]+\/(?:reply|reject)$/],
    ["POST", /^\/api\/session\/[^/]+\/form\/[^/]+\/(?:reply|cancel)$/],
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
  if (pathname !== "/api/session/import" || method !== "POST") return input
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
  if (pathname !== "/api/session/import" || method !== "POST") return result
  if (!body || typeof body !== "object" || Array.isArray(body) || Buffer.isBuffer(body)) {
    result.invalid = true
    return result
  }

  const input = body as Record<string, unknown>
  const addLocation = (owner: Record<string, unknown>, key: string) => {
    const value = owner[key]
    if (value === null || value === undefined) {
      owner[key] = { directory }
      result.directories.push(directory)
      return
    }
    if (!value || typeof value !== "object" || Array.isArray(value) || Buffer.isBuffer(value)) {
      result.invalid = true
      return
    }
    const location = value as Record<string, unknown>
    if (location.directory === null || location.directory === undefined) location.directory = directory
    if (typeof location.directory !== "string" || !location.directory.trim()) {
      result.invalid = true
      return
    }
    result.directories.push(location.directory)
    if (location.workspace !== undefined) result.invalid = true
    if (location.workspaceID !== undefined) {
      if (typeof location.workspaceID === "string" && location.workspaceID.trim()) {
        result.locations.push({ directory: location.directory, workspaceID: location.workspaceID })
      } else result.invalid = true
    }
  }

  addLocation(input, "location")
  if (input.info && typeof input.info === "object" && !Array.isArray(input.info) && !Buffer.isBuffer(input.info)) {
    addLocation(input.info as Record<string, unknown>, "location")
  }

  if (Array.isArray(input.messages)) {
    for (const value of input.messages) {
      if (!value || typeof value !== "object" || Array.isArray(value) || Buffer.isBuffer(value)) continue
      const message = value as Record<string, unknown>
      if (message.type !== "location-switched") continue
      addLocation(message, "location")
      if (message.previous && typeof message.previous === "object" && !Array.isArray(message.previous) && !Buffer.isBuffer(message.previous)) {
        addLocation(message.previous as Record<string, unknown>, "location")
      }
    }
  }
  return result
}

function normalizeInstanceSuffix(pathSuffix: string | undefined) {
  if (!pathSuffix || pathSuffix === "/") {
    return "/"
  }
  const trimmed = pathSuffix.replace(/^\/+/, "")
  return trimmed.length === 0 ? "/" : `/${trimmed}`
}

function setupStaticUi(
  app: FastifyInstance,
  uiDir: string,
  authManager: AuthManager,
  previewManager: PreviewManager,
  logger: Logger,
) {
  if (!uiDir) {
    app.log.warn("UI static directory not provided; API endpoints only")
    return
  }

  if (!fs.existsSync(uiDir)) {
    app.log.warn({ uiDir }, "UI static directory missing; API endpoints only")
    return
  }

  app.addHook("preHandler", (request, reply, done) => {
    const session = authManager.getSessionFromRequest(request)
    if (session && proxyPreviewFallbackFromReferer(request, reply, previewManager, logger)) {
      return
    }
    done()
  })

  app.register(fastifyStatic, {
    root: uiDir,
    prefix: "/",
    decorateReply: false,
  })

  const indexPath = path.join(uiDir, "index.html")

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const url = request.raw.url ?? ""
    if (isApiRequest(url)) {
      reply.code(404).send({ message: "Not Found" })
      return
    }

    const session = authManager.getSessionFromRequest(request)
    if (session && proxyPreviewFallbackFromReferer(request, reply, previewManager, logger)) {
      return
    }

    if (!session && wantsHtml(request)) {
      reply.redirect("/login")
      return
    }

    if (fs.existsSync(indexPath)) {
      reply.type("text/html").send(fs.readFileSync(indexPath, "utf-8"))
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
) {
  app.log.info({ upstreamBase }, "Proxying UI requests to development server")
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const url = request.raw.url ?? ""
    if (isApiRequest(url)) {
      reply.code(404).send({ message: "Not Found" })
      return
    }

    const session = authManager.getSessionFromRequest(request)
    if (session && proxyPreviewFallbackFromReferer(request, reply, previewManager, logger)) {
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
): boolean {
  const rawUrl = request.raw.url ?? request.url ?? ""
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
  if (!parsed) {
    return false
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

function isHtmlContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase()
  return normalized.includes("text/html") || normalized.includes("application/xhtml+xml")
}

function isCssContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes("text/css")
}

function isJavaScriptContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase()
  return normalized.includes("javascript") || normalized.includes("ecmascript")
}

export function rewritePreviewBodyUrls(body: string, publicBase: string, kind: "html" | "css" | "js", targetOrigin = "http://localhost"): string {
  if (kind === "css") {
    return rewriteCssPreviewUrls(body, publicBase)
  }
  if (kind === "js") {
    return rewritePreviewJavaScriptImports(body, publicBase)
  }

  const rewritten = rewriteCssPreviewUrls(
    body
      .replace(/\b(src|href|action|poster|data)=(["'])\/(?!\/)([^"']*)\2/gi, (_match, attr: string, quote: string, pathValue: string) => {
        return `${attr}=${quote}${publicBase}/${pathValue}${quote}`
      })
      .replace(/\bsrcset=(["'])([^"']*)\1/gi, (_match, quote: string, value: string) => {
        return `srcset=${quote}${rewriteSrcsetPreviewUrls(value, publicBase)}${quote}`
      }),
    publicBase,
  )
  const withInlineModules = rewritten.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (script, attributes: string, source: string) => {
    if (/\btype\s*=\s*(["'])module\1/i.test(attributes)) {
      return script.replace(source, rewritePreviewJavaScriptImports(source, publicBase))
    }
    if (/\btype\s*=\s*(["'])importmap\1/i.test(attributes)) {
      return script.replace(source, rewritePreviewImportMap(source, publicBase))
    }
    return script
  })
  const bridge = buildPreviewRuntimeBridge(publicBase, targetOrigin)
  return /<head(?:\s[^>]*)?>/i.test(withInlineModules)
    ? withInlineModules.replace(/<head(\s[^>]*)?>/i, `<head$1>${bridge}`)
    : `${bridge}${withInlineModules}`
}

function rewriteCssPreviewUrls(body: string, publicBase: string): string {
  return body.replace(/url\((\s*)(["']?)\/(?!\/)([^"')]+)\2(\s*)\)/gi, (_match, before: string, quote: string, pathValue: string, after: string) => {
    return `url(${before}${quote}${publicBase}/${pathValue}${quote}${after})`
  })
}

function rewriteSrcsetPreviewUrls(value: string, publicBase: string): string {
  return value
    .split(",")
    .map((entry) => {
      const trimmed = entry.trimStart()
      if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return entry
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
  args.logger.debug({ sidecarId: sidecar.id, targetUrl, pathname, prefixMode: sidecar.prefixMode }, "Proxying request to SideCar")

  await proxyTargetRequest({
    reply: args.reply,
    logger: args.logger,
    targetUrl,
    targetOrigin,
    logContext: { sidecarId: sidecar.id },
    errorMessage: "SideCar proxy failed",
    rewriteHeaders: (headers) => rewriteSideCarResponseHeaders(headers, sidecarId, targetOrigin, sidecar.prefixMode),
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
  let responseKind: "html" | "css" | "js" | null = null
  await args.reply.from(args.targetUrl, {
    rewriteRequestHeaders: (_originalRequest, headers) => {
      const next = sanitizeSideCarProxyRequestHeaders(headers as Record<string, string | string[] | undefined>, args.targetOrigin)
      delete next["accept-encoding"]
      return next
    },
    rewriteHeaders: (headers) => {
      const next = args.rewriteHeaders(headers as Record<string, string | string[] | undefined>)
      const contentType = getHeaderValue(next, "content-type") ?? ""
      responseKind = isHtmlContentType(contentType) ? "html" : isCssContentType(contentType) ? "css" : isJavaScriptContentType(contentType) ? "js" : null
      if (responseKind) {
        delete next["content-length"]
        delete next["content-encoding"]
      }
      if (args.request.headers.origin === "null") {
        next["access-control-allow-origin"] = "null"
        delete next["access-control-allow-credentials"]
      }
      return next
    },
    onResponse: (_proxyRequest, proxyReply, upstreamResponse) => {
      const upstream = upstreamResponse as unknown as Readable
      if (!responseKind || args.request.method === "HEAD") {
        proxyReply.send(upstream)
        return
      }
      void (async () => {
        try {
          const chunks: Buffer[] = []
          for await (const chunk of upstream) chunks.push(Buffer.from(chunk))
          proxyReply.send(rewritePreviewBodyUrls(Buffer.concat(chunks).toString(), args.publicBase, responseKind!, args.targetOrigin))
        } catch (error) {
          args.logger.error({ ...args.logContext, err: error, targetUrl: args.targetUrl }, args.errorMessage)
          if (!proxyReply.sent) proxyReply.code(502).send({ error: args.errorMessage })
        }
      })()
    },
    onError: (proxyReply, { error }) => {
      args.logger.error({ ...args.logContext, err: error, targetUrl: args.targetUrl }, args.errorMessage)
      if (!proxyReply.sent) proxyReply.code(502).send({ error: args.errorMessage })
    },
  })
}

async function proxyTargetRequest(args: {
  reply: FastifyReply
  logger: Logger
  targetUrl: string
  targetOrigin: string
  logContext: Record<string, unknown>
  errorMessage: string
  rewriteHeaders: (headers: Record<string, string | string[] | undefined>) => Record<string, string | string[] | undefined>
}) {
  await args.reply.from(args.targetUrl, {
    rewriteRequestHeaders: (_originalRequest, headers) =>
      sanitizeSideCarProxyRequestHeaders(headers as Record<string, string | string[] | undefined>, args.targetOrigin),
    rewriteHeaders: args.rewriteHeaders,
    onError: (reply, { error }) => {
      args.logger.error({ ...args.logContext, err: error, targetUrl: args.targetUrl }, args.errorMessage)
      if (!reply.sent) {
        reply.code(502).send({ error: args.errorMessage })
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

function parsePreviewUpgradePath(rawUrl: string): { token: string; pathname: string; search: string } | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl, "http://localhost")
  } catch {
    return null
  }

  const match = parsed.pathname.match(/^\/previews\/([^/]+)(?:\/.*)?$/)
  if (!match) {
    return null
  }

  try {
    return {
      token: decodeURIComponent(match[1] ?? ""),
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
    request,
    socket,
    head,
    targetUrl,
    logger,
    logContext: { sidecarId },
    proxyLabel: "SideCar",
  })
}

async function proxyPreviewWebSocketUpgrade(args: {
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
  request: import("http").IncomingMessage
  socket: Socket
  head: Buffer
  targetUrl: URL
  logger: Logger
  logContext: Record<string, unknown>
  proxyLabel: string
  stripCookies?: boolean
}) {
  const { request, socket, head, targetUrl, logger, logContext, proxyLabel, stripCookies } = args
  const { socket: upstream, readyEvent } = createSideCarUpstreamSocket(targetUrl)

  const closeBoth = () => {
    if (!socket.destroyed) {
      socket.destroy()
    }
    if (!upstream.destroyed) {
      upstream.destroy()
    }
  }

  upstream.once("error", (error) => {
    logger.error({ ...logContext, err: error, targetUrl: targetUrl.toString() }, `Failed to proxy ${proxyLabel} websocket`)
    rejectUpgrade(socket, 502, "Bad Gateway")
    if (!upstream.destroyed) {
      upstream.destroy()
    }
  })

  socket.once("error", (error) => {
    logger.debug({ ...logContext, err: error }, `${proxyLabel} websocket client socket errored`)
    if (!upstream.destroyed) {
      upstream.destroy()
    }
  })

  upstream.once(readyEvent, () => {
    try {
      upstream.write(buildSideCarWebSocketRequest(request, targetUrl, { stripCookies }))
      if (head.length > 0) {
        upstream.write(head)
      }
      upstream.pipe(socket)
      socket.pipe(upstream)
    } catch (error) {
      logger.error({ ...logContext, err: error, targetUrl: targetUrl.toString() }, `Failed to forward ${proxyLabel} websocket upgrade`)
      closeBoth()
    }
  })

  upstream.once("close", () => {
    if (!socket.destroyed) {
      socket.end()
    }
  })

  socket.once("close", () => {
    if (!upstream.destroyed) {
      upstream.end()
    }
  })
}

function createSideCarUpstreamSocket(targetUrl: URL): { socket: Socket | TLSSocket; readyEvent: "connect" | "secureConnect" } {
  const port = Number(targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80))
  if (targetUrl.protocol === "https:") {
    return {
      socket: connectTls({
        host: targetUrl.hostname,
        port,
        servername: targetUrl.hostname,
      }),
      readyEvent: "secureConnect",
    }
  }
  return {
    socket: connectTcp(port, targetUrl.hostname),
    readyEvent: "connect",
  }
}

function buildSideCarWebSocketRequest(
  request: import("http").IncomingMessage,
  targetUrl: URL,
  options?: { stripCookies?: boolean },
): string {
  const pathWithQuery = `${targetUrl.pathname}${targetUrl.search}`
  const requestLine = `${request.method ?? "GET"} ${pathWithQuery} HTTP/${request.httpVersion}\r\n`
  const headerLines: string[] = []
  const rawHeaders = request.rawHeaders ?? []
  const blockedHeaders = getBlockedSideCarRequestHeaders()

  for (let index = 0; index < rawHeaders.length; index += 2) {
    const key = rawHeaders[index]
    const value = rawHeaders[index + 1]
    if (!key || value === undefined) continue
    const lower = key.toLowerCase()
    if (blockedHeaders.has(lower)) continue
    if (options?.stripCookies && lower === "cookie") continue
    if (lower === "origin") {
      headerLines.push(`Origin: ${targetUrl.origin}\r\n`)
      continue
    }
    headerLines.push(`${key}: ${value}\r\n`)
  }

  const hostValue = targetUrl.port ? `${targetUrl.hostname}:${targetUrl.port}` : targetUrl.hostname
  headerLines.push(`Host: ${hostValue}\r\n`)
  headerLines.push("\r\n")

  return requestLine + headerLines.join("")
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
): Record<string, string | string[] | undefined> {
  const blockedHeaders = getBlockedSideCarRequestHeaders()
  const next: Record<string, string | string[] | undefined> = {}

  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue
    if (blockedHeaders.has(key.toLowerCase())) continue
    next[key] = value
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
