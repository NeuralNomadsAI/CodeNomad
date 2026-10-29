import type { IncomingMessage, ServerResponse } from "node:http"
import type { Socket } from "node:net"
import type { OpenRemoteTunnelOptions, RemoteTunnel } from "@codenomad/remote-tunnel"
import type {
  RemoteControlDevice,
  RemoteControlPairing,
  RemoteControlStartResponse,
  RemoteControlStatus,
} from "../api-types"
import type { Logger } from "../logger"
import { deviceNameFromUserAgent, pairingFromCode, type RemoteDeviceRegistry } from "./devices"
import { admitRemoteUpgrade, type RemoteGateDeps } from "./gate"
import { RemoteIngress } from "./ingress"
import type { RemoteControlOwnerLease } from "./owner-lease"

type OpenTunnel = (options: OpenRemoteTunnelOptions) => Promise<RemoteTunnel>

interface ManagerOptions {
  registry: RemoteDeviceRegistry
  /** Routes a decrypted request into the CodeNomad HTTP application. */
  router: () => ((request: IncomingMessage, response: ServerResponse) => void) | null
  /** Proxies an admitted web preview WebSocket upgrade; false when no preview path matched. */
  previewUpgrade?: () => ((request: IncomingMessage, socket: Socket, head: Buffer) => boolean) | null
  /** Whether a web preview capability token is live. */
  hasPreview?: (token: string) => boolean
  logger: Logger
  /** Self-hosted OpenTunnel API; the hosted relay when omitted. */
  tunnelApi?: string
  openTunnel?: OpenTunnel
  /** Restricts resuming at launch to one backend per config directory. */
  lease?: RemoteControlOwnerLease
}

export class RemoteControlManager {
  private readonly ingress: RemoteIngress
  private tunnel: RemoteTunnel | null = null
  private starting: Promise<RemoteTunnel> | null = null
  // Incremented by every stop, so a start still provisioning cannot outlive it.
  private generation = 0
  private startingGeneration = -1
  private enabled = false
  private error: string | undefined
  private lastConnectedAt: string | undefined

  constructor(private readonly options: ManagerOptions) {
    this.ingress = new RemoteIngress((request, response) => {
      const route = options.router()
      if (route) route(request, response)
      else response.writeHead(503).end()
    }, (request, socket, head) => {
      const upgrade = admitRemoteUpgrade(request, this.gate()) ? options.previewUpgrade?.() : null
      return upgrade ? upgrade(request, socket, head) : false
    })
  }

  status(): RemoteControlStatus {
    const tunnel = this.tunnel
    const tunnelState = tunnel?.status().state
    const state: RemoteControlStatus["state"] = !this.enabled
      ? this.error ? "error" : "stopped"
      : !tunnel ? "connecting"
      : tunnelState === "stopped" ? "error"
      : tunnelState ?? "connecting"
    return {
      manageable: true,
      enabled: this.enabled,
      startsOnLaunch: this.options.registry.startsOnLaunch(),
      previews: this.options.registry.previewsAllowed(),
      state,
      ...(tunnel ? { remoteUrl: tunnel.url } : {}),
      pairedDevices: this.options.registry.list().length,
      ...(this.lastConnectedAt ? { lastConnectedAt: this.lastConnectedAt } : {}),
      ...(this.error ? { error: this.error } : {}),
    }
  }

  async start(): Promise<RemoteControlStartResponse> {
    this.enabled = true
    this.error = undefined
    this.options.registry.setStartsOnLaunch(true)
    // An explicit Start proceeds even if another backend holds the lease.
    this.options.lease?.tryAcquire()
    const tunnel = await this.ensureTunnel()
    return { status: this.status(), pairing: this.pairingFor(tunnel) }
  }

  /** Reconnects at launch when the user left Remote Control on. Issues no pairing code. */
  async resume(): Promise<void> {
    if (this.enabled || !this.options.registry.startsOnLaunch()) return
    if (this.options.lease && !this.options.lease.tryAcquire()) {
      this.options.logger.info("Remote Control runs in another CodeNomad backend with this configuration; not resuming")
      return
    }
    this.enabled = true
    this.error = undefined
    // A failure is reported through status(); the choice stays until an explicit Stop.
    await this.ensureTunnel().catch(() => undefined)
  }

  async stop(): Promise<RemoteControlStatus> {
    this.options.registry.setStartsOnLaunch(false)
    this.enabled = false
    this.error = undefined
    this.generation += 1
    await this.release()
    return this.status()
  }

  createPairing(): RemoteControlPairing {
    if (!this.enabled || !this.tunnel) throw new Error("Remote Control is not connected")
    return this.pairingFor(this.tunnel)
  }

