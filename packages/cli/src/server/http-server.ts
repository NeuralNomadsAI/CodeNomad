import Fastify from "fastify"
import cors from "@fastify/cors"
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
import { ServerMeta } from "../api-types"
import { InstanceStore } from "../storage/instance-store"
import { Logger } from "../logger"

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
  logger: Logger
}

export function createHttpServer(deps: HttpServerDeps) {
  const fastifyLogger = deps.logger.child({ module: "http" })
  const app = Fastify({ logger: fastifyLogger as any })

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

  app.register(cors, {
    origin: true,
    credentials: true,
  })

  registerWorkspaceRoutes(app, { workspaceManager: deps.workspaceManager })
  registerConfigRoutes(app, { configStore: deps.configStore, binaryRegistry: deps.binaryRegistry })
  registerFilesystemRoutes(app, { fileSystemBrowser: deps.fileSystemBrowser })
  registerMetaRoutes(app, { serverMeta: deps.serverMeta })
  registerEventRoutes(app, { eventBus: deps.eventBus, registerClient: registerSseClient })
  registerStorageRoutes(app, { instanceStore: deps.instanceStore })

  return {
    instance: app,
    start: () => app.listen({ port: deps.port, host: deps.host }),
    stop: () => {
      closeSseClients()
      return app.close()
    },
  }
}
