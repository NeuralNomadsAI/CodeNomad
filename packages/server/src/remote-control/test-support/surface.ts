import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { TestContext } from "node:test"
import type { OpenRemoteTunnelOptions, RemoteTunnel } from "@codenomad/remote-tunnel"
import { AuthManager } from "../../auth/manager"
import { EventBus } from "../../events/bus"
import { createLogger } from "../../logger"
import { PreviewManager } from "../../previews/manager"
import { createHttpServer } from "../../server/http-server"
import type { PanelExtensionStore } from "../../panel-extensions/store"
import type { MemoryStore } from "../../memory/store"
import { RemoteDeviceRegistry } from "../devices"
import { verifiedHttpsOrigins } from "../direct-https"
import { RemoteControlManager } from "../manager"
import type { LiveVoiceGateway } from "../../speech/live-voice-gateway"
import type { Logger } from "../../logger"

export const FAKE_TUNNEL_HOST = "codenomad-test.device.tunnel.test"
// Each logger pipes to stdout, so fixtures share one.
const defaultLogger = createLogger({ level: "silent" } as never)

/**
 * The real CodeNomad HTTP application behind a Remote Control manager, with
 * unrelated services stubbed. Without `openTunnel`, a fake tunnel exposes the
 * ingress target directly; tests then speak plain HTTP as the TLS terminator does.
 */
