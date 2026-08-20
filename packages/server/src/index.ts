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
import { resolveConfigLocation } from "./config/location"
import { SettingsService } from "./settings/service"
import { BinaryResolver } from "./settings/binaries"
import { FileSystemBrowser } from "./filesystem/browser"
import { EventBus } from "./events/bus"
import { ServerMeta } from "./api-types"
import { InstanceStore } from "./storage/instance-store"
import { InstanceEventBridge } from "./workspaces/instance-events"
import { createLogger } from "./logger"
import { launchInBrowser } from "./launcher"
import { resolveUi } from "./ui/remote-ui"
import { AuthManager, BOOTSTRAP_TOKEN_STDOUT_PREFIX, DEFAULT_AUTH_COOKIE_NAME, DEFAULT_AUTH_USERNAME } from "./auth/manager"
import { resolveHttpsOptions } from "./server/tls"
import { RemoteProxySessionManager } from "./server/remote-proxy"
import { resolveNetworkAddresses, resolveRemoteAddresses } from "./server/network-addresses"
import { resolvePluginBaseUrl } from "./server/listener-base-url"
import { startDevReleaseMonitor } from "./releases/dev-release-monitor"
import { SpeechService } from "./speech/service"
import { SideCarManager } from "./sidecars/manager"
import { PreviewManager } from "./previews/manager"
import { ClientConnectionManager } from "./clients/connection-manager"
import { runCliUpgrade } from "./cli-upgrade"
import { createServerShutdownHandler, orchestrateServerShutdown, type ServerShutdownTrigger } from "./shutdown"
import { AutoAcceptManager } from "./permissions/auto-accept-manager"
import { createOpencodePermissionReplier } from "./permissions/opencode-replier"
import { createOpencodeYoloPersistence } from "./permissions/opencode-yolo-metadata"

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
  authCookieName: string
  generateToken: boolean
  dangerouslySkipAuth: boolean
  upgrade?: string | boolean
}

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_CONFIG_PATH = "~/.config/codenomad/config.json"
const DEFAULT_HTTPS_PORT = 9898
const DEFAULT_HTTP_PORT = 9899
export const STDIN_SHUTDOWN_COMMAND = "codenomad:shutdown"

interface ShutdownSignalSource {
  on: (signal: "SIGINT" | "SIGTERM", listener: () => void) => unknown
}

export function installShutdownSignalHandlers(
  source: ShutdownSignalSource,
  shutdown: (signal: ServerShutdownTrigger) => Promise<void>,
): void {
  source.on("SIGINT", () => void shutdown("SIGINT"))
  source.on("SIGTERM", () => void shutdown("SIGTERM"))
}

interface ShutdownStdinSource {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown
  off?(event: "data", listener: (chunk: Buffer | string) => void): unknown
  destroy?(): unknown
}

