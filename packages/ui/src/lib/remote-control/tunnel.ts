import {
  createClientHandshake,
  decodeBase64,
  encodeBase64,
  REMOTE_CONTROL_MAX_HTTP_BODY_BYTES,
  type ClientToHostMessage,
  type EncryptedChannel,
  type HeaderEntries,
  type HostToClientMessage,
} from "@codenomad/remote-control-protocol"
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

interface RemoteControlBootstrap {
  tunnelPath: string
}

interface PendingHttp {
  resolve: (response: Response) => void
  reject: (error: Error) => void
  controller?: ReadableStreamDefaultController<Uint8Array>
  queued: Uint8Array[]
  ended: boolean
  timeout: ReturnType<typeof setTimeout>
  cleanup: () => void
}

interface PendingSocket {
  socket: TunnelWebSocket
  opening: Promise<void>
  transmission: Promise<void>
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

class RemoteControlTunnel implements RemoteSocketBridge {
  private socket: WebSocket | null = null
  private channel: EncryptedChannel | null = null
  private connection: Promise<void> | null = null
  private sendQueue = Promise.resolve()
  private receiveQueue = Promise.resolve()
  private readonly pendingHttp = new Map<string, PendingHttp>()
  private readonly pendingSockets = new Map<string, PendingSocket>()

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
    const bodyBytes = request.method === "GET" || request.method === "HEAD"
      ? new Uint8Array()
      : new Uint8Array(await request.arrayBuffer())
    if (bodyBytes.byteLength > REMOTE_CONTROL_MAX_HTTP_BODY_BYTES) return Response.json({ error: "Remote request body is too large" }, { status: 413 })

    await this.ensureConnected()
    const abort = () => {
      void this.send({ type: "http.cancel", id })
      this.failHttp(id, new DOMException("The operation was aborted", "AbortError"))
    }
    const response = new Promise<Response>((resolve, reject) => {
      const timeout = setTimeout(() => {
        void this.send({ type: "http.cancel", id })
        this.failHttp(id, new Error("Remote request timed out"))
      }, HTTP_IDLE_TIMEOUT_MS)
      this.pendingHttp.set(id, {
        resolve,
        reject,
        queued: [],
        ended: false,
        timeout,
        cleanup: () => request.signal.removeEventListener("abort", abort),
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
    const transmission = pending.transmission.then(async () => {
      const payload = await socketPayload(data)
      await this.send({ type: "socket.message", id: socket.id, data: encodeBase64(payload.bytes), binary: payload.binary })
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
      .catch(() => undefined)
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
      const receive = this.receiveQueue.then(async () => {
        if (this.socket !== socket || this.channel !== channel) return
        await this.receive(channel, new Uint8Array(event.data))
      })
      this.receiveQueue = receive.catch(() => {
        if (this.socket === socket) this.close(1008, "Encrypted Remote Control frame failed")
      })
    })
    socket.addEventListener("close", () => this.onSocketClosed(socket))
    socket.addEventListener("error", () => this.onSocketClosed(socket))
  }

  private send(message: ClientToHostMessage): Promise<void> {
    const plaintext = new TextEncoder().encode(JSON.stringify(message))
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
      socket.send(frame)
    })
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
    else if (message.type === "socket.message") this.pendingSockets.get(message.id)?.socket.receive(decodeBase64(message.data), message.binary)
    else if (message.type === "socket.error") this.failSocket(message.id)
    else if (message.type === "socket.close") this.finishSocket(message.id, message.code, message.reason)
  }

  private startHttp(message: Extract<HostToClientMessage, { type: "http.start" }>): void {
    const pending = this.pendingHttp.get(message.id)
    if (!pending) return
    this.refreshTimeout(message.id)
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        pending.controller = controller
        for (const chunk of pending.queued) controller.enqueue(chunk)
        pending.queued.length = 0
        if (pending.ended) controller.close()
      },
      cancel: () => {
        void this.send({ type: "http.cancel", id: message.id })
        clearTimeout(pending.timeout)
        pending.cleanup()
        this.pendingHttp.delete(message.id)
      },
    })
    pending.resolve(new Response(responseMustNotHaveBody(message.status) ? null : stream, {
      status: message.status,
      headers: message.headers,
    }))
  }

  private chunkHttp(id: string, chunk: Uint8Array): void {
    const pending = this.pendingHttp.get(id)
    if (!pending || pending.ended) return
    this.refreshTimeout(id)
    if (pending.controller) pending.controller.enqueue(chunk)
    else pending.queued.push(chunk)
  }

  private endHttp(id: string): void {
    const pending = this.pendingHttp.get(id)
    if (!pending) return
    clearTimeout(pending.timeout)
    pending.cleanup()
    pending.ended = true
    pending.controller?.close()
    this.pendingHttp.delete(id)
  }

  private failHttp(id: string, error: Error): void {
    const pending = this.pendingHttp.get(id)
    if (!pending) return
    clearTimeout(pending.timeout)
    pending.cleanup()
    pending.reject(error)
    pending.controller?.error(error)
    this.pendingHttp.delete(id)
  }

  private refreshTimeout(id: string): void {
    const pending = this.pendingHttp.get(id)
    if (!pending) return
    clearTimeout(pending.timeout)
    pending.timeout = setTimeout(() => {
      void this.send({ type: "http.cancel", id })
      this.failHttp(id, new Error("Remote response timed out"))
    }, HTTP_IDLE_TIMEOUT_MS)
  }

  private close(code?: number, reason?: string): void {
    const socket = this.socket
    this.socket = null
    this.channel = null
    if (socket && code && socket.readyState < WebSocket.CLOSING) socket.close(code, reason)
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

function responseMustNotHaveBody(status: number): boolean {
  return status === 204 || status === 205 || status === 304
}
