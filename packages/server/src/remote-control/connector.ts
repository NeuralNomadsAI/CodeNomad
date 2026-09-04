import {
  REMOTE_CONTROL_HEARTBEAT_REQUEST,
  REMOTE_CONTROL_HEARTBEAT_RESPONSE,
  REMOTE_CONTROL_MAX_HANDSHAKE_BYTES,
  REMOTE_CONTROL_MAX_HTTP_BODY_BYTES,
  REMOTE_CONTROL_PROTOCOL_VERSION,
  createHostHandshake,
  decodeBase64,
  encodeBase64,
  type ClientToHostMessage,
  type EncryptedChannel,
  type HostToClientMessage,
  type HostToRelayMessage,
} from "@codenomad/remote-control-protocol"
import { Agent, fetch, WebSocket } from "undici"
import type { Logger } from "../logger"
import {
  ALLOWED_REMOTE_METHODS,
  allowedRemotePath,
  base64ByteLength,
  localHeaders,
  normalizedRelayUrl,
  parseClientMessage,
  parseRelayMessage,
  relaySocketUrl,
  responseHeaders,
  validCloseCode,
} from "./connector-protocol"

export { normalizedRelayUrl } from "./connector-protocol"

const INITIAL_RECONNECT_MS = 1_000
const MAX_RECONNECT_MS = 30_000
const MAX_ACTIVE_HTTP_REQUESTS = 32
const MAX_LOCAL_SOCKETS = 16
const MAX_QUEUED_SOCKET_MESSAGES = 64
const MAX_QUEUED_SOCKET_BYTES = 1024 * 1024
const RELAY_HANDSHAKE_TIMEOUT_MS = 15_000
const HEARTBEAT_INTERVAL_MS = 30_000
const HEARTBEAT_TIMEOUT_MS = 70_000

export type ConnectorState = "stopped" | "connecting" | "connected" | "reconnecting" | "error"

interface ConnectorOptions {
  relayUrl: string
  hostId: string
  secret: string
  encryptionPrivateKey: JsonWebKey
  localUrl: () => string
  localCookie: () => string
  logger: Logger
  onState: (state: ConnectorState, error?: string) => void
}

interface TunnelState {
  handshake: ReturnType<typeof createHostHandshake>
  channel?: EncryptedChannel
  receiveQueue: Promise<void>
  sendQueue: Promise<void>
  httpRequests: Map<string, AbortController>
  localSockets: Map<string, InstanceType<typeof WebSocket>>
  localSocketQueues: Map<string, Array<{ data: string; binary: boolean }>>
}

export class RemoteControlConnector {
  private socket: InstanceType<typeof WebSocket> | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private handshakeTimer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private lastHeartbeatAt = 0
  private ready = false
  private desired = false
  private reconnectDelay = INITIAL_RECONNECT_MS
  private readonly tunnels = new Map<string, TunnelState>()
  private readonly localDispatcher = new Agent({ connect: { rejectUnauthorized: false } })

  constructor(private readonly options: ConnectorOptions) {}

  start(): void {
    if (this.desired) return
    this.desired = true
    this.reconnectDelay = INITIAL_RECONNECT_MS
    this.connect("connecting")
  }

  stop(): void {
    this.desired = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = null
    this.stopHeartbeat()
    this.socket?.close(1000, "Remote Control stopped")
    this.socket = null
    this.ready = false
    this.closeAllTunnels()
    this.options.onState("stopped")
  }

  async shutdown(): Promise<void> {
    this.stop()
    await this.localDispatcher.close().catch(() => undefined)
  }

  isConnected(): boolean {
    return this.ready && this.socket?.readyState === WebSocket.OPEN
  }

