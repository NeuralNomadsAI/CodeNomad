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
import { admitRemoteUpgrade, admitRemoteVoiceUpgrade, type RemoteGateDeps } from "./gate"
import { RemoteIngress } from "./ingress"
import type { RemoteControlOwnerLease } from "./owner-lease"
import { isLiveVoiceRoute, refuseVoiceUpgrade } from "../speech/live-voice-gateway"

type OpenTunnel = (options: OpenRemoteTunnelOptions) => Promise<RemoteTunnel>

interface ManagerOptions {
  registry: RemoteDeviceRegistry
  /** Routes a decrypted request into the CodeNomad HTTP application. */
  router: () => ((request: IncomingMessage, response: ServerResponse) => void) | null
  /** Proxies an admitted web preview WebSocket upgrade; false when no preview path matched. */
  previewUpgrade?: () => ((request: IncomingMessage, socket: Socket, head: Buffer) => boolean) | null
  voiceUpgrade?: () => ((request: IncomingMessage, socket: Socket, head: Buffer, deviceId: string) => void) | null
  /** Whether a web preview capability token is live. */
  hasPreview?: (token: string) => boolean
  logger: Logger
  /** Self-hosted OpenTunnel API; the hosted relay when omitted. */
  tunnelApi?: string
  openTunnel?: OpenTunnel
  /** Restricts resuming at launch to one backend per config directory. */
  lease?: RemoteControlOwnerLease
  /** Verified direct HTTPS origins (`direct-https.ts`) that pair and admit browser devices. */
  directHttpsOrigins?: () => readonly string[]
  /** Administrator policy: no tunnel, pairing or launch resume; paired devices stay revocable. */
  disabledByAdministrator?: boolean
}

export const REMOTE_CONTROL_DISABLED = "Remote Control is disabled by the administrator"

export class RemoteControlManager {
  private readonly ingress: RemoteIngress
  // Sockets of tunnel-authorized devices, including server devices on the direct listener.
  private readonly deviceSockets = new Map<Socket, Set<string>>()
  // Sockets of browser devices admitted on a verified direct HTTPS origin: independent of the tunnel.
  private readonly directDeviceSockets = new Map<Socket, Set<string>>()
  private tunnel: RemoteTunnel | null = null
  private starting: Promise<RemoteTunnel> | null = null
  // Incremented by every stop, so a start still provisioning cannot outlive it.
  private generation = 0
  private startingGeneration = -1
  private enabled = false
  private error: string | undefined
  private lastConnectedAt: string | undefined
  private readonly previewInvalidations = new Set<(deviceId?: string, tunnelOnly?: boolean) => void>()

