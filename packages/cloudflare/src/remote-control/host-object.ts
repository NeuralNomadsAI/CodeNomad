import {
  REMOTE_CONTROL_PROTOCOL_VERSION,
  decodeBase64,
  encodeBase64,
  type HostToRelayMessage,
  type RelayToHostMessage,
} from "@codenomad/remote-control-protocol"
import { relayRequestHeaders, relayResponseHeaders } from "./headers"
import { bearerToken, clearDeviceCookie, cookieToken, deviceCookie, randomToken, tokenHash } from "./security"

const PAIRING_TTL_MS = 10 * 60_000
const DEVICE_TTL_MS = 30 * 24 * 60 * 60_000
const HOST_SECRET_KEY = "host-secret"
const PAIRING_PREFIX = "pair:"
const DEVICE_PREFIX = "device:"
const SOCKET_HANDSHAKE_TIMEOUT_MS = 15_000
const HTTP_RESPONSE_TIMEOUT_MS = 30_000
const MAX_QUEUED_SOCKET_MESSAGES = 256
const MAX_HTTP_REQUEST_BODY_BYTES = 20 * 1024 * 1024

interface PairingRecord {
  expiresAt: number
  connectionId: string
}

interface DeviceRecord {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number
  expiresAt: number
}

interface PendingHttp {
  resolve: (value: { status: number; headers: Headers; stream: ReadableStream<Uint8Array> }) => void
  reject: (reason: Error) => void
  controller?: ReadableStreamDefaultController<Uint8Array>
  queued: Uint8Array[]
  ended: boolean
  deviceId: string
  timeout: ReturnType<typeof setTimeout>
}

interface PendingSocket {
  client: WebSocket
  ready: boolean
  queued: Array<{ data: string; binary: boolean }>
  resolveReady: (protocol?: string) => void
  rejectReady: (error: Error) => void
  deviceId: string
}

export class RemoteControlHost implements DurableObject {
  private hostSocket: WebSocket | null = null
  private hostConnectionId: string | null = null
  private hostReady = false
  private readonly pendingHttp = new Map<string, PendingHttp>()
  private readonly pendingSockets = new Map<string, PendingSocket>()

  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const operation = request.headers.get("x-codenomad-relay-operation")