  exchangePairing(code: string, userAgent: string | undefined): { device: RemoteControlDevice; token: string } | null {
    if (!this.enabled || !this.tunnel) return null
    const paired = this.options.registry.exchange(code, deviceNameFromUserAgent(userAgent))
    if (!paired) return null
    // A device replaced at the limit loses its live connections, as on revocation.
    if (paired.evictedId) this.ingress.disconnectDevice(paired.evictedId)
    return { device: paired.device, token: paired.token }
  }

  devices(): RemoteControlDevice[] {
    return this.options.registry.list()
  }

  /** A paired device remains a live principal only while Remote Control is connected and it is not revoked or expired. */
  isDeviceAuthorized(id: string): boolean {
    return this.enabled && this.tunnel !== null && this.options.registry.isPaired(id)
  }

  revokeDevice(id: string): boolean {
    const revoked = this.options.registry.revoke(id)
    // Revocation also ends live HTTP and SSE connections already admitted.
    this.ingress.disconnectDevice(id)
    return revoked
  }

  previewsAllowed(): boolean {
    return this.options.registry.previewsAllowed()
  }

  /** The host's choice; turning previews off also closes their live WebSockets. */
  setPreviewsAllowed(allowed: boolean): RemoteControlStatus {
    this.options.registry.setPreviewsAllowed(allowed)
    if (!allowed) this.ingress.disconnectUpgrades()
    return this.status()
  }

  gate(): RemoteGateDeps {
    return {
      publicHost: () => (this.enabled ? this.tunnel?.hostname ?? null : null),
      authenticate: (token) => this.options.registry.authenticate(token),
      assignDevice: (socket, deviceId) => this.ingress.assignDevice(socket, deviceId),
      servesPreview: (token) => this.options.registry.previewsAllowed() && this.options.hasPreview?.(token) === true,
    }
  }

  shutdown(): Promise<void> {
    this.enabled = false
    this.generation += 1
    return this.release()
  }

  private ensureTunnel(): Promise<RemoteTunnel> {
    if (this.tunnel) return Promise.resolve(this.tunnel)
    if (this.starting && this.startingGeneration === this.generation) return this.starting
    // A start abandoned by stop must settle before a new one reuses the ingress.
    const previous = this.starting?.catch(() => undefined) ?? Promise.resolve()
    const generation = this.generation
    const starting: Promise<RemoteTunnel> = previous.then(() => this.open(generation)).finally(() => {
      if (this.starting === starting) this.starting = null
    })
    this.starting = starting
    this.startingGeneration = generation
    return starting
  }

  private async open(generation: number): Promise<RemoteTunnel> {
    const openTunnel = this.options.openTunnel ?? (async (options: OpenRemoteTunnelOptions) => (await import("./tunnel-runtime")).openRemoteTunnel(options))
    try {
      const target = await this.ingress.start()
      // No signal: OpenTunnel ignores it while connecting and closes the live
      // connection whenever it aborts afterwards, so a deadline would only end
      // a connected tunnel.
      const tunnel = await openTunnel({
        route: this.options.registry.route(),
        target,
        ...(this.options.tunnelApi ? { api: this.options.tunnelApi } : {}),
      })
      if (generation !== this.generation) {
        await tunnel.close()
        throw new Error("Remote Control was stopped")
      }
      this.tunnel = tunnel
      this.lastConnectedAt = new Date().toISOString()
      void tunnel.closed.then((error) => {
        if (this.tunnel !== tunnel) return
        this.tunnel = null
        this.error = error ?? "Remote Control tunnel stopped"
        this.enabled = false
        this.options.registry.cancelPairing()
        this.options.lease?.release()
        void this.ingress.stop()
        this.options.logger.warn({ err: error }, "Remote Control tunnel stopped")
      })
      this.options.logger.info({ url: tunnel.url }, "Remote Control connected")
      return tunnel
    } catch (error) {
      if (generation === this.generation) await this.ingress.stop()
      if (generation === this.generation && this.enabled) {
        this.enabled = false
        this.error = error instanceof Error ? error.message : String(error)
        this.options.lease?.release()
      }
      this.options.logger.warn({ err: error }, "Remote Control failed to start")
      throw error
    }
  }

  private async release(): Promise<void> {
    this.options.registry.cancelPairing()
    this.options.lease?.release()
    const tunnel = this.tunnel
    this.tunnel = null
    await Promise.allSettled([tunnel?.close(), this.ingress.stop()])
  }

  private pairingFor(tunnel: RemoteTunnel): RemoteControlPairing {
    return pairingFromCode(tunnel.url, this.options.registry.createPairing())
  }
}