  constructor(private readonly options: ManagerOptions) {
    this.ingress = new RemoteIngress((request, response) => {
      const route = options.router()
      if (route) route(request, response)
      else response.writeHead(503).end()
    }, (request, socket, head) => {
      if (isLiveVoiceRoute(request.url)) {
        const device = admitRemoteVoiceUpgrade(request, this.gate())
        const upgrade = options.voiceUpgrade?.()
        if (!device) refuseVoiceUpgrade(socket, "403 Forbidden")
        else if (!upgrade) refuseVoiceUpgrade(socket, "404 Not Found")
        else upgrade(request, socket, head, device.id)
        return "voice"
      }
      const upgrade = admitRemoteUpgrade(request, this.gate()) ? options.previewUpgrade?.() : null
      return upgrade?.(request, socket, head) ? "preview" : false
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
      ...(this.options.disabledByAdministrator ? { disabledByAdministrator: true } : {}),
      enabled: this.enabled,
      startsOnLaunch: !this.options.disabledByAdministrator && this.options.registry.startsOnLaunch(),
      previews: this.options.registry.previewsAllowed(),
      state,
      ...(tunnel ? { remoteUrl: tunnel.url } : {}),
      pairedDevices: this.options.registry.pairedCount(),
      ...(this.lastConnectedAt ? { lastConnectedAt: this.lastConnectedAt } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(this.directHttpsOrigins().length ? { directOrigins: this.directHttpsOrigins() } : {}),
    }
  }

  directHttpsOrigins(): string[] {
    return [...(this.options.directHttpsOrigins?.() ?? [])]
  }

  async start(): Promise<RemoteControlStartResponse> {
    if (this.options.disabledByAdministrator) throw new Error(REMOTE_CONTROL_DISABLED)
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
    if (this.options.disabledByAdministrator) {
      if (this.options.registry.startsOnLaunch()) this.options.logger.info(REMOTE_CONTROL_DISABLED + "; not resuming")
      return
    }
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

  exchangePairing(code: string, userAgent: string | undefined, serverHostName?: string): { device: RemoteControlDevice; token: string } | null {
    if (!this.enabled || !this.tunnel) return null
    const paired = this.options.registry.exchange(code, serverHostName === undefined ? deviceNameFromUserAgent(userAgent) : `CodeNomad · ${serverHostName}`)
    if (!paired) return null
    // A device replaced at the limit loses its live connections, as on revocation.
    if (paired.evictedId) this.disconnectDevice(paired.evictedId)
    return { device: paired.device, token: paired.token }
  }

  /** A code for one verified direct HTTPS origin; the tunnel need not run. */
  createDirectPairing(origin: string): RemoteControlPairing {
    if (this.options.disabledByAdministrator) throw new Error(REMOTE_CONTROL_DISABLED)
    if (!this.directHttpsOrigins().includes(origin)) throw new Error("This origin cannot pair devices")
    return pairingFromCode(origin, this.options.registry.createPairing(origin))
  }

  exchangeDirectPairing(code: string, origin: string, userAgent: string | undefined, serverHostName?: string): { device: RemoteControlDevice; token: string } | null {
    if (this.options.disabledByAdministrator) return null
    if (!this.directHttpsOrigins().includes(origin)) return null
    const paired = this.options.registry.exchange(code, serverHostName === undefined ? deviceNameFromUserAgent(userAgent) : `CodeNomad · ${serverHostName}`, origin)
    if (!paired) return null
    if (paired.evictedId) this.disconnectDevice(paired.evictedId)
    return { device: paired.device, token: paired.token }
  }

  devices(): RemoteControlDevice[] {
    return this.options.registry.list()
  }

  /**
   * A paired device remains a live principal only while it is not revoked or expired and
   * its channel is available: the connected tunnel, or its still-verified direct HTTPS origin.
   */
  isDeviceAuthorized(id: string): boolean {
    if (this.options.disabledByAdministrator) return false
    return this.enabled && this.tunnel !== null && this.options.registry.isPaired(id)
      || this.directHttpsOrigins().some((origin) => this.options.registry.isPaired(id, origin))
  }

  isPreviewDeviceAuthorized(id: string, host: string, ingress: boolean): boolean {
    if (this.options.disabledByAdministrator || !this.previewsAllowed()) return false
    if (ingress) return this.enabled && this.tunnel?.hostname === host && this.options.registry.isPaired(id)
    const origin = `https://${host}`
    return this.directHttpsOrigins().includes(origin) && this.options.registry.isPaired(id, origin)
  }

  onPreviewDeviceInvalidated(id: string, ingress: boolean, invalidate: () => void): () => void {
    const listener = (deviceId?: string, tunnelOnly?: boolean) => {
      if ((!tunnelOnly || ingress) && (deviceId === undefined || deviceId === id)) invalidate()
    }
    this.previewInvalidations.add(listener)
    return () => { this.previewInvalidations.delete(listener) }
  }

  private invalidatePreviews(deviceId?: string, tunnelOnly?: boolean) {
    for (const invalidate of this.previewInvalidations) {
      try { invalidate(deviceId, tunnelOnly) } catch { /* Continue notifying other owners. */ }
    }
  }

  revokeDevice(id: string): boolean {
    try {
      return this.options.registry.revoke(id)
    } finally {
      // In-memory revocation still applies if the registry cannot be saved.
      this.disconnectDevice(id)
    }
  }

  previewsAllowed(): boolean {
    return this.options.registry.previewsAllowed()
  }

  /** The host's choice; turning previews off also closes their live WebSockets. */
  setPreviewsAllowed(allowed: boolean): RemoteControlStatus {
    this.options.registry.setPreviewsAllowed(allowed)
    if (!allowed) {
      this.invalidatePreviews()
      this.ingress.disconnectPreviews()
    }
    return this.status()
  }

  gate(): RemoteGateDeps {
    return {
      publicHost: () => (this.enabled ? this.tunnel?.hostname ?? null : null),
      authenticate: (token) => this.enabled && this.tunnel ? this.options.registry.authenticate(token) : null,
      assignDevice: (socket, deviceId) => trackSocket(this.deviceSockets, socket, deviceId),
      servesPreview: (token) => this.options.registry.previewsAllowed() && this.options.hasPreview?.(token) === true,
      directHttpsOrigins: () => this.directHttpsOrigins(),
      authenticateDirect: (token, origin) => !this.options.disabledByAdministrator && this.directHttpsOrigins().includes(origin) ? this.options.registry.authenticate(token, origin) : null,
      assignDirectDevice: (socket, deviceId) => trackSocket(this.directDeviceSockets, socket, deviceId),
    }
  }

  shutdown(): Promise<void> {
    this.enabled = false
    this.invalidatePreviews()
    this.generation += 1
    for (const socket of this.directDeviceSockets.keys()) socket.destroy()
    this.directDeviceSockets.clear()
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
        this.disconnectDevices()
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
    this.disconnectDevices()
    await Promise.allSettled([tunnel?.close(), this.ingress.stop()])
  }

  private disconnectDevice(id: string): void {
    this.invalidatePreviews(id)
    for (const sockets of [this.deviceSockets, this.directDeviceSockets]) {
      for (const [socket, devices] of sockets) {
        if (devices.has(id)) socket.destroy()
      }
    }
  }

  private disconnectDevices(): void {
    this.invalidatePreviews(undefined, true)
    for (const socket of this.deviceSockets.keys()) socket.destroy()
    this.deviceSockets.clear()
  }

  private pairingFor(tunnel: RemoteTunnel): RemoteControlPairing {
    return pairingFromCode(tunnel.url, this.options.registry.createPairing())
  }
}

function trackSocket(sockets: Map<Socket, Set<string>>, socket: Socket, deviceId: string): void {
  let devices = sockets.get(socket)
  if (!devices) {
    devices = new Set()
    sockets.set(socket, devices)
    socket.once("close", () => sockets.delete(socket))
  }
  devices.add(deviceId)
}
