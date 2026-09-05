import {
  clientWebSocketCloseCode,
  createClientHandshake,
  decodeBase64,
  encodeBase64,
  FrameBudget,
  REMOTE_CONTROL_MAX_HTTP_BODY_BYTES,
  REMOTE_CONTROL_MAX_SOCKET_MESSAGE_BYTES,
  type ClientToHostMessage,
  type EncryptedChannel,
  type HeaderEntries,
  type HostToClientMessage,
} from "@codenomad/remote-control-protocol"
import { readBoundedBody } from "./bounded-body"
import { TunnelEventSource } from "./event-source"
import {
  TunnelWebSocket,
  tunnelAwareWebSocket,
  type RemoteSocketBridge,
  type RemoteSocketData,
} from "./web-socket"

const HOST_KEY_STORAGE = "codenomad.remote-control.host-public-key"
const HTTP_IDLE_TIMEOUT_MS = 30_000
const FETCH_PATH_PREFIXES = ["/api/", "/workspaces/"]
const MAX_ACTIVE_HTTP_REQUESTS = 32
const MAX_PENDING_SOCKETS = 16
const MAX_PENDING_FRAMES = 128
const MAX_PENDING_FRAME_BYTES = 24 * 1024 * 1024
const MAX_BUFFERED_HTTP_CHUNKS = 512
const MAX_BUFFERED_HTTP_BYTES = 24 * 1024 * 1024
const SOCKET_CLOSE_TIMEOUT_MS = 10_000

interface RemoteControlBootstrap {
  tunnelPath: string
}

interface PendingHttp {
  resolve: (response: Response) => void
  reject: (error: Error) => void
  controller?: ReadableStreamDefaultController<Uint8Array>
  queued: Array<{ bytes: Uint8Array; release: () => void }>
  inFlightRelease?: () => void
  ended: boolean
  timeout: ReturnType<typeof setTimeout>
  cleanup: () => void
  releaseAdmission: () => void
  method: string
}

interface PendingSocket {
  socket: TunnelWebSocket
  opening: Promise<void>
  transmission: Promise<void>
  closeTimer?: ReturnType<typeof setTimeout>
}

export async function installRemoteControlTransport(): Promise<void> {
  const bootstrap = window.__CODENOMAD_REMOTE_CONTROL__ ?? await discoverRemoteControl()
  if (!bootstrap) return
  window.__CODENOMAD_REMOTE_CONTROL__ = bootstrap
  const hostPublicKey = loadHostPublicKey()
  const NativeWebSocket = window.WebSocket
  const tunnel = new RemoteControlTunnel(bootstrap, hostPublicKey, NativeWebSocket)
  const nativeFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input)
    if (url.origin === window.location.origin && FETCH_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
      return tunnel.fetch(input, init)
    }
    return nativeFetch(input, init)
  }) as typeof globalThis.fetch
  window.EventSource = TunnelEventSource as unknown as typeof EventSource
  window.WebSocket = tunnelAwareWebSocket(NativeWebSocket, tunnel, shouldTunnelUrl)
}

async function discoverRemoteControl(): Promise<RemoteControlBootstrap | null> {
  try {
    const response = await globalThis.fetch("/__codenomad/bootstrap", { credentials: "include", cache: "no-store" })
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return null
    const value = await response.json() as Partial<RemoteControlBootstrap>
    return typeof value.tunnelPath === "string" && value.tunnelPath.startsWith("/") && !value.tunnelPath.startsWith("//")
      ? { tunnelPath: value.tunnelPath }
      : null
  } catch {
    return null
  }
}

export class RemoteControlTunnel implements RemoteSocketBridge {
  private socket: WebSocket | null = null
  private channel: EncryptedChannel | null = null
  private connection: Promise<void> | null = null
  private sendQueue = Promise.resolve()
  private receiveQueue = Promise.resolve()
  private readonly sendBudget = new FrameBudget(MAX_PENDING_FRAMES, MAX_PENDING_FRAME_BYTES)
  private readonly receiveBudget = new FrameBudget(MAX_PENDING_FRAMES, MAX_PENDING_FRAME_BYTES)
  private readonly socketBudget = new FrameBudget(MAX_PENDING_FRAMES, MAX_PENDING_FRAME_BYTES)
  private readonly httpBufferBudget = new FrameBudget(MAX_BUFFERED_HTTP_CHUNKS, MAX_BUFFERED_HTTP_BYTES)
  private readonly pendingHttp = new Map<string, PendingHttp>()
  private readonly pendingSockets = new Map<string, PendingSocket>()
  private activeHttpRequests = 0

