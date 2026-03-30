import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify"
import cors from "@fastify/cors"
import fastifyStatic from "@fastify/static"
import replyFrom from "@fastify/reply-from"
import fs from "fs"
import { connect as connectTcp, type Socket } from "net"
import path from "path"
import { connect as connectTls, type TLSSocket } from "tls"
import { fetch } from "undici"
import type { Logger } from "../logger"
import { WorkspaceManager } from "../workspaces/manager"
import { isValidWorktreeSlug, listWorktrees, resolveRepoRoot } from "../workspaces/git-worktrees"

import type { SettingsService } from "../settings/service"
import { FileSystemBrowser } from "../filesystem/browser"
import { EventBus } from "../events/bus"
import { registerWorkspaceRoutes } from "./routes/workspaces"
import { registerSettingsRoutes } from "./routes/settings"
import { registerFilesystemRoutes } from "./routes/filesystem"
import { registerMetaRoutes } from "./routes/meta"
import { registerEventRoutes } from "./routes/events"
import { registerStorageRoutes } from "./routes/storage"
import { registerPluginRoutes } from "./routes/plugin"
import { registerBackgroundProcessRoutes } from "./routes/background-processes"
import { registerWorktreeRoutes } from "./routes/worktrees"
import { registerSpeechRoutes } from "./routes/speech"
import { registerRemoteServerRoutes } from "./routes/remote-servers"
import { registerSideCarRoutes } from "./routes/sidecars"
import { ServerMeta } from "../api-types"
import { InstanceStore } from "../storage/instance-store"
import { BackgroundProcessManager } from "../background-processes/manager"
import type { AuthManager } from "../auth/manager"
import { registerAuthRoutes } from "./routes/auth"
import { sendUnauthorized, wantsHtml } from "../auth/http-auth"
import type { SpeechService } from "../speech/service"
import { ClientConnectionManager } from "../clients/connection-manager"
import { PluginChannelManager } from "../plugins/channel"
import { VoiceModeManager } from "../plugins/voice-mode"
import type { SideCarManager } from "../sidecars/manager"

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
  authManager: AuthManager
  uiStaticDir: string
  uiDevServerUrl?: string
  logger: Logger
}

