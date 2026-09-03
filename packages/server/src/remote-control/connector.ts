import {
  REMOTE_CONTROL_PROTOCOL_VERSION,
  decodeBase64,
  encodeBase64,
  type HeaderEntries,
  type HostToRelayMessage,
  type RelayToHostMessage,
} from "@codenomad/remote-control-protocol"
import { Agent, fetch, WebSocket } from "undici"
import type { Logger } from "../logger"

const INITIAL_RECONNECT_MS = 1_000
const MAX_RECONNECT_MS = 30_000
const MAX_QUEUED_SOCKET_MESSAGES = 256
const RELAY_HANDSHAKE_TIMEOUT_MS = 15_000
const RESPONSE_HEADER_BLOCKLIST = new Set(["connection", "content-encoding", "content-length", "set-cookie", "transfer-encoding", "upgrade"])
const REQUEST_HEADER_BLOCKLIST = new Set(["authorization", "connection", "cookie", "host", "proxy-authorization", "transfer-encoding", "upgrade"])

export type ConnectorState = "stopped" | "connecting" | "connected" | "reconnecting" | "error"

interface ConnectorOptions {
  relayUrl: string
  hostId: string
  secret: string
  localUrl: () => string
  localCookie: () => string
  logger: Logger
  onState: (state: ConnectorState, error?: string) => void
}

