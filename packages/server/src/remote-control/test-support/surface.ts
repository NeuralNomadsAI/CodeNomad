import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { TestContext } from "node:test"
import type { OpenRemoteTunnelOptions, RemoteTunnel } from "@codenomad/remote-tunnel"
import { AuthManager } from "../../auth/manager"
import { createLogger } from "../../logger"
import { createHttpServer } from "../../server/http-server"
import { RemoteDeviceRegistry } from "../devices"
import { RemoteControlManager } from "../manager"

export const FAKE_TUNNEL_HOST = "codenomad-test.device.tunnel.test"
// Each logger pipes to stdout, so fixtures share one.
const logger = createLogger({ level: "silent" } as never)

/**
 * The real CodeNomad HTTP application behind a Remote Control manager, with
 * unrelated services stubbed. Without `openTunnel`, a fake tunnel exposes the
 * ingress target directly; tests then speak plain HTTP as the TLS terminator does.
 */
export async function startRemoteSurface(t: TestContext, options: {
  skipAuth?: boolean
  openTunnel?: (options: OpenRemoteTunnelOptions) => Promise<RemoteTunnel>
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-remote-surface-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const uiDir = path.join(directory, "ui")
  fs.mkdirSync(uiDir)
  fs.writeFileSync(path.join(uiDir, "index.html"), "<!doctype html><title>CodeNomad UI</title>")
  fs.writeFileSync(path.join(uiDir, "manifest.webmanifest"), JSON.stringify({ name: "CodeNomad" }))
  const authManager = new AuthManager({
    configPath: path.join(directory, "config.yaml"),
    username: "codenomad",
    password: "local-password",
    generateToken: true,
    dangerouslySkipAuth: options.skipAuth,
  }, logger)

  let target = ""
  let stopTunnel: (error?: string) => void = () => undefined
  let app: ReturnType<typeof createHttpServer>["instance"] | undefined
  const manager = new RemoteControlManager({
    registry: new RemoteDeviceRegistry(path.join(directory, "remote-control-devices.json")),
    router: () => (app ? (request, response) => app!.routing(request, response) : null),
    logger,
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
    bindHost: "127.0.0.1",
    bindPort: 0,
    defaultPort: 0,
    protocol: "http",
    workspaceManager: stub,
    settings: stub,
    fileSystemBrowser: stub,
    eventBus: stub,
    serverMeta: { localUrl: "http://localhost:0", eventsUrl: "/api/events", listeningMode: "local", localPort: 0, hostLabel: "test", workspaceRoot: directory, addresses: [] } as never,
    instanceStore: stub,
    speechService: stub,
    sidecarManager: stub,
    previewManager: stub,
    remoteControlManager: manager,
    authManager,
    clientConnectionManager: stub,
    remoteProxySessionManager: stub,
    yoloManager: stub,
    uiStaticDir: uiDir,
    logger,
    nativeParent: stub,
    automationBridgeToken: "bridge-token",
  })
  app = server.instance
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
  const started = await server.start()
  t.after(async () => {
    await manager.shutdown()
    await server.stop()
  })
  const { pairing } = await manager.start()
  return {
    manager,
    pairing,
    code: new URL(pairing.url).hash.slice(1),
    target: () => target,
    local: `127.0.0.1:${started.port}`,
    stopTunnel: (error?: string) => stopTunnel(error),
  }
}