  private connect(state: "connecting" | "reconnecting"): void {
    if (!this.desired || this.socket) return
    this.options.onState(state)
    const socket = new WebSocket(relaySocketUrl(this.options.relayUrl, this.options.hostId), {
      headers: { Authorization: `Bearer ${this.options.secret}` },
    })
    this.socket = socket
    this.ready = false
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return
      this.reconnectDelay = INITIAL_RECONNECT_MS
      this.sendRelay({ type: "ready", protocol: REMOTE_CONTROL_PROTOCOL_VERSION })
      this.handshakeTimer = setTimeout(() => socket.close(1002, "Remote Control relay handshake timed out"), RELAY_HANDSHAKE_TIMEOUT_MS)
      this.handshakeTimer.unref()
    })
    socket.addEventListener("message", (event) => this.onRelayMessage(socket, event.data))
    socket.addEventListener("close", () => this.onClosed(socket))
    socket.addEventListener("error", () => this.onClosed(socket, "Unable to connect to the Remote Control relay"))
  }

  private onClosed(socket: InstanceType<typeof WebSocket>, error?: string): void {
    if (this.socket !== socket) return
    this.socket = null
    this.ready = false
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = null
    this.stopHeartbeat()
    this.closeAllTunnels()
    if (!this.desired) {
      this.options.onState("stopped")
      return
    }
    this.options.onState(error ? "error" : "reconnecting", error)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(MAX_RECONNECT_MS, this.reconnectDelay * 2)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect("reconnecting")
    }, delay)
    this.reconnectTimer.unref()
  }

  private onRelayMessage(socket: InstanceType<typeof WebSocket>, data: unknown): void {
    if (this.socket !== socket) return
    const text = typeof data === "string" ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : ""
    if (!text) return
    if (text === REMOTE_CONTROL_HEARTBEAT_RESPONSE) {
      this.lastHeartbeatAt = Date.now()
      return
    }
    const message = parseRelayMessage(text)
    if (!message) {
      this.socket?.close(1003, "Invalid Remote Control relay message")
      return
    }
    if (message.type === "ready") {
      if (message.protocol !== REMOTE_CONTROL_PROTOCOL_VERSION) {
        this.socket?.close(1002, "Unsupported Remote Control protocol")
        return
      }
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
      this.ready = true
      this.startHeartbeat()
      this.options.onState("connected")
      return
    }
    if (!this.ready) {
      this.socket?.close(1002, "Remote Control relay handshake required")
      return
    }
    if (message.type === "tunnel.open") {
      this.openTunnel(message.id)
      return
    }
    if (message.type === "tunnel.close") {
      this.closeTunnel(message.id, message.code, message.reason)
      return
    }
    const tunnel = this.tunnels.get(message.id)
    if (!tunnel) return
    tunnel.receiveQueue = tunnel.receiveQueue
      .then(() => this.handleTunnelFrame(message.id, message.data, message.binary))
      .catch((error) => this.failTunnel(message.id, error))
  }

  private openTunnel(id: string): void {
    if (this.tunnels.has(id)) {
      this.failTunnel(id, new Error("Duplicate Remote Control tunnel"))
      return
    }
    this.tunnels.set(id, {
      handshake: createHostHandshake(this.options.encryptionPrivateKey),
      receiveQueue: Promise.resolve(),
      sendQueue: Promise.resolve(),
      httpRequests: new Map(),
      localSockets: new Map(),
      localSocketQueues: new Map(),
    })
  }

  private async handleTunnelFrame(tunnelId: string, encoded: string, binary: boolean): Promise<void> {
    const tunnel = this.tunnels.get(tunnelId)
    if (!tunnel) return
    const bytes = decodeBase64(encoded)
    if (!binary) {
      if (tunnel.channel) throw new Error("Plaintext received after Remote Control encryption was established")
      if (bytes.byteLength > REMOTE_CONTROL_MAX_HANDSHAKE_BYTES) throw new Error("Remote Control handshake is too large")
      const accepted = await (await tunnel.handshake).accept(new TextDecoder().decode(bytes))
      tunnel.channel = accepted.channel
      this.sendTunnelFrame(tunnelId, new TextEncoder().encode(accepted.ready), false)
      return
    }
    if (!tunnel.channel) throw new Error("Encrypted Remote Control frame arrived before its handshake")
    const plaintext = await tunnel.channel.decrypt(bytes)
    const message = parseClientMessage(new TextDecoder().decode(plaintext))
    if (!message) throw new Error("Invalid encrypted Remote Control message")
    if (message.type === "http.request") void this.handleHttp(tunnelId, tunnel, message).catch((error) => this.failTunnel(tunnelId, error))
    else if (message.type === "http.cancel") this.cancelHttp(tunnel, message.id)
    else if (message.type === "socket.open") this.openLocalSocket(tunnelId, tunnel, message)
    else if (message.type === "socket.message") this.forwardSocketMessage(tunnel, message)
    else if (message.type === "socket.close") this.closeLocalSocket(tunnel, message.id, message.code, message.reason)
  }

  private async handleHttp(tunnelId: string, tunnel: TunnelState, message: Extract<ClientToHostMessage, { type: "http.request" }>): Promise<void> {
    if (tunnel.httpRequests.has(message.id)) {
      await this.sendClient(tunnelId, { type: "http.error", id: message.id, message: "Duplicate remote request identifier" })
      return
    }
    if (tunnel.httpRequests.size >= MAX_ACTIVE_HTTP_REQUESTS) {
      await this.sendClient(tunnelId, { type: "http.error", id: message.id, message: "Too many active remote requests" })
      return
    }
    if (!ALLOWED_REMOTE_METHODS.has(message.method.toUpperCase())) {
      await this.sendClient(tunnelId, { type: "http.error", id: message.id, message: "Remote HTTP method is not allowed" })
      return
    }
    if (message.body && base64ByteLength(message.body) > REMOTE_CONTROL_MAX_HTTP_BODY_BYTES) {
      await this.sendClient(tunnelId, { type: "http.error", id: message.id, message: "Remote request body is too large" })
      return
    }
    const controller = new AbortController()
    tunnel.httpRequests.set(message.id, controller)
    try {
      const response = await fetch(this.localTarget(message.path), {
        method: message.method,
        headers: localHeaders(message.headers, this.options.localCookie()),
        body: message.body ? decodeBase64(message.body) : undefined,
        dispatcher: this.localDispatcher,
        signal: controller.signal,
        redirect: "manual",
      })
      await this.sendClient(tunnelId, {
        type: "http.start",
        id: message.id,
        status: response.status,
        headers: responseHeaders(response.headers),
      })
      if (response.body && message.method !== "HEAD") {
        const reader = response.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value.byteLength) await this.sendClient(tunnelId, { type: "http.chunk", id: message.id, data: encodeBase64(value) })
        }
      }
      await this.sendClient(tunnelId, { type: "http.end", id: message.id })
    } catch (error) {
      if (!controller.signal.aborted) {
        await this.sendClient(tunnelId, {
          type: "http.error",
          id: message.id,
          message: error instanceof Error ? error.message : "Local request failed",
        })
      }
    } finally {
      tunnel.httpRequests.delete(message.id)
    }
  }

  private cancelHttp(tunnel: TunnelState, id: string): void {
    tunnel.httpRequests.get(id)?.abort()
    tunnel.httpRequests.delete(id)
  }

  private openLocalSocket(tunnelId: string, tunnel: TunnelState, message: Extract<ClientToHostMessage, { type: "socket.open" }>): void {
    try {
      if (tunnel.localSockets.has(message.id)) throw new Error("Duplicate remote WebSocket identifier")
      if (tunnel.localSockets.size >= MAX_LOCAL_SOCKETS) throw new Error("Too many active remote WebSockets")
      const target = this.localTarget(message.path)
      target.protocol = target.protocol === "https:" ? "wss:" : "ws:"
      const socket = new WebSocket(target, {
        protocols: message.protocols,
        dispatcher: this.localDispatcher,
        headers: localHeaders(message.headers, this.options.localCookie()),
      })
      socket.binaryType = "arraybuffer"
      tunnel.localSockets.set(message.id, socket)
      tunnel.localSocketQueues.set(message.id, [])
      socket.addEventListener("open", () => {
        void this.sendClient(tunnelId, { type: "socket.ready", id: message.id, ...(socket.protocol ? { protocol: socket.protocol } : {}) })
        const queued = tunnel.localSocketQueues.get(message.id) ?? []
        tunnel.localSocketQueues.delete(message.id)
        for (const entry of queued) this.sendLocalSocket(socket, entry.data, entry.binary)
      })
      socket.addEventListener("message", (event) => {
        const binary = typeof event.data !== "string"
        const bytes = binary ? new Uint8Array(event.data as ArrayBuffer) : new TextEncoder().encode(event.data as string)
        void this.sendClient(tunnelId, { type: "socket.message", id: message.id, data: encodeBase64(bytes), binary })
      })
      socket.addEventListener("close", (event) => {
        tunnel.localSockets.delete(message.id)
        tunnel.localSocketQueues.delete(message.id)
        void this.sendClient(tunnelId, { type: "socket.close", id: message.id, code: event.code, reason: event.reason })
      })
      socket.addEventListener("error", () => {
        tunnel.localSockets.delete(message.id)
        tunnel.localSocketQueues.delete(message.id)
        void this.sendClient(tunnelId, { type: "socket.error", id: message.id, message: "Local WebSocket failed" })
      })
    } catch (error) {
      void this.sendClient(tunnelId, {
        type: "socket.error",
        id: message.id,
        message: error instanceof Error ? error.message : "Local WebSocket failed",
      })
    }
  }

  private forwardSocketMessage(tunnel: TunnelState, message: Extract<ClientToHostMessage, { type: "socket.message" }>): void {
    const socket = tunnel.localSockets.get(message.id)
    if (!socket) return
    if (socket.readyState === WebSocket.CONNECTING) {
      const queued = tunnel.localSocketQueues.get(message.id)
      const queuedBytes = queued?.reduce((total, entry) => total + base64ByteLength(entry.data), 0) ?? 0
      if (!queued || queued.length >= MAX_QUEUED_SOCKET_MESSAGES
        || queuedBytes + base64ByteLength(message.data) > MAX_QUEUED_SOCKET_BYTES) {
        this.closeLocalSocket(tunnel, message.id, 1009, "Too many queued Remote Control messages")
      } else queued.push({ data: message.data, binary: message.binary })
      return
    }
    if (socket.readyState === WebSocket.OPEN) this.sendLocalSocket(socket, message.data, message.binary)
  }

  private sendLocalSocket(socket: InstanceType<typeof WebSocket>, data: string, binary: boolean): void {
    const bytes = decodeBase64(data)
    socket.send(binary ? bytes : new TextDecoder().decode(bytes))
  }

  private closeLocalSocket(tunnel: TunnelState, id: string, code?: number, reason?: string): void {
    const socket = tunnel.localSockets.get(id)
    tunnel.localSockets.delete(id)
    tunnel.localSocketQueues.delete(id)
    socket?.close(validCloseCode(code) ? code : undefined, reason?.slice(0, 120))
  }

  private sendClient(tunnelId: string, message: HostToClientMessage): Promise<void> {
    const tunnel = this.tunnels.get(tunnelId)
    if (!tunnel?.channel) return Promise.resolve()
    const plaintext = new TextEncoder().encode(JSON.stringify(message))
    tunnel.sendQueue = tunnel.sendQueue.then(async () => {
      const channel = tunnel.channel
      if (!channel || this.tunnels.get(tunnelId) !== tunnel) return
      const frame = await channel.encrypt(plaintext)
      if (this.tunnels.get(tunnelId) !== tunnel) return
      this.sendTunnelFrame(tunnelId, frame, true)
    }).catch((error) => this.failTunnel(tunnelId, error))
    return tunnel.sendQueue
  }

  private sendTunnelFrame(tunnelId: string, bytes: Uint8Array, binary: boolean): void {
    this.sendRelay({ type: "tunnel.message", id: tunnelId, data: encodeBase64(bytes), binary })
  }

  private failTunnel(id: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : "Encrypted Remote Control tunnel failed"
    this.options.logger.warn({ err: error, tunnelId: id }, "Remote Control encrypted tunnel failed")
    this.sendRelay({ type: "tunnel.close", id, code: 1008, reason: reason.slice(0, 120) })
    this.closeTunnel(id, 1008, reason)
  }

  private closeTunnel(id: string, code?: number, reason?: string): void {
    const tunnel = this.tunnels.get(id)
    if (!tunnel) return
    this.tunnels.delete(id)
    for (const controller of tunnel.httpRequests.values()) controller.abort()
    for (const socket of tunnel.localSockets.values()) {
      socket.close(validCloseCode(code) ? code : undefined, reason?.slice(0, 120))
    }
    tunnel.httpRequests.clear()
    tunnel.localSockets.clear()
    tunnel.localSocketQueues.clear()
  }

  private closeAllTunnels(): void {
    for (const id of Array.from(this.tunnels.keys())) this.closeTunnel(id, 1012, "Remote Control reconnecting")
  }

  private sendRelay(message: HostToRelayMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.lastHeartbeatAt = Date.now()
    this.heartbeatTimer = setInterval(() => {
      const socket = this.socket
      if (!this.ready || socket?.readyState !== WebSocket.OPEN) return
      if (Date.now() - this.lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
        socket.close(1012, "Remote Control relay heartbeat timed out")
        this.onClosed(socket, "Remote Control relay stopped responding")
        return
      }
      socket.send(REMOTE_CONTROL_HEARTBEAT_REQUEST)
    }, HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    this.lastHeartbeatAt = 0
  }

  private localTarget(path: string): URL {
    if (!allowedRemotePath(path) || path.startsWith("//") || path.includes("\\")) throw new Error("Invalid remote request path")
    const base = new URL(this.options.localUrl())
    const target = new URL(path, base)
    if (target.origin !== base.origin || !allowedRemotePath(target.pathname)) throw new Error("Remote request escaped the local server")
    return target
  }
}
