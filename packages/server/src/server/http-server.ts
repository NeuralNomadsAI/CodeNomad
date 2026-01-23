import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify"
import cors from "@fastify/cors"
import fastifyStatic from "@fastify/static"
import replyFrom from "@fastify/reply-from"
import fs from "fs"
import path from "path"
import { fetch } from "undici"
import type { Logger } from "../logger"
import { WorkspaceManager } from "../workspaces/manager"

import { ConfigStore } from "../config/store"
import { BinaryRegistry } from "../config/binaries"
import { FileSystemBrowser } from "../filesystem/browser"
import { EventBus } from "../events/bus"
import { registerWorkspaceRoutes } from "./routes/workspaces"
import { registerConfigRoutes } from "./routes/config"
import { registerFilesystemRoutes } from "./routes/filesystem"
import { registerMetaRoutes } from "./routes/meta"
import { registerEventRoutes } from "./routes/events"
import { registerStorageRoutes } from "./routes/storage"
import { registerModelsProxyRoutes } from "./routes/models-proxy"
import { registerEraRoutes } from "./routes/era"
import { ServerMeta } from "../api-types"
import { InstanceStore } from "../storage/instance-store"
import { EraDetectionService } from "../era/detection"
import { EraGovernanceService } from "../era/governance"

interface HttpServerDeps {
  host: string
  port: number
  workspaceManager: WorkspaceManager
  configStore: ConfigStore
  binaryRegistry: BinaryRegistry
  fileSystemBrowser: FileSystemBrowser
  eventBus: EventBus
  serverMeta: ServerMeta
  instanceStore: InstanceStore
  eraDetection?: EraDetectionService
  uiStaticDir: string
  uiDevServerUrl?: string
  logger: Logger
}

interface HttpServerStartResult {
  port: number
  url: string
  displayHost: string
}

const DEFAULT_HTTP_PORT = 9898

export function createHttpServer(deps: HttpServerDeps) {
  const app = Fastify({ logger: false })
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

  app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) {
        cb(null, true)
        return
      }

      let selfOrigin: string | null = null
      try {
        selfOrigin = new URL(deps.serverMeta.httpBaseUrl).origin
      } catch {
        selfOrigin = null
      }

      if (selfOrigin && origin === selfOrigin) {
        cb(null, true)
        return
      }

       if (allowedDevOrigins.has(origin)) {
         cb(null, true)
         return
       }

       // When we bind to a non-loopback host (e.g., 0.0.0.0 or LAN IP), allow cross-origin UI access.
       if (deps.host === "0.0.0.0" || !isLoopbackHost(deps.host)) {
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

  // Create era detection service (use provided or create default)
  const eraDetection = deps.eraDetection ?? new EraDetectionService(deps.logger)
  const eraGovernance = new EraGovernanceService(eraDetection, deps.logger)

  registerWorkspaceRoutes(app, { workspaceManager: deps.workspaceManager, eraDetection })
  registerConfigRoutes(app, { configStore: deps.configStore, binaryRegistry: deps.binaryRegistry })
  registerFilesystemRoutes(app, { fileSystemBrowser: deps.fileSystemBrowser })
  registerMetaRoutes(app, { serverMeta: deps.serverMeta })
  registerEventRoutes(app, { eventBus: deps.eventBus, registerClient: registerSseClient, logger: sseLogger })
  registerStorageRoutes(app, {
    instanceStore: deps.instanceStore,
    eventBus: deps.eventBus,
    workspaceManager: deps.workspaceManager,
  })
  registerModelsProxyRoutes(app)
  registerInstanceProxyRoutes(app, { workspaceManager: deps.workspaceManager, logger: proxyLogger })

  // Register Era routes
  registerEraRoutes(app, { eraDetection, eraGovernance, logger: deps.logger })


  if (deps.uiDevServerUrl) {
    setupDevProxy(app, deps.uiDevServerUrl)
  } else {
    setupStaticUi(app, deps.uiStaticDir)
  }

  return {
    instance: app,
    start: async (): Promise<HttpServerStartResult> => {
      const attemptListen = async (requestedPort: number) => {
        const addressInfo = await app.listen({ port: requestedPort, host: deps.host })
        return { addressInfo, requestedPort }
      }

      const autoPortRequested = deps.port === 0
      const primaryPort = autoPortRequested ? DEFAULT_HTTP_PORT : deps.port

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

      const displayHost = deps.host === "127.0.0.1" ? "localhost" : deps.host
      const serverUrl = `http://${displayHost}:${actualPort}`

      deps.serverMeta.httpBaseUrl = serverUrl
      deps.serverMeta.host = deps.host
      deps.serverMeta.port = actualPort
      deps.serverMeta.listeningMode = deps.host === "0.0.0.0" || !isLoopbackHost(deps.host) ? "all" : "local"
      deps.logger.info({ port: actualPort, host: deps.host }, "HTTP server listening")
      console.log(`Era Code Server is ready at ${serverUrl}`)

      return { port: actualPort, url: serverUrl, displayHost }
    },
    stop: () => {
      closeSseClients()
      return app.close()
    },
  }
}

