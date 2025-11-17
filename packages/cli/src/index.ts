/**
 * CLI entry point.
 * For now this only wires the typed modules together; actual command handling comes later.
 */
import { createHttpServer } from "./server/http-server"
import { WorkspaceManager } from "./workspaces/manager"
import { ConfigStore } from "./config/store"
import { BinaryRegistry } from "./config/binaries"
import { FileSystemBrowser } from "./filesystem/browser"
import { EventBus } from "./events/bus"
import { ServerMeta } from "./api-types"
import { InstanceStore } from "./storage/instance-store"
import { createLogger } from "./logger"

interface CliOptions {
  port: number
  host: string
  rootDir: string
  configPath: string
  logLevel?: string
  logDestination?: string
}

function parseCliOptions(argv: string[]): CliOptions {
  // TODO: replace with commander/yargs; this is placeholder logic.
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key && key.startsWith("--") && value) {
      args.set(key.slice(2), value)
    }
  }

  return {
    port: Number(args.get("port") ?? process.env.CLI_PORT ?? 5777),
    host: args.get("host") ?? process.env.CLI_HOST ?? "127.0.0.1",
    rootDir: args.get("root") ?? process.cwd(),
    configPath: args.get("config") ?? process.env.CLI_CONFIG ?? "~/.config/codenomad/config.json",
    logLevel: args.get("log-level") ?? process.env.CLI_LOG_LEVEL,
    logDestination: args.get("log-destination") ?? process.env.CLI_LOG_DESTINATION,
  }
}

async function main() {
  const options = parseCliOptions(process.argv.slice(2))
  const logger = createLogger({ level: options.logLevel, destination: options.logDestination })

  logger.info({ options }, "Starting CodeNomad CLI server")

  const eventBus = new EventBus(logger)
  const configStore = new ConfigStore(options.configPath, eventBus, logger)
  const binaryRegistry = new BinaryRegistry(configStore, eventBus, logger)
  const workspaceManager = new WorkspaceManager({
    rootDir: options.rootDir,
    configStore,
    binaryRegistry,
    eventBus,
    logger,
  })
  const fileSystemBrowser = new FileSystemBrowser({ rootDir: options.rootDir })
  const instanceStore = new InstanceStore()

  const serverMeta: ServerMeta = {
    httpBaseUrl: `http://${options.host}:${options.port}`,
    eventsUrl: `/api/events`,
    hostLabel: options.host,
    workspaceRoot: options.rootDir,
  }

  const server = createHttpServer({
    host: options.host,
    port: options.port,
    workspaceManager,
    configStore,
    binaryRegistry,
    fileSystemBrowser,
    eventBus,
    serverMeta,
    instanceStore,
    logger,
  })

  await server.start()
  logger.info({ port: options.port, host: options.host }, "HTTP server listening")

  let shuttingDown = false

  const shutdown = async () => {
    if (shuttingDown) {
      logger.info("Shutdown already in progress, ignoring signal")
      return
    }
    shuttingDown = true
    logger.info("Received shutdown signal, closing server")
    try {
      await server.stop()
      logger.info("HTTP server stopped")
    } catch (error) {
      logger.error({ err: error }, "Failed to stop HTTP server")
    }

    try {
      await workspaceManager.shutdown()
      logger.info("Workspace manager shutdown complete")
    } catch (error) {
      logger.error({ err: error }, "Workspace manager shutdown failed")
    }

    logger.info("Exiting process")
    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((error) => {
  const logger = createLogger()
  logger.error({ err: error }, "CLI server crashed")
  process.exit(1)
})