export async function startRemoteSurface(t: TestContext, options: {
  sessionIdleMs?: number
  sessionAbsoluteMs?: number
  password?: string | null
  skipAuth?: boolean
  now?: () => number
  browse?: boolean
  bindHost?: string
  allowedOrigins?: string[]
  liveVoice?: LiveVoiceGateway
  httpsOptions?: Parameters<typeof createHttpServer>[0]["httpsOptions"]
  logger?: Logger
  /** Settings service in place of the stub, such as one that reads the host's SideCar opt-in. */
  settings?: unknown
  memoryStore?: MemoryStore
  workspaceManager?: unknown
  serverIdentity?: { serverId: string; apiContract: number }
  sidecarManager?: unknown
  configureApp?: (app: ReturnType<typeof createHttpServer>["instance"]) => void
  openTunnel?: (options: OpenRemoteTunnelOptions) => Promise<RemoteTunnel>
  /** Real panel extension routes over this store, with `workspaceManager` in place of the stub. */
  panelExtensions?: { store: PanelExtensionStore; workspaceManager: unknown }
  /** Declares extra test routes on the application before it starts. */
  routes?: (app: ReturnType<typeof createHttpServer>["instance"]) => void
} = {}) {
  const serverLogger = options.logger ?? defaultLogger
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-remote-surface-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const uiDir = path.join(directory, "ui")
  fs.mkdirSync(uiDir)
  fs.writeFileSync(path.join(uiDir, "index.html"), "<!doctype html><title>CodeNomad UI</title>")
  fs.writeFileSync(path.join(uiDir, "manifest.webmanifest"), JSON.stringify({ name: "CodeNomad" }))
  const authManager = new AuthManager({
    configPath: path.join(directory, "config.yaml"),
    username: "codenomad",
    password: options.password === null ? undefined : options.password ?? "local-password",
    generateToken: true,
    dangerouslySkipAuth: options.skipAuth,
    sessionIdleMs: options.sessionIdleMs,
    sessionAbsoluteMs: options.sessionAbsoluteMs,
  }, serverLogger)

  let target = ""
  let stopTunnel: (error?: string) => void = () => undefined
  let app: ReturnType<typeof createHttpServer>["instance"] | undefined
  let previewUpgrade: ReturnType<typeof createHttpServer>["previewUpgrade"] | null = null
  let voiceUpgrade: ReturnType<typeof createHttpServer>["remoteVoiceUpgrade"] | null = null
  const previewManager = new PreviewManager()
  const serverMeta = { localUrl: "http://localhost:0", eventsUrl: "/api/events", host: "127.0.0.1", listeningMode: "local", localPort: 0, hostLabel: "test", workspaceRoot: directory, addresses: [], ...options.serverIdentity }
  const registryPath = path.join(directory, "remote-control-devices.json")
  const manager = new RemoteControlManager({
    directHttpsOrigins: () => verifiedHttpsOrigins(serverMeta, options.allowedOrigins),
    registry: new RemoteDeviceRegistry(registryPath, options.now),
    router: () => (app ? (request, response) => app!.routing(request, response) : null),
    previewUpgrade: () => previewUpgrade,
    voiceUpgrade: () => voiceUpgrade,
    hasPreview: (token) => previewManager.get(token) !== undefined || server.servesRemotePreview(token),
    logger: serverLogger,
    openTunnel: async (tunnelOptions) => {
      target = tunnelOptions.target
      if (options.openTunnel) return options.openTunnel(tunnelOptions)
      let resolveClosed!: (value: string | undefined) => void
      const closed = new Promise<string | undefined>((resolve) => { resolveClosed = resolve })
      stopTunnel = (error) => resolveClosed(error)
      return {
        url: `https://${FAKE_TUNNEL_HOST}`,
        hostname: FAKE_TUNNEL_HOST,
        status: () => ({ state: "connected", connections: 0 }),
        closed,
        close: async () => resolveClosed(undefined),
      } satisfies RemoteTunnel
    },
  })

  const stub = new Proxy({}, { get: () => () => undefined }) as never
  const server = createHttpServer({
    bindHost: options.bindHost ?? "127.0.0.1",
    allowedOrigins: options.allowedOrigins,
    bindPort: 0,
    defaultPort: 0,
    protocol: options.httpsOptions ? "https" : "http",
    httpsOptions: options.httpsOptions,
    workspaceManager: (options.workspaceManager ?? options.panelExtensions?.workspaceManager ?? stub) as never,
    memoryStore: options.memoryStore,
    panelExtensions: options.panelExtensions?.store,
    settings: (options.settings ?? (options.browse ? { getOwner: () => ({ recentFolders: [] }) } : stub)) as never,
    fileSystemBrowser: options.browse ? { browse: () => ({ entries: [{ name: "app", path: "/srv/app", type: "directory" }],
      metadata: { scope: "unrestricted", pathKind: "absolute", currentPath: "/srv", rootPath: "/", homePath: "/srv", displayPath: "/srv" } }) } as never : stub,
    eventBus: new EventBus(),
    serverMeta: serverMeta as never,
    instanceStore: stub,
    speechService: stub,
    liveVoice: options.liveVoice,
    sidecarManager: (options.sidecarManager ?? stub) as never,
    previewManager,
    remoteControlManager: manager,
    authManager,
    clientConnectionManager: stub,
    remoteProxySessionManager: stub,
    uiStaticDir: uiDir,
    logger: serverLogger,
    nativeParent: stub,
    automationBridgeToken: "bridge-token",
  })
  app = server.instance
  previewUpgrade = server.previewUpgrade
  voiceUpgrade = server.remoteVoiceUpgrade
  app.get("/api/test/echo", async (request) => ({
    loopbackPrivileges: authManager.isLoopbackRequest(request),
    forwardedFor: request.headers["x-forwarded-for"] ?? null,
    remoteControlHeader: request.headers["x-codenomad-remote-control"] ?? null,
  }))
  app.get("/api/test/stream", (_request, reply) => {
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" })
    reply.raw.write("data: open\n\n")
    const timer = setInterval(() => reply.raw.write("data: tick\n\n"), 20)
    reply.raw.on("close", () => clearInterval(timer))
  })
  options.configureApp?.(app)
  options.routes?.(app)
  const started = await server.start()
  t.after(async () => {
    await manager.shutdown()
    await server.stop()
  })
  const { pairing } = await manager.start()
  return {
    app,
    authManager,
    manager,
    previewManager,
    registryPath,
    pairing,
    code: new URL(pairing.url).hash.slice(1),
    target: () => target,
    local: `127.0.0.1:${started.port}`,
    stopTunnel: (error?: string) => stopTunnel(error),
  }
}
