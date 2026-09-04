import type {
  RemoteControlDevice,
  RemoteControlPairing,
  RemoteControlStartResponse,
  RemoteControlStatus,
} from "@codenomad/remote-control-protocol"
import { encodeBase64, REMOTE_CONTROL_PROTOCOL_VERSION } from "@codenomad/remote-control-protocol"
import { fetch } from "undici"
import type { Logger } from "../logger"
import { RemoteControlConnector, normalizedRelayUrl, type ConnectorState } from "./connector"
import type { RemoteControlIdentity } from "./identity"

interface ManagerOptions {
  identity: RemoteControlIdentity
  relayUrl: string
  localUrl: () => string
  localCookie: () => string
  logger: Logger
}

export class RemoteControlManager {
  private state: ConnectorState = "stopped"
  private error: string | undefined
  private lastConnectedAt: string | undefined
  private enabled = false
  private pairedDevices = 0
  private readonly connector: RemoteControlConnector

  constructor(private readonly options: ManagerOptions) {
    normalizedRelayUrl(options.relayUrl)
    this.connector = new RemoteControlConnector({
      relayUrl: options.relayUrl,
      hostId: options.identity.hostId,
      secret: options.identity.secret,
      encryptionPrivateKey: options.identity.encryptionPrivateKey,
      localUrl: options.localUrl,
      localCookie: options.localCookie,
      logger: options.logger,
      onState: (state, error) => {
        this.state = state
        this.error = error
        if (state === "connected") this.lastConnectedAt = new Date().toISOString()
      },
    })
  }

  status(): RemoteControlStatus {
    const relay = normalizedRelayUrl(this.options.relayUrl)
    return {
      manageable: true,
      enabled: this.enabled,
      state: this.state,
      hostId: this.options.identity.hostId,
      relayUrl: relay.origin,
      remoteUrl: remoteOrigin(relay, this.options.identity.hostId),
      pairedDevices: this.pairedDevices,
      ...(this.lastConnectedAt ? { lastConnectedAt: this.lastConnectedAt } : {}),
      ...(this.error ? { error: this.error } : {}),
    }
  }

  async start(): Promise<RemoteControlStartResponse> {
    this.enabled = true
    this.connector.start()
    await this.waitForConnection()
    const pairing = await this.createPairing()
    return { status: this.status(), pairing }
  }

  stop(): RemoteControlStatus {
    this.enabled = false
    this.connector.stop()
    return this.status()
  }

  async createPairing(): Promise<RemoteControlPairing> {
    if (!this.connector.isConnected()) throw new Error("Remote Control is not connected")
    const relay = normalizedRelayUrl(this.options.relayUrl)
    const response = await fetch(new URL(`/api/hosts/${this.options.identity.hostId}/pair`, relay), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.options.identity.secret}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(await relayError(response, "Could not create a pairing link"))
    const payload = await response.json() as { token?: unknown; expiresAt?: unknown }
    if (typeof payload.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(payload.token)
      || typeof payload.expiresAt !== "string" || !Number.isFinite(Date.parse(payload.expiresAt))) {
      throw new Error("Relay returned an invalid pairing link")
    }
    const origin = remoteOrigin(relay, this.options.identity.hostId)
    const pairingFragment = encodeBase64(new TextEncoder().encode(JSON.stringify({
      protocol: REMOTE_CONTROL_PROTOCOL_VERSION,
      token: payload.token,
      hostPublicKey: this.options.identity.encryptionPublicKey,
    })))
    return { url: `${origin}/__codenomad/pair#${encodeURIComponent(pairingFragment)}`, expiresAt: payload.expiresAt }
  }

  async devices(): Promise<RemoteControlDevice[]> {
    const response = await this.hostRequest("devices")
    const payload = await response.json() as { devices?: unknown }
    const devices = Array.isArray(payload.devices) ? payload.devices as RemoteControlDevice[] : []
    this.pairedDevices = devices.length
    return devices
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const response = await this.hostRequest(`devices/${encodeURIComponent(deviceId)}`, "DELETE")
    if (!response.ok) throw new Error(await relayError(response, "Could not revoke the remote device"))
    this.pairedDevices = Math.max(0, this.pairedDevices - 1)
  }

  shutdown(): Promise<void> {
    this.enabled = false
    return this.connector.shutdown()
  }

  private async hostRequest(path: string, method = "GET") {
    const relay = normalizedRelayUrl(this.options.relayUrl)
    const response = await fetch(new URL(`/api/hosts/${this.options.identity.hostId}/${path}`, relay), {
      method,
      headers: { Authorization: `Bearer ${this.options.identity.secret}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(await relayError(response, "Remote Control relay request failed"))
    return response
  }

  private waitForConnection(timeoutMs = 10_000): Promise<void> {
    if (this.connector.isConnected()) return Promise.resolve()
    const started = Date.now()
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (this.connector.isConnected()) {
          clearInterval(timer)
          resolve()
        } else if (Date.now() - started >= timeoutMs) {
          clearInterval(timer)
          reject(new Error(this.error ?? "Timed out connecting to the Remote Control relay"))
        }
      }, 50)
      timer.unref()
    })
  }
}

function remoteOrigin(relay: URL, hostId: string): string {
  return `${relay.protocol}//${hostId}.${relay.host}`
}

async function relayError(response: { json: () => Promise<unknown>; status: number }, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: unknown } | null
  return typeof payload?.error === "string" ? payload.error : `${fallback} (HTTP ${response.status})`
}
