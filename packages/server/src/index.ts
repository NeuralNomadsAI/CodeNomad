/**
 * CLI entry point.
 * For now this only wires the typed modules together; actual command handling comes later.
 */
import { Command, InvalidArgumentError, Option } from "commander"
import path from "path"
import { fileURLToPath } from "url"
import { createRequire } from "module"
import { createHttpServer } from "./server/http-server"
import { WorkspaceManager } from "./workspaces/manager"
import { ConfigStore } from "./config/store"
import { BinaryRegistry } from "./config/binaries"
import { FileSystemBrowser } from "./filesystem/browser"
import { EventBus } from "./events/bus"
import { ServerMeta } from "./api-types"
import { InstanceStore } from "./storage/instance-store"
import { InstanceEventBridge } from "./workspaces/instance-events"
import { createLogger } from "./logger"
import { launchInBrowser } from "./launcher"
import { startReleaseMonitor } from "./releases/release-monitor"
import { cleanupOrphanedWorkspaces } from "./workspaces/pid-registry"

const require = createRequire(import.meta.url)

const packageJson = require("../package.json") as { version: string }
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DEFAULT_UI_STATIC_DIR = path.resolve(__dirname, "../public")

interface CliOptions {
  port: number
  host: string
  rootDir: string
  configPath: string
  unrestrictedRoot: boolean
  logLevel?: string
  logDestination?: string
  uiStaticDir: string
  uiDevServer?: string
  launch: boolean
}

const DEFAULT_PORT = 9898
const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_CONFIG_PATH = "~/.config/era-code/config.json"

function parseCliOptions(argv: string[]): CliOptions {
  const program = new Command()
    .name("era-code")
    .description("Era Code CLI server")
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
    .addOption(
      new Option("--ui-dir <path>", "Directory containing the built UI bundle").env("CLI_UI_DIR").default(DEFAULT_UI_STATIC_DIR),
    )
    .addOption(new Option("--ui-dev-server <url>", "Proxy UI requests to a running dev server").env("CLI_UI_DEV_SERVER"))
    .addOption(new Option("--launch", "Launch the UI in a browser after start").env("CLI_LAUNCH").default(false))

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
    uiDir: string
    uiDevServer?: string
    launch?: boolean
  }>()

  const resolvedRoot = parsed.workspaceRoot ?? parsed.root ?? process.cwd()

  const normalizedHost = resolveHost(parsed.host)

  return {
    port: parsed.port,
    host: normalizedHost,
    rootDir: resolvedRoot,
    configPath: parsed.config,
    unrestrictedRoot: Boolean(parsed.unrestrictedRoot),
    logLevel: parsed.logLevel,
    logDestination: parsed.logDestination,
    uiStaticDir: parsed.uiDir,
    uiDevServer: parsed.uiDevServer,
    launch: Boolean(parsed.launch),
  }
}

function parsePort(input: string): number {
  const value = Number(input)
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new InvalidArgumentError("Port must be an integer between 0 and 65535")
  }
  return value
}

function resolveHost(input: string | undefined): string {
  const trimmed = input?.trim()
  if (!trimmed) return DEFAULT_HOST

  if (trimmed === "0.0.0.0") {
    return "0.0.0.0"
  }

  if (trimmed === "localhost") {
    return DEFAULT_HOST
  }

  return trimmed
}

async function main() {
  const options = parseCliOptions(process.argv.slice(2))
  const logger = createLogger({ level: options.logLevel, destination: options.logDestination, component: "app" })
  const workspaceLogger = logger.child({ component: "workspace" })
  const configLogger = logger.child({ component: "config" })
  const eventLogger = logger.child({ component: "events" })

  logger.info({ options }, "Starting Era Code CLI server")

  // Clean up any orphaned workspace processes from previous crashes
  cleanupOrphanedWorkspaces(workspaceLogger)

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
  const instanceEventBridge = new InstanceEventBridge({
    workspaceManager,
    eventBus,
    logger: logger.child({ component: "instance-events" }),
  })

  const isLoopbackHost = (host: string) => host === "127.0.0.1" || host === "::1" || host.startsWith("127.")

  const serverMeta: ServerMeta = {
    httpBaseUrl: `http://${options.host}:${options.port}`,
    eventsUrl: `/api/events`,
    host: options.host,
    listeningMode: isLoopbackHost(options.host) ? "local" : "all",
    port: options.port,
    hostLabel: options.host,
    workspaceRoot: options.rootDir,
    unrestrictedRoot: options.unrestrictedRoot,
    addresses: [],
  }

  const releaseMonitor = startReleaseMonitor({
    currentVersion: packageJson.version,
    logger: logger.child({ component: "release-monitor" }),
    onUpdate: (release) => {
      if (release) {
        serverMeta.latestRelease = release
        eventBus.publish({ type: "app.releaseAvailable", release })
      } else {
        delete serverMeta.latestRelease
      }
    },
  })

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
    uiStaticDir: options.uiStaticDir,
    uiDevServerUrl: options.uiDevServer,
    logger,
  })

  const startInfo = await server.start()
  logger.info({ port: startInfo.port, host: options.host }, "HTTP server listening")
  console.log(`Era Code Server is ready at ${startInfo.url}`)

  if (options.launch) {
    await launchInBrowser(startInfo.url, logger.child({ component: "launcher" }))
  }

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
      instanceEventBridge.shutdown()
      await workspaceManager.shutdown()
      logger.info("Workspace manager shutdown complete")
    } catch (error) {
      logger.error({ err: error }, "Workspace manager shutdown failed")
    }

    releaseMonitor.stop()

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
