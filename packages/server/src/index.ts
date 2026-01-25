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
import { resolveUi } from "./ui/remote-ui"
import { AuthManager, BOOTSTRAP_TOKEN_STDOUT_PREFIX, DEFAULT_AUTH_USERNAME } from "./auth/manager"

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
  uiAutoUpdate: boolean
  uiNoUpdate: boolean
  uiManifestUrl?: string
  launch: boolean
  authUsername: string
  authPassword?: string
  generateToken: boolean
}

const DEFAULT_PORT = 9898
const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_CONFIG_PATH = "~/.config/codenomad/config.json"

function parseCliOptions(argv: string[]): CliOptions {
  const program = new Command()
    .name("codenomad")
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
    .addOption(
      new Option("--ui-dir <path>", "Directory containing the built UI bundle").env("CLI_UI_DIR").default(DEFAULT_UI_STATIC_DIR),
    )
    .addOption(new Option("--ui-dev-server <url>", "Proxy UI requests to a running dev server").env("CLI_UI_DEV_SERVER"))
    .addOption(new Option("--ui-no-update", "Disable remote UI updates").env("CLI_UI_NO_UPDATE").default(false))
    .addOption(new Option("--ui-auto-update <enabled>", "Enable remote UI updates (true|false)").env("CLI_UI_AUTO_UPDATE").default("true"))
    .addOption(new Option("--ui-manifest-url <url>", "Remote UI manifest URL").env("CLI_UI_MANIFEST_URL"))
    .addOption(new Option("--launch", "Launch the UI in a browser after start").env("CLI_LAUNCH").default(false))
    .addOption(
      new Option("--username <username>", "Username for server authentication")
        .env("CODENOMAD_SERVER_USERNAME")
        .default(DEFAULT_AUTH_USERNAME),
    )
    .addOption(new Option("--password <password>", "Password for server authentication").env("CODENOMAD_SERVER_PASSWORD"))
    .addOption(
      new Option("--generate-token", "Emit a one-time bootstrap token for desktop")
        .env("CODENOMAD_GENERATE_TOKEN")
        .default(false),
    )

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
    uiNoUpdate?: boolean
    uiAutoUpdate?: string
    uiManifestUrl?: string
    launch?: boolean
    username: string
    password?: string
    generateToken?: boolean
  }>()

  const resolvedRoot = parsed.workspaceRoot ?? parsed.root ?? process.cwd()

  const normalizedHost = resolveHost(parsed.host)

  const autoUpdateString = (parsed.uiAutoUpdate ?? "true").trim().toLowerCase()
  const uiAutoUpdate = autoUpdateString === "1" || autoUpdateString === "true" || autoUpdateString === "yes"

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
    uiAutoUpdate,
    uiNoUpdate: Boolean(parsed.uiNoUpdate),
    uiManifestUrl: parsed.uiManifestUrl,
    launch: Boolean(parsed.launch),
    authUsername: parsed.username,
    authPassword: parsed.password,
    generateToken: Boolean(parsed.generateToken),
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

function programHasArg(argv: string[], flag: string): boolean {
  return argv.includes(flag)
}

