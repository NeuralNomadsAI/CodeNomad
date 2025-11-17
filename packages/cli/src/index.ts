/**
 * CLI entry point.
 * For now this only wires the typed modules together; actual command handling comes later.
 */
import { Command, InvalidArgumentError, Option } from "commander"
import packageJson from "../package.json"
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
  unrestrictedRoot: boolean
  logLevel?: string
  logDestination?: string
}

const DEFAULT_PORT = 9898
const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_CONFIG_PATH = "~/.config/codenomad/config.json"

function parseCliOptions(argv: string[]): CliOptions {
  const program = new Command()
    .name("codenomad-cli")
    .description("CodeNomad CLI server")
    .version(packageJson.version, "-v, --version", "Show the CLI version")
    .addOption(new Option("--host <host>", "Host interface to bind").env("CLI_HOST").default(DEFAULT_HOST))
    .addOption(new Option("--port <number>", "Port for the HTTP server").env("CLI_PORT").default(DEFAULT_PORT).argParser(parsePort))
    .addOption(
      new Option("--workspace-root <path>", "Workspace root directory").env("CLI_WORKSPACE_ROOT").default(process.cwd()),
    )
    .addOption(new Option("--root <path>").env("CLI_ROOT").hideHelp(true))
    .addOption(new Option("--unrestricted-root", "Allow browsing the full filesystem").env("CLI_UNRESTRICTED_ROOT").default(false))
    .addOption(new Option("--config <path>", "Path to the config file").env("CLI_CONFIG").default(DEFAULT_CONFIG_PATH))
    .addOption(new Option("--log-level <level>", "Log level (trace|debug|info|warn|error)").env("CLI_LOG_LEVEL"))
    .addOption(new Option("--log-destination <path>", "Log destination file (defaults to stdout)").env("CLI_LOG_DESTINATION"))

  program.parse(argv, { from: "user" })
  const parsed = program.opts<{
    host: string
    port: number
    workspaceRoot?: string
    root?: string
    unrestrictedRoot?: boolean
    config: string
    logLevel?: string
    logDestination?: string
  }>()

  const resolvedRoot = parsed.workspaceRoot ?? parsed.root ?? process.cwd()

  return {
    port: parsed.port,
    host: parsed.host,
    rootDir: resolvedRoot,
    configPath: parsed.config,
    unrestrictedRoot: Boolean(parsed.unrestrictedRoot),
    logLevel: parsed.logLevel,
    logDestination: parsed.logDestination,
  }
}

function parsePort(input: string): number {
  const value = Number(input)
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new InvalidArgumentError("Port must be an integer between 1 and 65535")
  }
  return value
}

async function main() {
  const options = parseCliOptions(process.argv.slice(2))
  const logger = createLogger({ level: options.logLevel, destination: options.logDestination, component: "app" })
  const workspaceLogger = logger.child({ component: "workspace" })
  const configLogger = logger.child({ component: "config" })
  const eventLogger = logger.child({ component: "events" })

  logger.info({ options }, "Starting CodeNomad CLI server")

  const eventBus = new EventBus(eventLogger)
  const configStore = new ConfigStore(options.configPath, eventBus, configLogger)
  const binaryRegistry = new BinaryRegistry(configStore, eventBus, configLogger)
  const workspaceManager = new WorkspaceManager({
    rootDir: options.rootDir,
    configStore,
    binaryRegistry,
    eventBus,
    logger: workspaceLogger,
  })
  const fileSystemBrowser = new FileSystemBrowser({ rootDir: options.rootDir, unrestricted: options.unrestrictedRoot })
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
  const logger = createLogger({ component: "app" })
  logger.error({ err: error }, "CLI server crashed")
  process.exit(1)
})