  constructor(
    private readonly bootstrap: RemoteControlBootstrap,
    private readonly hostPublicKey: JsonWebKey,
    private readonly NativeWebSocket: typeof WebSocket,
  ) {}

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const source = input instanceof Request ? input : new Request(requestUrl(input), init)
    const request = input instanceof Request && init ? new Request(input, init) : source
    const id = crypto.randomUUID()
    if (request.signal.aborted) throw new DOMException("The operation was aborted", "AbortError")
    if (this.activeHttpRequests >= MAX_ACTIVE_HTTP_REQUESTS) {
      return Response.json({ error: "Too many active remote requests" }, { status: 429 })
    }
    this.activeHttpRequests += 1
    let admissionActive = true
    const releaseAdmission = () => {
      if (!admissionActive) return
      admissionActive = false
      this.activeHttpRequests -= 1
    }
    let bodyBytes: Uint8Array | null
    try {
      bodyBytes = request.method === "GET" || request.method === "HEAD"
        ? new Uint8Array()
        : await readBoundedBody(request.body, REMOTE_CONTROL_MAX_HTTP_BODY_BYTES)
      if (request.signal.aborted) throw new DOMException("The operation was aborted", "AbortError")
      if (!bodyBytes) {
        releaseAdmission()
        return Response.json({ error: "Remote request body is too large" }, { status: 413 })
      }
      await this.ensureConnected()
    } catch (error) {
      releaseAdmission()
      throw error
    }
    const abort = () => {
      void this.send({ type: "http.cancel", id }).catch(() => undefined)
      this.failHttp(id, new DOMException("The operation was aborted", "AbortError"))
    }
    const response = new Promise<Response>((resolve, reject) => {
      const timeout = setTimeout(() => {
        void this.send({ type: "http.cancel", id }).catch(() => undefined)
        this.failHttp(id, new Error("Remote request timed out"))
      }, HTTP_IDLE_TIMEOUT_MS)
      this.pendingHttp.set(id, {
        resolve,
        reject,
        queued: [],
        ended: false,
        timeout,
        cleanup: () => request.signal.removeEventListener("abort", abort),
        releaseAdmission,
        method: request.method,
      })
    })
    request.signal.addEventListener("abort", abort, { once: true })
    if (request.signal.aborted) abort()
    if (request.signal.aborted) return response
    await this.send({
      type: "http.request",
      id,
      method: request.method,
      path: `${requestUrl(request).pathname}${requestUrl(request).search}`,
      headers: requestHeaders(request.headers),
      ...(bodyBytes.byteLength ? { body: encodeBase64(bodyBytes) } : {}),
    }).catch((error) => this.failHttp(id, error instanceof Error ? error : new Error("Remote request failed")))
    return response
  }

  connectSocket(socket: TunnelWebSocket, url: URL, protocols: string[]): void {
    if (this.pendingSockets.size >= MAX_PENDING_SOCKETS) {
      queueMicrotask(() => {
        socket.fail()
        socket.finish(1008, "Too many active remote WebSockets", false)
      })
      return
    }
    const opening = this.ensureConnected()
      .then(() => this.send({
        type: "socket.open",
        id: socket.id,
        path: `${url.pathname}${url.search}`,
        headers: [],
        protocols,
      }))
      .catch(() => this.failSocket(socket.id))
    this.pendingSockets.set(socket.id, { socket, opening, transmission: opening })
  }

  transmitSocket(socket: TunnelWebSocket, data: RemoteSocketData): void {
    const pending = this.pendingSockets.get(socket.id)
    if (!pending || pending.socket !== socket) return
    const byteLength = socketPayloadByteLength(data)
    if (byteLength > REMOTE_CONTROL_MAX_SOCKET_MESSAGE_BYTES) {
      this.failSocket(socket.id)
      return
    }
    const release = this.socketBudget.reserve(byteLength)
    if (!release) {
      this.failSocket(socket.id)
      return
    }
    socket.buffer(byteLength)
    const transmission = pending.transmission.then(async () => {
      const payload = await socketPayload(data)
      await this.send({ type: "socket.message", id: socket.id, data: encodeBase64(payload.bytes), binary: payload.binary })
    }).finally(() => {
      release()
      socket.flush(byteLength)
    })
    pending.transmission = transmission.catch(() => undefined)
    void transmission.catch(() => this.failSocket(socket.id))
  }

  disconnectSocket(socket: TunnelWebSocket, code?: number, reason?: string): void {
    const pending = this.pendingSockets.get(socket.id)
    if (!pending || pending.socket !== socket) {
      socket.finish(code, reason)
      return
    }
    void pending.transmission
      .then(() => this.send({ type: "socket.close", id: socket.id, code, reason }))
      .then(() => {
        if (this.pendingSockets.get(socket.id) !== pending) return
        pending.closeTimer = setTimeout(() => {
          pending.socket.fail()
          this.finishSocket(socket.id, 1006, "Remote WebSocket close timed out", false)
        }, SOCKET_CLOSE_TIMEOUT_MS)
      })
      .catch(() => {
        pending.socket.fail()
        this.finishSocket(socket.id, 1006, "Remote WebSocket close failed", false)
      })
  }

  private ensureConnected(): Promise<void> {
    if (this.channel && this.socket?.readyState === WebSocket.OPEN) return Promise.resolve()
    if (this.connection) return this.connection
    this.connection = this.connect().finally(() => {
      this.connection = null
    })
    return this.connection
  }

  private async connect(): Promise<void> {
    const handshake = await createClientHandshake(this.hostPublicKey)
    const url = new URL(this.bootstrap.tunnelPath, window.location.href)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    const socket = new this.NativeWebSocket(url)
    socket.binaryType = "arraybuffer"
    this.socket = socket
    this.channel = null
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Remote Control encryption handshake timed out")), 15_000)
        socket.addEventListener("open", () => socket.send(handshake.hello), { once: true })
        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string" || this.channel) return
          void handshake.accept(event.data).then((channel) => {
            clearTimeout(timeout)
            if (this.socket !== socket) return
            this.channel = channel
            resolve()
          }).catch(reject)
        })
        socket.addEventListener("close", () => {
          clearTimeout(timeout)
          reject(new Error("Remote Control tunnel closed during encryption handshake"))
        }, { once: true })
        socket.addEventListener("error", () => reject(new Error("Remote Control tunnel connection failed")), { once: true })
      })
    } catch (error) {
      if (this.socket === socket) {
        this.socket = null
        this.channel = null
      }
      if (socket.readyState < WebSocket.CLOSING) socket.close()
      throw error
    }
    this.sendQueue = Promise.resolve()
    this.receiveQueue = Promise.resolve()
    const channel = this.channel
    if (!channel) throw new Error("Remote Control encrypted channel is unavailable")
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || this.channel !== channel) return
      if (!(event.data instanceof ArrayBuffer)) {
        this.close(1002, "Plaintext received after encryption handshake")
        return
      }
      const frame = new Uint8Array(event.data)
      const release = this.receiveBudget.reserve(frame.byteLength)
      if (!release) {
        this.close(1009, "Remote Control receive queue exceeded its safety limit")
        return
      }
      const receive = this.receiveQueue.then(async () => {
        if (this.socket !== socket || this.channel !== channel) return
        await this.receive(channel, frame)
      }).finally(release)
      this.receiveQueue = receive.catch(() => {
        if (this.socket === socket) this.close(1008, "Encrypted Remote Control frame failed")
      })
    })
    socket.addEventListener("close", () => this.onSocketClosed(socket))
    socket.addEventListener("error", () => this.onSocketClosed(socket))
  }

  private send(message: ClientToHostMessage): Promise<void> {
    const plaintext = new TextEncoder().encode(JSON.stringify(message))
    const release = this.sendBudget.reserve(plaintext.byteLength)
    if (!release) {
      this.close(1009, "Remote Control send queue exceeded its safety limit")
      return Promise.reject(new Error("Remote Control send queue exceeded its safety limit"))
    }
    const socket = this.socket
    const channel = this.channel
    const send = this.sendQueue.then(async () => {
      if (!channel || !socket || this.channel !== channel || this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("Remote Control tunnel is disconnected")
      }
      const frame = await channel.encrypt(plaintext)
      if (this.channel !== channel || this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("Remote Control tunnel is disconnected")
      }
      if (socket.bufferedAmount + frame.byteLength > MAX_PENDING_FRAME_BYTES) {
        this.close(1009, "Remote Control network send buffer exceeded its safety limit")
        throw new Error("Remote Control network send buffer exceeded its safety limit")
      }
      socket.send(frame)
    }).finally(release)
    this.sendQueue = send.catch(() => undefined)
    return send
  }

  private async receive(channel: EncryptedChannel, frame: Uint8Array): Promise<void> {
    const message = parseHostMessage(new TextDecoder().decode(await channel.decrypt(frame)))
    if (!message) throw new Error("Invalid encrypted Remote Control response")
    if (message.type === "http.start") this.startHttp(message)
    else if (message.type === "http.chunk") this.chunkHttp(message.id, decodeBase64(message.data))
    else if (message.type === "http.end") this.endHttp(message.id)
    else if (message.type === "http.error") this.failHttp(message.id, new Error(message.message))
    else if (message.type === "socket.ready") this.pendingSockets.get(message.id)?.socket.accept(message.protocol)
    else if (message.type === "socket.message") {
      if (base64ByteLength(message.data) > REMOTE_CONTROL_MAX_SOCKET_MESSAGE_BYTES) {
        this.failSocket(message.id)
      } else this.pendingSockets.get(message.id)?.socket.receive(decodeBase64(message.data), message.binary)
    }
    else if (message.type === "socket.error") this.failSocket(message.id)
    else if (message.type === "socket.close") this.finishSocket(message.id, message.code, message.reason)
  }

  private startHttp(message: Extract<HostToClientMessage, { type: "http.start" }>): void {
    const pending = this.pendingHttp.get(message.id)
    if (!pending) return
    this.refreshTimeout(message.id)
    const bodyAllowed = pending.method !== "HEAD" && !responseMustNotHaveBody(message.status)
    const stream = bodyAllowed ? new ReadableStream<Uint8Array>({
      start: (controller) => {
        pending.controller = controller
        this.pumpHttp(message.id, pending)
      },
      pull: () => {
        pending.inFlightRelease?.()
        pending.inFlightRelease = undefined
        this.refreshTimeout(message.id)
        this.pumpHttp(message.id, pending)
      },
      cancel: () => {
        void this.send({ type: "http.cancel", id: message.id }).catch(() => undefined)
        this.releaseHttp(message.id, pending)
      },
    }, { highWaterMark: 1 }) : null
    pending.resolve(new Response(stream, {
      status: message.status,
      headers: message.headers,
    }))
  }

  private chunkHttp(id: string, chunk: Uint8Array): void {
    const pending = this.pendingHttp.get(id)
    if (!pending || pending.ended) return
    this.refreshTimeout(id)
    const release = this.httpBufferBudget.reserve(chunk.byteLength)
    if (!release) {
      void this.send({ type: "http.cancel", id }).catch(() => undefined)
      this.failHttp(id, new Error("Remote response buffer exceeded its safety limit"))
      return
    }
    pending.queued.push({ bytes: chunk, release })
    this.pumpHttp(id, pending)
  }

  private endHttp(id: string): void {
    const pending = this.pendingHttp.get(id)
    if (!pending) return
    pending.ended = true
    pending.releaseAdmission()
    this.refreshTimeout(id)
    this.pumpHttp(id, pending)
  }

  private failHttp(id: string, error: Error): void {
    const pending = this.pendingHttp.get(id)
    if (!pending) return
    pending.reject(error)
    pending.controller?.error(error)
    this.releaseHttp(id, pending)
  }

  private refreshTimeout(id: string): void {
    const pending = this.pendingHttp.get(id)
    if (!pending) return
    clearTimeout(pending.timeout)
    pending.timeout = setTimeout(() => {
      void this.send({ type: "http.cancel", id }).catch(() => undefined)
      this.failHttp(id, new Error("Remote response timed out"))
    }, HTTP_IDLE_TIMEOUT_MS)
  }

  private pumpHttp(id: string, pending: PendingHttp): void {
    if (this.pendingHttp.get(id) !== pending || pending.inFlightRelease) return
    if (!pending.controller) {
      if (pending.ended) this.releaseHttp(id, pending)
      return
    }
    const next = pending.queued.shift()
    if (next) {
      pending.inFlightRelease = next.release
      pending.controller.enqueue(next.bytes)
      return
    }
    if (!pending.ended) return
    pending.controller.close()
    this.releaseHttp(id, pending)
  }

  private releaseHttp(id: string, pending: PendingHttp): void {
    if (this.pendingHttp.get(id) !== pending) return
    clearTimeout(pending.timeout)
    pending.cleanup()
    pending.releaseAdmission()
    pending.inFlightRelease?.()
    for (const queued of pending.queued) queued.release()
    pending.queued.length = 0
    this.pendingHttp.delete(id)
  }

  private close(code?: number, reason?: string): void {
    const socket = this.socket
    this.socket = null
    this.channel = null
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(clientWebSocketCloseCode(code), reason)
    for (const id of Array.from(this.pendingHttp.keys())) this.failHttp(id, new Error("Remote Control tunnel disconnected"))
    for (const id of Array.from(this.pendingSockets.keys())) this.finishSocket(id, 1006, "Remote Control tunnel disconnected", false)
  }

  private onSocketClosed(socket: WebSocket): void {
    if (this.socket === socket) this.close()
  }

  private failSocket(id: string): void {
    const pending = this.pendingSockets.get(id)
    if (!pending) return
    pending.socket.fail()
    void this.send({ type: "socket.close", id, code: 1000, reason: "Remote WebSocket failed" }).catch(() => undefined)
    this.finishSocket(id, 1006, "Remote WebSocket failed", false)
  }

  private finishSocket(id: string, code?: number, reason?: string, wasClean = true): void {
    const pending = this.pendingSockets.get(id)
    if (!pending) return
    this.pendingSockets.delete(id)
    if (pending.closeTimer) clearTimeout(pending.closeTimer)
    pending.socket.finish(code, reason, wasClean)
  }
}