async function main() {
  const options = parseCliOptions(process.argv.slice(2))
  const logger = createLogger({ level: options.logLevel, destination: options.logDestination, component: "app" })
  const workspaceLogger = logger.child({ component: "workspace" })
  const configLogger = logger.child({ component: "config" })
  const eventLogger = logger.child({ component: "events" })

  const logOptions = {
    ...options,
    authPassword: options.authPassword ? "[REDACTED]" : undefined,
  }

  logger.info({ options: logOptions }, "Starting CodeNomad CLI server")

  const eventBus = new EventBus(eventLogger)

  const isLoopbackHost = (host: string) => host === "127.0.0.1" || host === "::1" || host.startsWith("127.")

  const serverMeta: ServerMeta = {
    httpBaseUrl: `http://${options.host}:${options.port}`,
    eventsUrl: `/api/events`,
    host: options.host,
    listeningMode: isLoopbackHost(options.host) ? "local" : "all",
    port: options.port,
    hostLabel: options.host,
    workspaceRoot: options.rootDir,
    addresses: [],
  }

  const authManager = new AuthManager(
    {
      configPath: options.configPath,
      username: options.authUsername,
      password: options.authPassword,
      generateToken: options.generateToken,
    },
    logger.child({ component: "auth" }),
  )

  if (options.generateToken) {
    const token = authManager.issueBootstrapToken()
    if (token) {
      console.log(`${BOOTSTRAP_TOKEN_STDOUT_PREFIX}${token}`)
    }
  }

  const configStore = new ConfigStore(options.configPath, eventBus, configLogger)
  const binaryRegistry = new BinaryRegistry(configStore, eventBus, configLogger)
  const workspaceManager = new WorkspaceManager({
    rootDir: options.rootDir,
    configStore,
    binaryRegistry,
    eventBus,
    logger: workspaceLogger,
    getServerBaseUrl: () => serverMeta.httpBaseUrl,
  })
  const fileSystemBrowser = new FileSystemBrowser({ rootDir: options.rootDir, unrestricted: options.unrestrictedRoot })
  const instanceStore = new InstanceStore()
  const instanceEventBridge = new InstanceEventBridge({
    workspaceManager,
    eventBus,
    logger: logger.child({ component: "instance-events" }),
  })

  const uiDirEnvOverride = Boolean(process.env.CLI_UI_DIR)
  const uiDirCliOverride = programHasArg(process.argv.slice(2), "--ui-dir")
  const uiOverrideIsExplicit = uiDirEnvOverride || uiDirCliOverride
  const uiDirOverride = uiOverrideIsExplicit ? options.uiStaticDir : undefined

  const autoUpdateEnabled = options.uiAutoUpdate && !options.uiNoUpdate

  const uiResolution = await resolveUi({
    serverVersion: packageJson.version,
    bundledUiDir: DEFAULT_UI_STATIC_DIR,
    autoUpdate: autoUpdateEnabled,
    overrideUiDir: uiDirOverride,
    uiDevServerUrl: options.uiDevServer,
    manifestUrl: options.uiManifestUrl,
    logger: logger.child({ component: "ui" }),
  })

  serverMeta.serverVersion = packageJson.version
  serverMeta.ui = {
    version: uiResolution.uiVersion,
    source: uiResolution.source,
  }
  serverMeta.support = {
    supported: uiResolution.supported,
    message: uiResolution.message,
    latestServerVersion: uiResolution.latestServerVersion,
    latestServerUrl: uiResolution.latestServerUrl,
    minServerVersion: uiResolution.minServerVersion,
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
    authManager,
    uiStaticDir: uiResolution.uiStaticDir ?? DEFAULT_UI_STATIC_DIR,
    uiDevServerUrl: uiResolution.uiDevServerUrl,
    logger,
  })

  const startInfo = await server.start()
  logger.info({ port: startInfo.port, host: options.host }, "HTTP server listening")
  console.log(`CodeNomad Server is ready at ${startInfo.url}`)

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
    logger.info("Received shutdown signal, stopping workspaces and server")

    const shutdownWorkspaces = (async () => {
      try {
        instanceEventBridge.shutdown()
      } catch (error) {
        logger.warn({ err: error }, "Instance event bridge shutdown failed")
      }

      try {
        await workspaceManager.shutdown()
        logger.info("Workspace manager shutdown complete")
      } catch (error) {
        logger.error({ err: error }, "Workspace manager shutdown failed")
      }
    })()

    const shutdownHttp = (async () => {
      try {
        await server.stop()
        logger.info("HTTP server stopped")
      } catch (error) {
        logger.error({ err: error }, "Failed to stop HTTP server")
      }
    })()

    await Promise.allSettled([shutdownWorkspaces, shutdownHttp])

    // no-op: remote UI manifest replaces GitHub release monitor

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