export class RemoteControlConnector {
  private socket: InstanceType<typeof WebSocket> | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private handshakeTimer: NodeJS.Timeout | null = null
  private ready = false
  private desired = false
  private reconnectDelay = INITIAL_RECONNECT_MS
  private readonly httpRequests = new Map<string, AbortController>()
  private readonly localSockets = new Map<string, InstanceType<typeof WebSocket>>()
  private readonly localSocketQueues = new Map<string, Array<{ data: string; binary: boolean }>>()
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
    this.socket?.close(1000, "Remote Control stopped")
    this.socket = null
    this.ready = false
    this.abortInflight()
    this.options.onState("stopped")
  }

  async shutdown(): Promise<void> {
    this.stop()
    await this.localDispatcher.close().catch(() => undefined)
  }

  isConnected(): boolean {
    return this.ready && this.socket?.readyState === WebSocket.OPEN
  }

  private connect(state: "connecting" | "reconnecting") {
    if (!this.desired || this.socket) return
    this.options.onState(state)
    const url = relaySocketUrl(this.options.relayUrl, this.options.hostId)
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.options.secret}` },
    })
    this.socket = socket
    this.ready = false
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return
      this.reconnectDelay = INITIAL_RECONNECT_MS
      this.send({ type: "ready", protocol: REMOTE_CONTROL_PROTOCOL_VERSION })
      this.handshakeTimer = setTimeout(() => socket.close(1002, "Remote Control relay handshake timed out"), RELAY_HANDSHAKE_TIMEOUT_MS)
      this.handshakeTimer.unref()
    })
    socket.addEventListener("message", (event) => void this.onMessage(event.data).catch((error) => {
      this.options.logger.warn({ err: error }, "Remote Control message failed")
    }))
    socket.addEventListener("close", () => this.onClosed(socket))
    socket.addEventListener("error", () => this.onClosed(socket, "Unable to connect to the Remote Control relay"))
  }

  private onClosed(socket: InstanceType<typeof WebSocket>, error?: string) {
    if (this.socket !== socket) return
    this.socket = null
    this.ready = false
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = null
    this.abortInflight()
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

  private async onMessage(data: unknown) {
    const text = typeof data === "string" ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : ""
    if (!text) return
    const message = JSON.parse(text) as RelayToHostMessage
    if (message.type === "ready") {
      if (message.protocol !== REMOTE_CONTROL_PROTOCOL_VERSION) {
        this.socket?.close(1002, "Unsupported Remote Control protocol")
        return
      }
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
      this.ready = true
      this.options.onState("connected")
      return
    }
    if (message.type === "ping") return this.send({ type: "pong", at: message.at })
    if (message.type === "http.request") return this.handleHttp(message)
    if (message.type === "http.cancel") return this.cancelHttp(message.id)
    if (message.type === "socket.open") return this.openSocket(message)
    if (message.type === "socket.message") return this.forwardSocketMessage(message)
    if (message.type === "socket.close") return this.closeSocket(message.id, message.code, message.reason)
  }

  private async handleHttp(message: Extract<RelayToHostMessage, { type: "http.request" }>) {
    const controller = new AbortController()
    this.httpRequests.set(message.id, controller)
    try {
      const target = this.localTarget(message.path)
      const headers = localHeaders(message.headers, this.options.localCookie())
      const response = await fetch(target, {
        method: message.method,
        headers,
        body: message.body ? decodeBase64(message.body) : undefined,
        dispatcher: this.localDispatcher,
        signal: controller.signal,
        redirect: "manual",
      })
      this.send({
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
          if (value.byteLength) this.send({ type: "http.chunk", id: message.id, data: encodeBase64(value) })
        }
      }
      this.send({ type: "http.end", id: message.id })
    } catch (error) {
      if (!controller.signal.aborted) {
        this.send({ type: "http.error", id: message.id, message: error instanceof Error ? error.message : "Local request failed" })
      }
    } finally {
      this.httpRequests.delete(message.id)
    }
  }

  private cancelHttp(id: string) {
    this.httpRequests.get(id)?.abort()
    this.httpRequests.delete(id)
  }

  private openSocket(message: Extract<RelayToHostMessage, { type: "socket.open" }>) {
    try {
      const target = this.localTarget(message.path)
      target.protocol = target.protocol === "https:" ? "wss:" : "ws:"
      const socket = new WebSocket(target, {
        protocols: message.protocols,
        dispatcher: this.localDispatcher,
        headers: localHeaders(message.headers, this.options.localCookie()),
      })
      socket.binaryType = "arraybuffer"
      this.localSockets.set(message.id, socket)
      this.localSocketQueues.set(message.id, [])
      socket.addEventListener("open", () => {
        this.send({ type: "socket.ready", id: message.id, ...(socket.protocol ? { protocol: socket.protocol } : {}) })
        const queued = this.localSocketQueues.get(message.id) ?? []
        this.localSocketQueues.delete(message.id)
        for (const entry of queued) this.sendLocalSocket(socket, entry.data, entry.binary)
      })
      socket.addEventListener("message", (event) => {
        const binary = typeof event.data !== "string"
        const bytes = binary ? new Uint8Array(event.data as ArrayBuffer) : new TextEncoder().encode(event.data as string)
        this.send({ type: "socket.message", id: message.id, data: encodeBase64(bytes), binary })
      })
      socket.addEventListener("close", (event) => {
        this.localSockets.delete(message.id)
        this.localSocketQueues.delete(message.id)
        this.send({ type: "socket.close", id: message.id, code: event.code, reason: event.reason })
      })
      socket.addEventListener("error", () => {
        this.localSockets.delete(message.id)
        this.localSocketQueues.delete(message.id)
        this.send({ type: "socket.error", id: message.id, message: "Local WebSocket failed" })
      })
    } catch (error) {
      this.send({ type: "socket.error", id: message.id, message: error instanceof Error ? error.message : "Local WebSocket failed" })
    }
  }

  private forwardSocketMessage(message: Extract<RelayToHostMessage, { type: "socket.message" }>) {
    const socket = this.localSockets.get(message.id)
    if (!socket) return
    if (socket.readyState === WebSocket.CONNECTING) {
      const queued = this.localSocketQueues.get(message.id)
      if (!queued || queued.length >= MAX_QUEUED_SOCKET_MESSAGES) {
        this.closeSocket(message.id, 1009, "Too many queued Remote Control messages")
        return
      }
      queued.push({ data: message.data, binary: message.binary })
      return
    }
    if (socket.readyState === WebSocket.OPEN) this.sendLocalSocket(socket, message.data, message.binary)
  }

  private sendLocalSocket(socket: InstanceType<typeof WebSocket>, data: string, binary: boolean) {
    const bytes = decodeBase64(data)
    socket.send(binary ? bytes : new TextDecoder().decode(bytes))
  }

  private closeSocket(id: string, code?: number, reason?: string) {
    const socket = this.localSockets.get(id)
    this.localSockets.delete(id)
    this.localSocketQueues.delete(id)
    socket?.close(code, reason)
  }

  private localTarget(path: string): URL {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid remote request path")
    const base = new URL(this.options.localUrl())
    const target = new URL(path, base)
    if (target.origin !== base.origin) throw new Error("Remote request escaped the local server")
    return target
  }

  private send(message: HostToRelayMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  private abortInflight() {
    for (const controller of this.httpRequests.values()) controller.abort()
    this.httpRequests.clear()
    for (const socket of this.localSockets.values()) socket.close(1012, "Remote Control reconnecting")
    this.localSockets.clear()
    this.localSocketQueues.clear()
  }
}

function relaySocketUrl(relayUrl: string, hostId: string): URL {
  const url = new URL(`/api/hosts/${hostId}/connect`, normalizedRelayUrl(relayUrl))
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url
}

export function normalizedRelayUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
    throw new Error("Remote Control relay must use HTTPS")
  }
  url.pathname = "/"
  url.search = ""
  url.hash = ""
  return url
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === "localhost" || normalized === "::1" || normalized === "[::1]" || normalized.startsWith("127.")
}

function localHeaders(entries: HeaderEntries, cookie: string): Headers {
  const headers = new Headers()
  for (const [name, value] of entries) {
    if (!REQUEST_HEADER_BLOCKLIST.has(name.toLowerCase())) headers.append(name, value)
  }
  headers.set("Cookie", cookie)
  headers.set("X-CodeNomad-Remote-Control", "1")
  return headers
}

function responseHeaders(headers: Headers): HeaderEntries {
  const entries: HeaderEntries = []
  headers.forEach((value, name) => {
    if (!RESPONSE_HEADER_BLOCKLIST.has(name.toLowerCase())) entries.push([name, value])
  })
  return entries
}