function loadHostPublicKey(): JsonWebKey {
  const raw = localStorage.getItem(HOST_KEY_STORAGE)
  if (!raw) throw new Error("Remote Control encryption identity is missing")
  const value = JSON.parse(raw) as JsonWebKey
  if (value.kty !== "EC" || value.crv !== "P-256" || typeof value.x !== "string" || typeof value.y !== "string") {
    throw new Error("Remote Control encryption identity is invalid")
  }
  return value
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof Request) return new URL(input.url)
  return new URL(input, window.location.href)
}

function shouldTunnelUrl(url: URL): boolean {
  const protocol = url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : url.protocol
  const comparable = new URL(url)
  comparable.protocol = protocol
  return comparable.origin === window.location.origin
    && FETCH_PATH_PREFIXES.some((prefix) => comparable.pathname.startsWith(prefix))
}

async function socketPayload(data: RemoteSocketData): Promise<{ bytes: Uint8Array; binary: boolean }> {
  if (typeof data === "string") return { bytes: new TextEncoder().encode(data), binary: false }
  if (data instanceof Blob) return { bytes: new Uint8Array(await data.arrayBuffer()), binary: true }
  if (ArrayBuffer.isView(data)) {
    return { bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), binary: true }
  }
  return { bytes: new Uint8Array(data), binary: true }
}