export function installShutdownStdinHandler(
  source: ShutdownStdinSource,
  shutdown: (signal: ServerShutdownTrigger) => Promise<void>,
): void {
  let buffer = ""
  let requested = false
  const onData = (chunk: Buffer | string) => {
    if (requested) return
    buffer += chunk.toString()
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ""
    if (!lines.some((line) => line.trim() === STDIN_SHUTDOWN_COMMAND)) return

    requested = true
    source.off?.("data", onData)
    source.destroy?.()
    void shutdown("stdin")
  }
  source.on("data", onData)
}

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
      new Option("--workspace-root <path>", "Restricts root path where workspaces can be opened").env("CLI_WORKSPACE_ROOT").default(process.cwd()),
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
      new Option("--auth-cookie-name <name>", "Cookie name for server authentication")
        .env("CODENOMAD_AUTH_COOKIE_NAME")
        .default(DEFAULT_AUTH_COOKIE_NAME),
    )
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
    .addOption(new Option("--upgrade [version]", "Upgrade the global CodeNomad CLI server package and exit"))

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
    authCookieName: string
    generateToken?: boolean
    dangerouslySkipAuth?: boolean
    upgrade?: string | boolean
  }>()

  const upgrade = parsed.upgrade
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

  if (upgrade === undefined && !httpsEnabled && !httpEnabled) {
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
    authCookieName: parsed.authCookieName,
    generateToken: Boolean(parsed.generateToken),
    dangerouslySkipAuth: Boolean(parsed.dangerouslySkipAuth),
    upgrade,
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

export function programHasArg(argv: string[], flag: string): boolean {
  return argv.some((argument) => argument === flag || argument.startsWith(`${flag}=`))
}

async function main() {
  const options = parseCliOptions(process.argv.slice(2))
  if (options.upgrade !== undefined) {
    const version = typeof options.upgrade === "string" ? options.upgrade : undefined
    process.exitCode = await runCliUpgrade(version)
    return
  }

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

  const configLocation = resolveConfigLocation(options.configPath)
  const configDir = configLocation.baseDir

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
      configPath: configLocation.configYamlPath,
      username: options.authUsername,
      password: options.authPassword,
      cookieName: options.authCookieName,
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

  const settings = new SettingsService(configLocation, eventBus, configLogger)
  const binaryResolver = new BinaryResolver(settings)
  const workspaceManager = new WorkspaceManager({
    rootDir: options.rootDir,
    settings,
    binaryResolver,
    eventBus,
    logger: workspaceLogger,
  })
  const fileSystemBrowser = new FileSystemBrowser({
    rootDir: options.rootDir,
    unrestricted: options.unrestrictedRoot,
  })
  const instanceStore = new InstanceStore(configLocation.instancesDir)
  const speechService = new SpeechService(settings, logger.child({ component: "speech" }))
  const sidecarManager = new SideCarManager({
    settings,
    eventBus,
    logger: logger.child({ component: "sidecars" }),
  })
  const previewManager = new PreviewManager()
  const yoloLogger = logger.child({ component: "yolo" })
  const sessionMetadataPersistence = createOpencodeYoloPersistence(workspaceManager, settings)
  const yoloManager = new AutoAcceptManager({
    eventBus,
    logger: yoloLogger,
    replier: createOpencodePermissionReplier({ workspaceManager }),
    persistence: sessionMetadataPersistence,
  })
  yoloManager.start()
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

  const updateChannel = (process.env.CODENOMAD_UPDATE_CHANNEL ?? "").trim().toLowerCase()
  const githubRepo = (process.env.CODENOMAD_GITHUB_REPO ?? "NeuralNomadsAI/CodeNomad").trim()
  const isDevVersion = packageJson.version.includes("-dev.") || packageJson.version.includes("-dev-")
  const enableDevUpdateChecks = updateChannel === "dev" || (updateChannel === "" && isDevVersion)
  const devReleaseMonitor = enableDevUpdateChecks
    ? startDevReleaseMonitor({
        currentVersion: packageJson.version,
        repo: githubRepo,
        logger: logger.child({ component: "updates" }),
        onUpdate: (release) => {
          serverMeta.update = release
        },
      })
    : null

  const remoteAccessEnabled = options.host === "0.0.0.0" || !isLoopbackHost(options.host)

  const clientConnectionManager = new ClientConnectionManager(logger.child({ component: "client-connections" }))
  const remoteProxySessionManager = new RemoteProxySessionManager({
    authManager,
    logger: logger.child({ component: "remote-proxy" }),
    httpsOptions: tlsResolution?.httpsOptions,
  })
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
        settings,
        fileSystemBrowser,
        eventBus,
        serverMeta,
        instanceStore,
        speechService,
        sidecarManager,
        previewManager,
        authManager,
        clientConnectionManager,
        remoteProxySessionManager,
        yoloManager,
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
        settings,
        fileSystemBrowser,
        eventBus,
        serverMeta,
        instanceStore,
        speechService,
        sidecarManager,
        previewManager,
        authManager,
        clientConnectionManager,
        remoteProxySessionManager,
        yoloManager,
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
  const remoteProtocol: "http" | "https" = httpsStart ? "https" : "http"

  let remoteUrl: string | undefined
  let remoteAddresses = [] as ReturnType<typeof resolveNetworkAddresses>
  if (remoteStart) {
    const wantsAll = options.host === "0.0.0.0" || !isLoopbackHost(options.host)
    let remoteHost = options.host
    if (wantsAll) {
      if (options.host === "0.0.0.0") {
        const resolved = resolveRemoteAddresses({ host: options.host, protocol: remoteProtocol, port: remoteStart.port })
        remoteAddresses = resolved.userVisible
        remoteUrl = resolved.primaryRemoteUrl ?? `${remoteProtocol}://localhost:${remoteStart.port}`
      }
    } else {
      remoteHost = "localhost"
    }
    if (!remoteUrl) {
      remoteUrl = `${remoteProtocol}://${remoteHost}:${remoteStart.port}`
    }
  }

  // Prefer an explicit IPv4 loopback address only when one of the bound listeners
  // accepts loopback. Concrete LAN bindings do not, so plugins need the reachable
  // bound/listener URL instead of an unreachable 127.0.0.1 URL.
  const localUrl = resolvePluginBaseUrl({
    httpStart: httpStart ? { protocol: "http", bindHost: httpBindHost, port: httpStart.port } : null,
    httpsStart: httpsStart ? { protocol: "https", bindHost: httpsBindHost, port: httpsStart.port } : null,
    remoteUrl,
  })

  serverMeta.localUrl = localUrl
  serverMeta.localPort = localStart.port
  serverMeta.remoteUrl = remoteUrl
  serverMeta.remotePort = remoteStart?.port
  serverMeta.host = options.host
  serverMeta.listeningMode = options.host === "0.0.0.0" || !isLoopbackHost(options.host) ? "all" : "local"

  if (serverMeta.remotePort && remoteUrl) {
    serverMeta.addresses = remoteAddresses.length
      ? remoteAddresses
      : resolveNetworkAddresses({ host: options.host, protocol: remoteProtocol, port: serverMeta.remotePort })
  } else {
    serverMeta.addresses = []
  }

  console.log(`Local Connection URL : ${serverMeta.localUrl}`)
  if (serverMeta.remoteUrl) {
    console.log(`Remote Connection URL : ${serverMeta.remoteUrl}`)
    const additionalRemoteUrls = serverMeta.addresses
      .map((addr) => addr.remoteUrl)
      .filter((url) => url !== serverMeta.remoteUrl)

    if (additionalRemoteUrls.length > 0) {
      console.log("Other Accessible URLs:")
      for (const url of additionalRemoteUrls) {
        console.log(`  - ${url}`)
      }
    }
  }

  if (options.launch) {
    await launchInBrowser(serverMeta.localUrl, logger.child({ component: "launcher" }))
  }

  const shutdown = createServerShutdownHandler({
    logger,
    holdAfterFailure: () => new Promise<void>(() => { setInterval(() => undefined, 60_000) }),
    setExitCode: (code) => {
      process.stdin.destroy()
      process.exitCode = code
    },
    shutdown: () =>
      orchestrateServerShutdown(
        {
          stopInstanceEventBridge: () => instanceEventBridge.shutdown(),
          stopSidecars: () => sidecarManager.shutdown(),
          stopClientConnections: () => clientConnectionManager.shutdown(),
          stopRemoteProxySessions: () => remoteProxySessionManager.shutdown(),
          stopWorkspaces: () => workspaceManager.shutdown(),
          stopHttpServers: async () => {
            yoloManager.stop()
            const results = await Promise.allSettled(servers.map((srv) => srv.stop()))
            const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
            if (failures.length > 0) {
              const error = new Error("One or more HTTP servers failed to stop") as Error & { failures: unknown[] }
              error.failures = failures
              throw error
            }
            logger.info("HTTP server(s) stopped")
          },
          stopReleaseMonitor: () => devReleaseMonitor?.stop(),
        },
        logger,
      ),
  })

  installShutdownSignalHandlers(process, shutdown)
  installShutdownStdinHandler(process.stdin, shutdown)
}

if (path.resolve(process.argv[1] ?? "") === __filename) {
  main().catch((error) => {
    const logger = createLogger({ component: "app" })
    logger.error({ err: error }, "CLI server crashed")
    process.exit(1)
  })
}
