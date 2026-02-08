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
import { resolveHttpsOptions } from "./server/tls"
import { resolveNetworkAddresses } from "./server/network-addresses"

const require = createRequire(import.meta.url)

const packageJson = require("../package.json") as { version: string }
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DEFAULT_UI_STATIC_DIR = path.resolve(__dirname, "../public")

interface CliOptions {
  host: string
  https: boolean
  http: boolean
  httpsPort: number
  httpPort: number
  tlsKeyPath?: string
  tlsCertPath?: string
  tlsCaPath?: string
  tlsSANs?: string
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
  dangerouslySkipAuth: boolean
}

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_CONFIG_PATH = "~/.config/codenomad/config.json"
const DEFAULT_HTTPS_PORT = 9898
const DEFAULT_HTTP_PORT = 9899

function parseCliOptions(argv: string[]): CliOptions {
  const program = new Command()
    .name("codenomad")
    .description("CodeNomad CLI server")
    .version(packageJson.version, "-v, --version", "Show the CLI version")
    .addOption(new Option("--host <host>", "Host interface to bind").env("CLI_HOST").default(DEFAULT_HOST))
    .addOption(new Option("--https <enabled>", "Enable HTTPS listener (true|false)").env("CLI_HTTPS").default("true"))
    .addOption(new Option("--http <enabled>", "Enable HTTP listener (true|false)").env("CLI_HTTP").default("false"))
    .addOption(new Option("--https-port <number>", "HTTPS port (0 for auto)").env("CLI_HTTPS_PORT").default(DEFAULT_HTTPS_PORT).argParser(parsePort))
    .addOption(new Option("--http-port <number>", "HTTP port (0 for auto)").env("CLI_HTTP_PORT").default(DEFAULT_HTTP_PORT).argParser(parsePort))
    .addOption(new Option("--tls-key <path>", "TLS private key (PEM)").env("CLI_TLS_KEY"))
    .addOption(new Option("--tls-cert <path>", "TLS certificate (PEM)").env("CLI_TLS_CERT"))
    .addOption(new Option("--tls-ca <path>", "TLS CA chain (PEM)").env("CLI_TLS_CA"))
    .addOption(new Option("--tlsSANs <list>", "Additional TLS SANs (comma-separated)").env("CLI_TLS_SANS"))
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
    .addOption(
      new Option(
        "--dangerously-skip-auth",
        "Disable CodeNomad's internal auth. Use only behind a trusted perimeter (SSO/VPN/etc).",
      )
        .env("CODENOMAD_SKIP_AUTH")
        .default(false),
    )

  program.parse(argv, { from: "user" })
  const parsed = program.opts<{
    host: string
    https?: string
    http?: string
    httpsPort: number
    httpPort: number
    tlsKey?: string
    tlsCert?: string
    tlsCa?: string
    tlsSANs?: string
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
    dangerouslySkipAuth?: boolean
  }>()

  const parseBooleanEnv = (value: string | undefined): boolean => {
    const normalized = (value ?? "").trim().toLowerCase()
    return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "y" || normalized === "on"
  }

  const resolvedRoot = parsed.workspaceRoot ?? parsed.root ?? process.cwd()

  const normalizedHost = resolveHost(parsed.host)

  const autoUpdateString = (parsed.uiAutoUpdate ?? "true").trim().toLowerCase()
  const uiAutoUpdate = autoUpdateString === "1" || autoUpdateString === "true" || autoUpdateString === "yes"

  const httpsEnabled = parseBooleanEnv(parsed.https)
  const httpEnabled = parseBooleanEnv(parsed.http)

  if (!httpsEnabled && !httpEnabled) {
    throw new InvalidArgumentError("At least one listener must be enabled (--https or --http)")
  }

  return {
    host: normalizedHost,
    https: httpsEnabled,
    http: httpEnabled,
    httpsPort: parsed.httpsPort,
    httpPort: parsed.httpPort,
    tlsKeyPath: parsed.tlsKey,
    tlsCertPath: parsed.tlsCert,
    tlsCaPath: parsed.tlsCa,
    tlsSANs: parsed.tlsSANs,
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
    dangerouslySkipAuth: Boolean(parsed.dangerouslySkipAuth),
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

function resolvePath(filePath: string) {
  if (filePath.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", filePath.slice(2))
  }
  return path.resolve(filePath)
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

  if (options.dangerouslySkipAuth) {
    logger.warn(
      "DANGEROUS: internal authentication is disabled (--dangerously-skip-auth / CODENOMAD_SKIP_AUTH).",
    )
  }

  const eventBus = new EventBus(eventLogger)

  const isLoopbackHost = (host: string) => host === "127.0.0.1" || host === "::1" || host.startsWith("127.")

  const configDir = path.dirname(resolvePath(options.configPath))

  if ((options.tlsKeyPath && !options.tlsCertPath) || (!options.tlsKeyPath && options.tlsCertPath)) {
    throw new InvalidArgumentError("--tls-key and --tls-cert must be provided together")
  }

  const serverMeta: ServerMeta = {
    localUrl: "http://localhost:0",
    remoteUrl: undefined,
    eventsUrl: `/api/events`,
    host: options.host,
    listeningMode: isLoopbackHost(options.host) ? "local" : "all",
    localPort: 0,
    remotePort: undefined,
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
      dangerouslySkipAuth: options.dangerouslySkipAuth,
    },
    logger.child({ component: "auth" }),
  )

  if (options.generateToken && !options.dangerouslySkipAuth) {
    const token = authManager.issueBootstrapToken()
    if (token) {
      console.log(`${BOOTSTRAP_TOKEN_STDOUT_PREFIX}${token}`)
    }
  }

  const tlsResolution = resolveHttpsOptions({
    enabled: options.https,
    configDir,
    host: options.host,
    tlsKeyPath: options.tlsKeyPath,
    tlsCertPath: options.tlsCertPath,
    tlsCaPath: options.tlsCaPath,
    tlsSANs: options.tlsSANs,
    logger: logger.child({ component: "tls" }),
  })

  const nodeExtraCaCertsPath = !options.http ? tlsResolution?.caCertPath : undefined

  const configStore = new ConfigStore(options.configPath, eventBus, configLogger)
  const binaryRegistry = new BinaryRegistry(configStore, eventBus, configLogger)
  const workspaceManager = new WorkspaceManager({
    rootDir: options.rootDir,
    configStore,
    binaryRegistry,
    eventBus,
    logger: workspaceLogger,
    getServerBaseUrl: () => serverMeta.localUrl,
    nodeExtraCaCertsPath,
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

  if (uiResolution.uiDevServerUrl && options.https) {
    throw new InvalidArgumentError("UI dev proxy is only supported with --https=false --http=true")
  }

  const remoteAccessEnabled = options.host === "0.0.0.0" || !isLoopbackHost(options.host)

  const httpsPortExplicit = programHasArg(process.argv.slice(2), "--https-port") || Boolean(process.env.CLI_HTTPS_PORT)
  const httpPortExplicit = programHasArg(process.argv.slice(2), "--http-port") || Boolean(process.env.CLI_HTTP_PORT)

  const httpsBindPort = httpsPortExplicit ? options.httpsPort : 0
  const httpBindPort = httpPortExplicit ? options.httpPort : 0

  // Listener binding rules:
  // - Remote access enabled: HTTP listens on loopback, HTTPS on all IPs (host=0.0.0.0 / LAN IP).
  // - Remote access disabled: both listen on loopback.
  // - HTTP-only mode: respect --host (used for dev/testing).
  const httpsBindHost = remoteAccessEnabled ? options.host : "127.0.0.1"
  const httpBindHost = options.http ? (options.https ? "127.0.0.1" : options.host) : "127.0.0.1"

  const servers: Array<ReturnType<typeof createHttpServer>> = []

  const httpServer = options.http
    ? createHttpServer({
        bindHost: httpBindHost,
        bindPort: httpBindPort,
        defaultPort: options.httpPort,
        protocol: "http",
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
    : null

  const httpsServer = options.https
    ? createHttpServer({
        bindHost: httpsBindHost,
        bindPort: httpsBindPort,
        defaultPort: options.httpsPort,
        protocol: "https",
        httpsOptions: tlsResolution?.httpsOptions,
        workspaceManager,
        configStore,
        binaryRegistry,
        fileSystemBrowser,
        eventBus,
        serverMeta,
        instanceStore,
        authManager,
        uiStaticDir: uiResolution.uiStaticDir ?? DEFAULT_UI_STATIC_DIR,
        uiDevServerUrl: undefined,
        logger,
      })
    : null

  if (httpServer) servers.push(httpServer)
  if (httpsServer) servers.push(httpsServer)

  const [httpStart, httpsStart] = await Promise.all([
    httpServer ? httpServer.start() : Promise.resolve(null),
    httpsServer ? httpsServer.start() : Promise.resolve(null),
  ])

  const localStart = httpStart ?? httpsStart
  if (!localStart) {
    throw new Error("No listeners started")
  }

  const remoteStart = httpsStart ?? httpStart
  const localProtocol: "http" | "https" = httpStart ? "http" : "https"
  const remoteProtocol: "http" | "https" = httpsStart ? "https" : "http"

  // Use an explicit IPv4 loopback address for the "local" URL.
  // On macOS, `localhost` often resolves to ::1 first, and it is possible to have
  // another instance bound on IPv6 while this instance binds IPv4 (or vice versa),
  // which can lead clients to talk to the wrong process.
  const localUrl = `${localProtocol}://127.0.0.1:${localStart.port}`
  let remoteUrl: string | undefined
  if (remoteStart) {
    const wantsAll = options.host === "0.0.0.0" || !isLoopbackHost(options.host)
    let remoteHost = options.host
    if (wantsAll) {
      if (options.host === "0.0.0.0") {
        const candidates = resolveNetworkAddresses({ host: options.host, protocol: remoteProtocol, port: remoteStart.port })
        remoteHost = candidates.find((addr) => addr.scope === "external")?.ip ?? "localhost"
      }
    } else {
      remoteHost = "localhost"
    }
    remoteUrl = `${remoteProtocol}://${remoteHost}:${remoteStart.port}`
  }

  serverMeta.localUrl = localUrl
  serverMeta.localPort = localStart.port
  serverMeta.remoteUrl = remoteUrl
  serverMeta.remotePort = remoteStart?.port
  serverMeta.host = options.host
  serverMeta.listeningMode = options.host === "0.0.0.0" || !isLoopbackHost(options.host) ? "all" : "local"

  if (serverMeta.remotePort && remoteUrl) {
    serverMeta.addresses = resolveNetworkAddresses({ host: options.host, protocol: remoteProtocol, port: serverMeta.remotePort })
  } else {
    serverMeta.addresses = []
  }

  console.log(`Local Connection URL : ${serverMeta.localUrl}`)
  if (serverMeta.remoteUrl) {
    console.log(`Remote Connection URL : ${serverMeta.remoteUrl}`)
  }

  if (options.launch) {
    await launchInBrowser(serverMeta.localUrl, logger.child({ component: "launcher" }))
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
        await Promise.allSettled(servers.map((srv) => srv.stop()))
        logger.info("HTTP server(s) stopped")
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