function socketPayloadByteLength(data: RemoteSocketData): number {
  if (typeof data === "string") return new TextEncoder().encode(data).byteLength
  if (data instanceof Blob) return data.size
  return data.byteLength
}

function requestHeaders(headers: Headers): HeaderEntries {
  const result: HeaderEntries = []
  headers.forEach((value, name) => result.push([name, value]))
  return result
}

function parseHostMessage(value: string): HostToClientMessage | null {
  try {
    const message = JSON.parse(value) as Partial<HostToClientMessage>
    if (typeof message.id !== "string" || typeof message.type !== "string") return null
    if (message.type === "http.end") return message as HostToClientMessage
    if (message.type === "http.chunk" && typeof message.data === "string") return message as HostToClientMessage
    if (message.type === "http.error" && typeof message.message === "string") return message as HostToClientMessage
    if (message.type === "http.start" && typeof message.status === "number" && Array.isArray(message.headers)) return message as HostToClientMessage
    if (message.type === "socket.ready" || message.type === "socket.close") return message as HostToClientMessage
    if (message.type === "socket.message" && typeof message.data === "string" && typeof message.binary === "boolean") return message as HostToClientMessage
    if (message.type === "socket.error" && typeof message.message === "string") return message as HostToClientMessage
    return null
  } catch {
    return null
  }
}

function base64ByteLength(value: string): number {
  if (!value) return 0
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return Math.floor(value.length * 3 / 4) - padding
}

function responseMustNotHaveBody(status: number): boolean {
  return status === 204 || status === 205 || status === 304
}