interface InstanceProxyDeps {
  workspaceManager: WorkspaceManager
  logger: Logger
}

function registerInstanceProxyRoutes(app: FastifyInstance, deps: InstanceProxyDeps) {
  app.register(async (instance) => {
    instance.removeAllContentTypeParsers()
    instance.addContentTypeParser("*", (req, body, done) => done(null, body))

    const proxyBaseHandler = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      await proxyWorkspaceRequest({
        request,
        reply,
        workspaceManager: deps.workspaceManager,
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
        pathSuffix: request.params["*"] ?? "",
        logger: deps.logger,
      })
    }

    instance.all("/workspaces/:id/instance", proxyBaseHandler)
    instance.all("/workspaces/:id/instance/*", proxyWildcardHandler)
  })
}

const INSTANCE_PROXY_HOST = "127.0.0.1"

async function proxyWorkspaceRequest(args: {
  request: FastifyRequest
  reply: FastifyReply
  workspaceManager: WorkspaceManager
  logger: Logger
  pathSuffix?: string
}) {
  const { request, reply, workspaceManager, logger } = args
  const workspaceId = (request.params as { id: string }).id
  const workspace = workspaceManager.get(workspaceId)

  if (!workspace) {
    reply.code(404).send({ error: "Workspace not found" })
    return
  }

  const port = workspaceManager.getInstancePort(workspaceId)
  if (!port) {
    reply.code(502).send({ error: "Workspace instance is not ready" })
    return
  }

  const normalizedSuffix = normalizeInstanceSuffix(args.pathSuffix)
  const queryIndex = (request.raw.url ?? "").indexOf("?")
  const search = queryIndex >= 0 ? (request.raw.url ?? "").slice(queryIndex) : ""
  const targetUrl = `http://${INSTANCE_PROXY_HOST}:${port}${normalizedSuffix}${search}`

  logger.debug({ workspaceId, method: request.method, targetUrl }, "Proxying request to instance")
  if (logger.isLevelEnabled("trace")) {
    logger.trace({ workspaceId, targetUrl, body: request.body }, "Instance proxy payload")
  }

  return reply.from(targetUrl, {
    onError: (proxyReply, { error }) => {
      logger.error({ err: error, workspaceId, targetUrl }, "Failed to proxy workspace request")
      if (!proxyReply.sent) {
        proxyReply.code(502).send({ error: "Workspace instance proxy failed" })
      }
    },
  })
}

function normalizeInstanceSuffix(pathSuffix: string | undefined) {
  if (!pathSuffix || pathSuffix === "/") {
    return "/"
  }
  const trimmed = pathSuffix.replace(/^\/+/, "")
  return trimmed.length === 0 ? "/" : `/${trimmed}`
}

function setupStaticUi(app: FastifyInstance, uiDir: string) {
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

    if (fs.existsSync(indexPath)) {
      reply.type("text/html").send(fs.readFileSync(indexPath, "utf-8"))
    } else {
      reply.code(404).send({ message: "UI bundle missing" })
    }
  })
}

function setupDevProxy(app: FastifyInstance, upstreamBase: string) {
  app.log.info({ upstreamBase }, "Proxying UI requests to development server")
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const url = request.raw.url ?? ""
    if (isApiRequest(url)) {
      reply.code(404).send({ message: "Not Found" })
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