interface HttpServerStartResult {
  port: number
  url: string
  displayHost: string
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
      apiLogger.trace({ ...base, params: request.params, query: request.query, body: request.body }, "HTTP request payload")
    }
    done()
  })

  const allowedDevOrigins = new Set(["http://localhost:3000", "http://127.0.0.1:3000"])
  const isLoopbackHost = (host: string) => host === "127.0.0.1" || host === "::1" || host.startsWith("127.")

  const getSelfOrigins = (): Set<string> => {
    const origins = new Set<string>()
    const candidates: Array<string | undefined> = [deps.serverMeta.localUrl, deps.serverMeta.remoteUrl]
    for (const candidate of candidates) {
      if (!candidate) continue
      try {
        origins.add(new URL(candidate).origin)
      } catch {
        // ignore
      }
    }
    for (const addr of deps.serverMeta.addresses ?? []) {
      try {
        origins.add(new URL(addr.remoteUrl).origin)
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

       if (allowedDevOrigins.has(origin)) {
         cb(null, true)
         return
       }

       // When we bind to a non-loopback host (e.g., 0.0.0.0 or LAN IP), allow cross-origin UI access.
       if (deps.bindHost === "0.0.0.0" || !isLoopbackHost(deps.bindHost)) {
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

  const backgroundProcessManager = new BackgroundProcessManager({
    workspaceManager: deps.workspaceManager,
    eventBus: deps.eventBus,
    logger: deps.logger.child({ component: "background-processes" }),
  })
  const clientConnectionManager = new ClientConnectionManager(deps.logger.child({ component: "client-connections" }))
  const pluginChannel = new PluginChannelManager(deps.logger.child({ component: "plugin-channel" }))
  const voiceModeManager = new VoiceModeManager({
    connections: clientConnectionManager,
    channel: pluginChannel,
    logger: deps.logger.child({ component: "voice-mode" }),
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

    if (publicApiPaths.has(pathname) || publicPagePaths.has(pathname)) {
      done()
      return
    }

    const session = deps.authManager.getSessionFromRequest(request)

    const requiresAuthForApi = pathname.startsWith("/api/") || pathname.startsWith("/workspaces/") || pathname.startsWith("/sidecars/")
    if (requiresAuthForApi && !session) {
      // Allow OpenCode plugin -> CodeNomad calls with per-instance basic auth.
      const pluginMatch = pathname.match(/^\/workspaces\/([^/]+)\/plugin(?:\/|$)/)
      if (pluginMatch) {
        const workspaceId = pluginMatch[1]
        const expected = deps.workspaceManager.getInstanceAuthorizationHeader(workspaceId)
        const provided = Array.isArray(request.headers.authorization)
          ? request.headers.authorization[0]
          : request.headers.authorization

        if (expected && provided && provided === expected) {
          done()
          return
        }
      }

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

  registerWorkspaceRoutes(app, { workspaceManager: deps.workspaceManager })
  registerSettingsRoutes(app, { settings: deps.settings, logger: apiLogger })
  registerFilesystemRoutes(app, { fileSystemBrowser: deps.fileSystemBrowser })
  registerMetaRoutes(app, { serverMeta: deps.serverMeta })
  registerEventRoutes(app, {
    eventBus: deps.eventBus,
    registerClient: registerSseClient,
    logger: sseLogger,
    connectionManager: clientConnectionManager,
  })
  registerWorktreeRoutes(app, { workspaceManager: deps.workspaceManager })
  registerStorageRoutes(app, {
    instanceStore: deps.instanceStore,
    eventBus: deps.eventBus,
    workspaceManager: deps.workspaceManager,
  })
  registerRemoteServerRoutes(app, { logger: apiLogger })
  registerSpeechRoutes(app, { speechService: deps.speechService })
  registerSideCarRoutes(app, { sidecarManager: deps.sidecarManager })
  registerSideCarProxyRoutes(app, { sidecarManager: deps.sidecarManager, logger: proxyLogger })
  setupSideCarWebSocketProxy(app, {
    sidecarManager: deps.sidecarManager,
    authManager: deps.authManager,
    logger: proxyLogger,
  })
  registerPluginRoutes(app, {
    workspaceManager: deps.workspaceManager,
    eventBus: deps.eventBus,
    logger: proxyLogger,
    channel: pluginChannel,
    voiceModeManager,
  })
  registerBackgroundProcessRoutes(app, { backgroundProcessManager })
  registerInstanceProxyRoutes(app, { workspaceManager: deps.workspaceManager, logger: proxyLogger })


  if (deps.uiDevServerUrl) {
    setupDevProxy(app, deps.uiDevServerUrl, deps.authManager)
  } else {
    setupStaticUi(app, deps.uiStaticDir, deps.authManager)
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

      const shouldRetryWithEphemeral = (error: unknown) => {
        if (!autoPortRequested) return false
        const err = error as NodeJS.ErrnoException | undefined
        return Boolean(err && err.code === "EADDRINUSE")
      }

      let listenResult

      try {
        listenResult = await attemptListen(primaryPort)
      } catch (error) {
        if (!shouldRetryWithEphemeral(error)) {
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
      clientConnectionManager.shutdown()
      return app.close()
    },
  }
}

interface InstanceProxyDeps {
  workspaceManager: WorkspaceManager
  logger: Logger
}

interface SideCarProxyDeps {
  sidecarManager: SideCarManager
  logger: Logger
}

interface SideCarWebSocketProxyDeps extends SideCarProxyDeps {
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

function setupSideCarWebSocketProxy(app: FastifyInstance, deps: SideCarWebSocketProxyDeps) {
  app.server.on("upgrade", (request, socket, head) => {
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

function registerInstanceProxyRoutes(app: FastifyInstance, deps: InstanceProxyDeps) {
  app.register(async (instance) => {
    instance.removeAllContentTypeParsers()
    instance.addContentTypeParser("*", (req, body, done) => done(null, body))

    const proxyBaseHandler = async (
      request: FastifyRequest<{ Params: { id: string; slug: string } }>,
      reply: FastifyReply,
    ) => {
      await proxyWorkspaceRequest({
        request,
        reply,
        workspaceManager: deps.workspaceManager,
        worktreeSlug: request.params.slug,
        pathSuffix: "",
        logger: deps.logger,
      })
    }

    const proxyWildcardHandler = async (
      request: FastifyRequest<{ Params: { id: string; slug: string; "*": string } }>,
      reply: FastifyReply,
    ) => {
      await proxyWorkspaceRequest({
        request,
        reply,
        workspaceManager: deps.workspaceManager,
        worktreeSlug: request.params.slug,
        pathSuffix: request.params["*"] ?? "",
        logger: deps.logger,
      })
    }

    instance.all("/workspaces/:id/worktrees/:slug/instance", proxyBaseHandler)
    instance.all("/workspaces/:id/worktrees/:slug/instance/*", proxyWildcardHandler)
  })
}

const INSTANCE_PROXY_HOST = "127.0.0.1"

// Special-case OpenCode directory override.
//
// UI clients may need to scope certain requests to an arbitrary directory that is not
// part of the Git worktree list. Since the OpenCode SDK does not reliably support
// injecting per-request headers, we encode an override into the *path* and strip it
// before proxying to the instance.
//
// Example proxied request path:
//   /workspaces/:id/worktrees/:slug/instance/__dir/<base64url>/session/create
//
// The server will decode <base64url> -> absolute directory, validate it, then set
// x-opencode-directory accordingly and forward the request to /session/create.
const OPENCODE_DIR_OVERRIDE_PREFIX = "__dir/"
const OPENCODE_DIR_OVERRIDE_MAX_LEN = 4096

async function proxyWorkspaceRequest(args: {
  request: FastifyRequest
  reply: FastifyReply
  workspaceManager: WorkspaceManager
  logger: Logger
  worktreeSlug: string
  pathSuffix?: string
}) {
  const { request, reply, workspaceManager, logger, worktreeSlug } = args
  const workspaceId = (request.params as { id: string }).id
  const workspace = workspaceManager.get(workspaceId)

  const bodyToJson = (body: unknown): unknown => {
    if (body == null) return null

    const anyBody = body as any
    if (anyBody && typeof anyBody.pipe === "function") {
      // Don't consume streams (would break proxying).
      // Best-effort: if the stream already has buffered chunks, parse those.
      try {
        const buffered = anyBody?._readableState?.buffer
        if (Array.isArray(buffered) && buffered.length > 0) {
          const chunks: Buffer[] = []
          for (const entry of buffered) {
            if (!entry) continue
            if (Buffer.isBuffer(entry)) {
              chunks.push(entry)
              continue
            }
            const data = (entry as any).data
            if (Buffer.isBuffer(data)) {
              chunks.push(data)
            }
          }

          if (chunks.length > 0) {
            const text = Buffer.concat(chunks).toString("utf-8")
            try {
              return JSON.parse(text)
            } catch {
              return { __raw: text }
            }
          }
        }
      } catch {
        // fall through
      }

      return { __stream: true }
    }

    const maybeParse = (input: string): unknown => {
      try {
        return JSON.parse(input)
      } catch {
        return { __raw: input }
      }
    }

    if (Buffer.isBuffer(body)) {
      return maybeParse(body.toString("utf-8"))
    }

    if (typeof body === "string") {
      return maybeParse(body)
    }

    if (typeof body === "object") {
      return body
    }

    return body
  }

  if (!workspace) {
    reply.code(404).send({ error: "Workspace not found" })
    return
  }

  const port = workspaceManager.getInstancePort(workspaceId)
  if (!port) {
    reply.code(502).send({ error: "Workspace instance is not ready" })
    return
  }

  if (!isValidWorktreeSlug(worktreeSlug)) {
    reply.code(400).send({ error: "Invalid worktree slug" })
    return
  }

  let extracted: { overrideDirectory: string | null; forwardedSuffix: string | undefined }
  try {
    extracted = extractOpencodeDirectoryOverride(args.pathSuffix)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid directory override"
    reply.code(400).send({ error: message })
    return
  }
  let directory: string | null = null
  let forwardedSuffix = extracted.forwardedSuffix

  if (extracted.overrideDirectory) {
    try {
      directory = validateAndNormalizeOverrideDirectory({
        overrideDirectory: extracted.overrideDirectory,
        workspaceRoot: workspace.path,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid directory override"
      reply.code(400).send({ error: message })
      return
    }
  } else {
    directory = await resolveWorktreeDirectory({
      workspaceId,
      workspacePath: workspace.path,
      worktreeSlug,
      logger,
    })

    if (!directory) {
      reply.code(404).send({ error: "Worktree not found" })
      return
    }
  }

  const normalizedSuffix = normalizeInstanceSuffix(forwardedSuffix)
  const queryIndex = (request.raw.url ?? "").indexOf("?")
  const search = queryIndex >= 0 ? (request.raw.url ?? "").slice(queryIndex) : ""
  const targetUrl = `http://${INSTANCE_PROXY_HOST}:${port}${normalizedSuffix}${search}`
  const instanceAuthHeader = workspaceManager.getInstanceAuthorizationHeader(workspaceId)

  logger.debug({ workspaceId, method: request.method, targetUrl }, "Proxying request to instance")
  if (logger.isLevelEnabled("trace")) {
    logger.trace({ workspaceId, targetUrl, body: request.body }, "Instance proxy payload")
  }

  return reply.from(targetUrl, {
    rewriteRequestHeaders: (_originalRequest, headers) => {
      if (instanceAuthHeader) {
        headers.authorization = instanceAuthHeader
      }

      // OpenCode expects the *full* path; we send it via header to avoid query tampering.
      const isNonASCII = /[^\x00-\x7F]/.test(directory)
      const encodedDirectory = isNonASCII ? encodeURIComponent(directory) : directory

      // Overwrite any client-provided value (case-insensitive headers are normalized by Node).
      ;(headers as Record<string, unknown>)["x-opencode-directory"] = encodedDirectory

      if (logger.isLevelEnabled("trace")) {
        const outgoing: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
          outgoing[key] = value
        }

        // Redact sensitive headers.
        for (const key of Object.keys(outgoing)) {
          const lower = key.toLowerCase()
          if (lower === "authorization" || lower === "cookie" || lower === "set-cookie") {
            outgoing[key] = "<redacted>"
          }
        }

        logger.trace(
          {
            workspaceId,
            method: request.method,
            targetUrl,
            worktreeSlug,
            directory,
            contentType: request.headers["content-type"],
            body: bodyToJson(request.body),
            headers: outgoing,
          },
          "Proxy -> OpenCode request",
        )
      }

      return headers
    },
    onError: (proxyReply, { error }) => {
      logger.error({ err: error, workspaceId, targetUrl }, "Failed to proxy workspace request")
      if (!proxyReply.sent) {
        proxyReply.code(502).send({ error: "Workspace instance proxy failed" })
      }
    },
  })
}

function extractOpencodeDirectoryOverride(pathSuffix: string | undefined): {
  overrideDirectory: string | null
  forwardedSuffix: string | undefined
} {
  if (!pathSuffix) {
    return { overrideDirectory: null, forwardedSuffix: pathSuffix }
  }

  // Fastify wildcard param does not include a leading slash.
  const trimmed = pathSuffix.replace(/^\/+/, "")
  if (!trimmed.startsWith(OPENCODE_DIR_OVERRIDE_PREFIX)) {
    return { overrideDirectory: null, forwardedSuffix: pathSuffix }
  }

  const rest = trimmed.slice(OPENCODE_DIR_OVERRIDE_PREFIX.length)
  const slashIndex = rest.indexOf("/")
  const encoded = (slashIndex >= 0 ? rest.slice(0, slashIndex) : rest).trim()
  const remaining = slashIndex >= 0 ? rest.slice(slashIndex + 1) : ""

  if (!encoded) {
    throw new Error("Missing directory override")
  }

  if (encoded.length > OPENCODE_DIR_OVERRIDE_MAX_LEN) {
    throw new Error("Directory override too large")
  }

  let overrideDirectory = ""
  try {
    overrideDirectory = decodeBase64Url(encoded)
  } catch {
    throw new Error("Invalid directory override")
  }
  const forwardedSuffix = remaining
  return { overrideDirectory, forwardedSuffix }
}

function decodeBase64Url(input: string): string {
  // base64url -> base64
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/")
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4))
  const base64 = `${normalized}${padding}`
  return Buffer.from(base64, "base64").toString("utf-8")
}

function validateAndNormalizeOverrideDirectory(params: { overrideDirectory: string; workspaceRoot: string }): string {
  const raw = params.overrideDirectory.trim()
  if (!raw) {
    throw new Error("Override directory is empty")
  }

  if (!path.isAbsolute(raw)) {
    throw new Error("Override directory must be an absolute path")
  }

  if (!fs.existsSync(raw)) {
    throw new Error(`Override directory does not exist: ${raw}`)
  }

  const stats = fs.statSync(raw)
  if (!stats.isDirectory()) {
    throw new Error(`Override path is not a directory: ${raw}`)
  }

  const normalizedOverride = fs.realpathSync(raw)
  const normalizedRoot = fs.realpathSync(params.workspaceRoot)

  if (!isSubpath(normalizedOverride, normalizedRoot)) {
    throw new Error("Override directory must be within the workspace root")
  }

  return normalizedOverride
}

function isSubpath(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate)
  if (rel === "") return true
  if (rel === "..") return false
  if (rel.startsWith(`..${path.sep}`)) return false
  if (path.isAbsolute(rel)) return false
  return true
}

function normalizeInstanceSuffix(pathSuffix: string | undefined) {
  if (!pathSuffix || pathSuffix === "/") {
    return "/"
  }
  const trimmed = pathSuffix.replace(/^\/+/, "")
  return trimmed.length === 0 ? "/" : `/${trimmed}`
}

type WorktreeCacheEntry = {
  expiresAt: number
  repoRoot: string
  worktrees: Array<{ slug: string; directory: string }>
}

const WORKTREE_CACHE_TTL_MS = 2000
const worktreeCache = new Map<string, WorktreeCacheEntry>()

async function getCachedWorktrees(params: { workspaceId: string; workspacePath: string; logger: Logger }) {
  const cached = worktreeCache.get(params.workspaceId)
  const now = Date.now()
  if (cached && cached.expiresAt > now) {
    return cached
  }

  const { repoRoot } = await resolveRepoRoot(params.workspacePath, params.logger)
  const worktrees = await listWorktrees({ repoRoot, workspaceFolder: params.workspacePath, logger: params.logger })
  const entry: WorktreeCacheEntry = {
    expiresAt: now + WORKTREE_CACHE_TTL_MS,
    repoRoot,
    worktrees: worktrees.map((wt) => ({ slug: wt.slug, directory: wt.directory })),
  }
  worktreeCache.set(params.workspaceId, entry)
  return entry
}

async function resolveWorktreeDirectory(params: {
  workspaceId: string
  workspacePath: string
  worktreeSlug: string
  logger: Logger
}): Promise<string | null> {
  const { worktreeSlug } = params
  const cached = await getCachedWorktrees({ workspaceId: params.workspaceId, workspacePath: params.workspacePath, logger: params.logger })
  const match = cached.worktrees.find((wt) => wt.slug === worktreeSlug)
  if (match) {
    return match.directory
  }

  // If the slug is new (e.g., created moments ago), refresh once.
  worktreeCache.delete(params.workspaceId)
  const refreshed = await getCachedWorktrees({ workspaceId: params.workspaceId, workspacePath: params.workspacePath, logger: params.logger })
  return refreshed.worktrees.find((wt) => wt.slug === worktreeSlug)?.directory ?? null
}

function setupStaticUi(app: FastifyInstance, uiDir: string, authManager: AuthManager) {
  if (!uiDir) {
    app.log.warn("UI static directory not provided; API endpoints only")
    return
  }

  if (!fs.existsSync(uiDir)) {
    app.log.warn({ uiDir }, "UI static directory missing; API endpoints only")
    return
  }

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

function setupDevProxy(app: FastifyInstance, upstreamBase: string, authManager: AuthManager) {
  app.log.info({ upstreamBase }, "Proxying UI requests to development server")
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const url = request.raw.url ?? ""
    if (isApiRequest(url)) {
      reply.code(404).send({ message: "Not Found" })
      return
    }

    const session = authManager.getSessionFromRequest(request)
    if (!session && wantsHtml(request)) {
      reply.redirect("/login")
      return
    }

    void proxyToDevServer(request, reply, upstreamBase)
  })
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

  await args.reply.from(targetUrl, {
    rewriteHeaders: (headers) => rewriteSideCarResponseHeaders(headers, sidecarId, targetOrigin, sidecar.prefixMode),
    onError: (reply, { error }) => {
      args.logger.error({ sidecarId: sidecar.id, err: error, targetUrl }, "Failed to proxy SideCar request")
      if (!reply.sent) {
        reply.code(502).send({ error: "SideCar proxy failed" })
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
    logger.error({ sidecarId, err: error, targetUrl: targetUrl.toString() }, "Failed to proxy SideCar websocket")
    rejectUpgrade(socket, 502, "Bad Gateway")
    if (!upstream.destroyed) {
      upstream.destroy()
    }
  })

  socket.once("error", (error) => {
    logger.debug({ sidecarId, err: error }, "SideCar websocket client socket errored")
    if (!upstream.destroyed) {
      upstream.destroy()
    }
  })

  upstream.once(readyEvent, () => {
    try {
      upstream.write(buildSideCarWebSocketRequest(request, targetUrl))
      if (head.length > 0) {
        upstream.write(head)
      }
      upstream.pipe(socket)
      socket.pipe(upstream)
    } catch (error) {
      logger.error({ sidecarId, err: error, targetUrl: targetUrl.toString() }, "Failed to forward SideCar websocket upgrade")
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

function buildSideCarWebSocketRequest(request: import("http").IncomingMessage, targetUrl: URL): string {
  const pathWithQuery = `${targetUrl.pathname}${targetUrl.search}`
  const requestLine = `${request.method ?? "GET"} ${pathWithQuery} HTTP/${request.httpVersion}\r\n`
  const headerLines: string[] = []
  const rawHeaders = request.rawHeaders ?? []

  for (let index = 0; index < rawHeaders.length; index += 2) {
    const key = rawHeaders[index]
    const value = rawHeaders[index + 1]
    if (!key || value === undefined) continue
    const lower = key.toLowerCase()
    if (lower === "host") continue
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