    if (operation === "host-connect") return this.connectHost(request)
    if (operation === "pair-create") return this.createPairing(request)
    if (operation === "pair-exchange") return this.exchangePairing(request)
    if (operation === "devices") return this.devices(request)
    if (operation === "device-revoke") return this.revokeDevice(request)
    if (operation === "proxy") return this.proxy(request)
    return Response.json({ error: "Unknown remote-control operation" }, { status: 404 })
  }

  private async connectHost(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "WebSocket required" }, { status: 426 })
    }
    if (!(await this.authorizeHost(request, true))) return Response.json({ error: "Unauthorized" }, { status: 401 })

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    server.accept()

    const previous = this.hostSocket
    if (previous) this.failPending("CodeNomad host reconnected")
    this.hostSocket = server
    this.hostConnectionId = crypto.randomUUID()
    this.hostReady = false
    previous?.close(1012, "Host reconnected")
    server.addEventListener("message", (event) => this.onHostMessage(server, event))
    server.addEventListener("close", () => this.onHostClosed(server))
    server.addEventListener("error", () => this.onHostClosed(server))

    return new Response(null, { status: 101, webSocket: client })
  }

  private async createPairing(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 })
    if (!(await this.authorizeHost(request))) return Response.json({ error: "Unauthorized" }, { status: 401 })
    if (!this.isHostConnected()) return Response.json({ error: "Host is offline" }, { status: 409 })

    const token = randomToken()
    const expiresAt = Date.now() + PAIRING_TTL_MS
    await this.state.storage.put(`${PAIRING_PREFIX}${await tokenHash(token)}`, {
      expiresAt,
      connectionId: this.hostConnectionId!,
    } satisfies PairingRecord)
    return Response.json({ token, expiresAt: new Date(expiresAt).toISOString() })
  }

  private async exchangePairing(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 })
    const input: { token?: unknown; name?: unknown } = await request
      .json<{ token?: unknown; name?: unknown }>()
      .catch(() => ({}))
    const token = typeof input.token === "string" ? input.token.trim() : ""
    if (!token) return Response.json({ error: "Pairing token required" }, { status: 400 })

    const key = `${PAIRING_PREFIX}${await tokenHash(token)}`
    const pairing = await this.state.storage.transaction(async (transaction) => {
      const record = await transaction.get<PairingRecord>(key)
      if (record) await transaction.delete(key)
      return record
    })
    if (!pairing || pairing.expiresAt <= Date.now() || !this.isHostConnected() || pairing.connectionId !== this.hostConnectionId) {
      return Response.json({ error: "Pairing link is invalid or expired" }, { status: 401 })
    }

    const deviceToken = randomToken()
    const now = Date.now()
    const device: DeviceRecord = {
      id: crypto.randomUUID(),
      name: typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 80) : "Remote device",
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + DEVICE_TTL_MS,
    }
    await this.state.storage.put(`${DEVICE_PREFIX}${await tokenHash(deviceToken)}`, device)
    return new Response(null, {
      status: 204,
      headers: { "Set-Cookie": deviceCookie(deviceToken, Math.floor(DEVICE_TTL_MS / 1000)) },
    })
  }

  private async devices(request: Request): Promise<Response> {
    if (!(await this.authorizeHost(request))) return Response.json({ error: "Unauthorized" }, { status: 401 })
    const records = await this.state.storage.list<DeviceRecord>({ prefix: DEVICE_PREFIX })
    const now = Date.now()
    const expired = Array.from(records.entries()).filter(([, device]) => device.expiresAt <= now).map(([key]) => key)
    if (expired.length) await this.state.storage.delete(expired)
    const devices = Array.from(records.values())
      .filter((device) => device.expiresAt > now)
      .map((device) => ({
        id: device.id,
        name: device.name,
        createdAt: new Date(device.createdAt).toISOString(),
        lastSeenAt: new Date(device.lastSeenAt).toISOString(),
      }))
    return Response.json({ devices })
  }

  private async revokeDevice(request: Request): Promise<Response> {
    if (request.method !== "DELETE") return new Response(null, { status: 405 })
    if (!(await this.authorizeHost(request))) return Response.json({ error: "Unauthorized" }, { status: 401 })
    const deviceId = request.headers.get("x-codenomad-relay-device-id")
    const records = await this.state.storage.list<DeviceRecord>({ prefix: DEVICE_PREFIX })
    const entry = Array.from(records.entries()).find(([, device]) => device.id === deviceId)
    if (entry) {
      await this.state.storage.delete(entry[0])
      for (const [id, pending] of this.pendingHttp) {
        if (pending.deviceId !== deviceId) continue
        this.sendHost({ type: "http.cancel", id })
        this.failHttp(id, new Error("Remote device was revoked"))
      }
      for (const [id, pending] of this.pendingSockets) {
        if (pending.deviceId === deviceId) this.closeSocket(id, "Remote device was revoked", 1008)
      }
    }
    return new Response(null, { status: 204 })
  }

  private async proxy(request: Request): Promise<Response> {
    const device = await this.authorizeDevice(request)
    if (!device) {
      return Response.json({ error: "Remote device is not paired" }, {
        status: 401,
        headers: { "Set-Cookie": clearDeviceCookie() },
      })
    }
    if (!this.isHostConnected()) return Response.json({ error: "CodeNomad host is offline" }, { status: 503 })
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return this.proxySocket(request, device.id)
    return this.proxyHttp(request, device.id)
  }

  private async proxyHttp(request: Request, deviceId: string): Promise<Response> {
    const id = crypto.randomUUID()
    let body: string | undefined
    if (request.method !== "GET" && request.method !== "HEAD") {
      const bytes = new Uint8Array(await request.arrayBuffer())
      if (bytes.byteLength > MAX_HTTP_REQUEST_BODY_BYTES) {
        return Response.json({ error: "Remote request body is too large" }, { status: 413 })
      }
      body = encodeBase64(bytes)
    }
    const message: RelayToHostMessage = {
      type: "http.request",
      id,
      method: request.method,
      path: remotePath(request),
      headers: relayRequestHeaders(request.headers),
      ...(body ? { body } : {}),
    }

    const response = new Promise<{ status: number; headers: Headers; stream: ReadableStream<Uint8Array> }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.sendHost({ type: "http.cancel", id })
        this.failHttp(id, new Error("CodeNomad host response timed out"))
      }, HTTP_RESPONSE_TIMEOUT_MS)
      this.pendingHttp.set(id, { resolve, reject, queued: [], ended: false, deviceId, timeout })
    })
    request.signal.addEventListener("abort", () => {
      this.sendHost({ type: "http.cancel", id })
      this.failHttp(id, new Error("Remote request cancelled"))
    }, { once: true })
    if (!this.sendHost(message)) this.failHttp(id, new Error("CodeNomad host disconnected"))

    try {
      const result = await response
      const body = request.method === "HEAD" || responseMustNotHaveBody(result.status) ? null : result.stream
      return new Response(body, {
        status: result.status,
        headers: result.headers,
      })
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Remote request failed" }, { status: 502 })
    }
  }

  private async proxySocket(request: Request, deviceId: string): Promise<Response> {
    const id = crypto.randomUUID()
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    server.accept()
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((value) => value.trim()).filter(Boolean)
    let resolveReady!: (protocol?: string) => void
    let rejectReady!: (error: Error) => void
    const ready = new Promise<string | undefined>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    this.pendingSockets.set(id, { client: server, ready: false, queued: [], resolveReady, rejectReady, deviceId })
    server.addEventListener("message", (event) => {
      const binary = typeof event.data !== "string"
      const bytes = binary ? new Uint8Array(event.data as ArrayBuffer) : new TextEncoder().encode(event.data as string)
      this.sendHost({ type: "socket.message", id, data: encodeBase64(bytes), binary })
    })
    server.addEventListener("close", (event) => {
      this.sendHost({ type: "socket.close", id, code: event.code, reason: event.reason })
      const pending = this.pendingSockets.get(id)
      if (pending && !pending.ready) pending.rejectReady(new Error("Remote WebSocket client disconnected"))
      this.pendingSockets.delete(id)
    })
    server.addEventListener("error", () => {
      this.sendHost({ type: "socket.close", id, code: 1011, reason: "Client socket failed" })
      const pending = this.pendingSockets.get(id)
      if (pending && !pending.ready) pending.rejectReady(new Error("Remote WebSocket client failed"))
      this.pendingSockets.delete(id)
    })
    const sent = this.sendHost({
      type: "socket.open",
      id,
      path: remotePath(request),
      headers: relayRequestHeaders(request.headers),
      protocols,
    })
    if (!sent) rejectReady(new Error("CodeNomad host disconnected"))
    const timeout = setTimeout(() => rejectReady(new Error("CodeNomad WebSocket handshake timed out")), SOCKET_HANDSHAKE_TIMEOUT_MS)
    try {
      const protocol = await ready
      const headers = protocol ? { "Sec-WebSocket-Protocol": protocol } : undefined
      return new Response(null, { status: 101, webSocket: client, headers })
    } catch (error) {
      this.pendingSockets.delete(id)
      server.close(1013, "CodeNomad host unavailable")
      this.sendHost({ type: "socket.close", id, code: 1013, reason: "Remote handshake cancelled" })
      return Response.json({ error: error instanceof Error ? error.message : "WebSocket handshake failed" }, { status: 502 })
    } finally {
      clearTimeout(timeout)
    }
  }

  private onHostMessage(socket: WebSocket, event: MessageEvent) {
    if (this.hostSocket !== socket) return
    if (typeof event.data !== "string") return
    let message: HostToRelayMessage
    try {
      message = JSON.parse(event.data) as HostToRelayMessage
    } catch {
      this.hostSocket?.close(1003, "Invalid relay message")
      return
    }

    if (message.type === "ready") {
      if (message.protocol !== REMOTE_CONTROL_PROTOCOL_VERSION) {
        this.hostSocket?.close(1002, "Unsupported protocol")
        return
      }
      this.hostReady = true
      this.sendHost({ type: "ready", protocol: REMOTE_CONTROL_PROTOCOL_VERSION })
      return
    }
    if (message.type === "http.start") return this.startHttp(message)
    if (message.type === "http.chunk") return this.chunkHttp(message.id, decodeBase64(message.data))
    if (message.type === "http.end") return this.endHttp(message.id)
    if (message.type === "http.error") return this.failHttp(message.id, new Error(message.message))
    if (message.type === "socket.ready") return this.readySocket(message.id, message.protocol)
    if (message.type === "socket.message") return this.messageSocket(message.id, message.data, message.binary)
    if (message.type === "socket.close") return this.closeSocket(message.id, message.reason)
    if (message.type === "socket.error") return this.closeSocket(message.id, message.message)
  }

  private startHttp(message: Extract<HostToRelayMessage, { type: "http.start" }>) {
    const pending = this.pendingHttp.get(message.id)
    if (!pending) return
    clearTimeout(pending.timeout)
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        pending.controller = controller
        for (const chunk of pending.queued) controller.enqueue(chunk)
        pending.queued.length = 0
        if (pending.ended) controller.close()
      },
      cancel: () => {
        this.sendHost({ type: "http.cancel", id: message.id })
        this.pendingHttp.delete(message.id)
      },
    })
    pending.resolve({ status: message.status, headers: relayResponseHeaders(message.headers), stream })
  }

  private chunkHttp(id: string, chunk: Uint8Array) {
    const pending = this.pendingHttp.get(id)
    if (!pending || pending.ended) return
    if (pending.controller) pending.controller.enqueue(chunk)
    else pending.queued.push(chunk)
  }

  private endHttp(id: string) {
    const pending = this.pendingHttp.get(id)
    if (!pending) return
    clearTimeout(pending.timeout)
    pending.ended = true
    pending.controller?.close()
    this.pendingHttp.delete(id)
  }

  private failHttp(id: string, error: Error) {
    const pending = this.pendingHttp.get(id)
    if (!pending) return
    clearTimeout(pending.timeout)
    pending.reject(error)
    pending.controller?.error(error)
    this.pendingHttp.delete(id)
  }

  private readySocket(id: string, protocol?: string) {
    const pending = this.pendingSockets.get(id)
    if (!pending) return
    pending.ready = true
    pending.resolveReady(protocol)
    for (const entry of pending.queued) this.sendSocket(pending.client, entry.data, entry.binary)
    pending.queued.length = 0
  }

  private messageSocket(id: string, data: string, binary: boolean) {
    const pending = this.pendingSockets.get(id)
    if (!pending) return
    if (!pending.ready && pending.queued.length >= MAX_QUEUED_SOCKET_MESSAGES) {
      this.closeSocket(id, "Too many queued CodeNomad messages", 1009)
    } else if (!pending.ready) pending.queued.push({ data, binary })
    else this.sendSocket(pending.client, data, binary)
  }

  private sendSocket(socket: WebSocket, data: string, binary: boolean) {
    const bytes = decodeBase64(data)
    socket.send(binary ? bytes.buffer : new TextDecoder().decode(bytes))
  }

  private closeSocket(id: string, reason?: string, code = 1011) {
    const pending = this.pendingSockets.get(id)
    if (!pending) return
    if (!pending.ready) pending.rejectReady(new Error(reason || "CodeNomad WebSocket handshake failed"))
    pending.client.close(code, reason?.slice(0, 120) || "Host socket closed")
    this.pendingSockets.delete(id)
  }

  private onHostClosed(socket: WebSocket) {
    if (this.hostSocket !== socket) return
    this.hostSocket = null
    this.hostConnectionId = null
    this.hostReady = false
    this.failPending("CodeNomad host disconnected")
  }

  private failPending(reason: string) {
    for (const id of this.pendingHttp.keys()) this.failHttp(id, new Error(reason))
    for (const id of this.pendingSockets.keys()) this.closeSocket(id, reason)
  }

  private isHostConnected(): boolean {
    return this.hostReady && this.hostSocket?.readyState === WebSocket.OPEN
  }

  private sendHost(message: RelayToHostMessage): boolean {
    if (!this.isHostConnected()) return false
    try {
      this.hostSocket!.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  private async authorizeHost(request: Request, allowRegistration = false): Promise<boolean> {
    const token = bearerToken(request)
    if (!token) return false
    const presented = await tokenHash(token)
    if (!allowRegistration) return await this.state.storage.get<string>(HOST_SECRET_KEY) === presented
    return this.state.storage.transaction(async (transaction) => {
      const stored = await transaction.get<string>(HOST_SECRET_KEY)
      if (stored) return stored === presented
      await transaction.put(HOST_SECRET_KEY, presented)
      return true
    })
  }

  private async authorizeDevice(request: Request): Promise<DeviceRecord | null> {
    const token = cookieToken(request)
    if (!token) return null
    const key = `${DEVICE_PREFIX}${await tokenHash(token)}`
    const device = await this.state.storage.get<DeviceRecord>(key)
    if (!device || device.expiresAt <= Date.now()) {
      await this.state.storage.delete(key)
      return null
    }
    if (Date.now() - device.lastSeenAt > 60_000) {
      device.lastSeenAt = Date.now()
      await this.state.storage.put(key, device)
    }
    return device
  }
}

function remotePath(request: Request): string {
  const url = new URL(request.url)
  return `${url.pathname}${url.search}`
}

function responseMustNotHaveBody(status: number): boolean {
  return status === 204 || status === 205 || status === 304
}
