export type RemoteSocketData = string | ArrayBufferLike | ArrayBufferView | Blob

export interface RemoteSocketBridge {
  connectSocket(socket: TunnelWebSocket, url: URL, protocols: string[]): void
  transmitSocket(socket: TunnelWebSocket, data: RemoteSocketData): void
  disconnectSocket(socket: TunnelWebSocket, code?: number, reason?: string): void
}

type OpenHandler = ((event: Event) => unknown) | null
type MessageHandler = ((event: MessageEvent) => unknown) | null
type CloseHandler = ((event: CloseEvent) => unknown) | null

const MAX_PROTOCOLS = 16
const MAX_PROTOCOL_CHARS = 128

export class TunnelWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly CONNECTING = TunnelWebSocket.CONNECTING
  readonly OPEN = TunnelWebSocket.OPEN
  readonly CLOSING = TunnelWebSocket.CLOSING
  readonly CLOSED = TunnelWebSocket.CLOSED
  readonly id = crypto.randomUUID()
  readonly url: string
  readonly extensions = ""
  binaryType: BinaryType = "blob"
  private bufferedBytes = 0
  protocol = ""
  readyState = TunnelWebSocket.CONNECTING
  onopen: OpenHandler = null
  onmessage: MessageHandler = null
  onerror: OpenHandler = null
  onclose: CloseHandler = null

  get bufferedAmount(): number {
    return this.bufferedBytes
  }

  constructor(url: string | URL, protocols: string | string[] | undefined, private readonly bridge: RemoteSocketBridge) {
    super()
    const target = new URL(url, window.location.href)
    if (target.protocol === "http:") target.protocol = "ws:"
    else if (target.protocol === "https:") target.protocol = "wss:"
    if ((target.protocol !== "ws:" && target.protocol !== "wss:") || target.hash) {
      throw new DOMException("Invalid WebSocket URL", "SyntaxError")
    }
    this.url = target.toString()
    bridge.connectSocket(this, target, normalizeProtocols(protocols))
  }

  send(data: RemoteSocketData): void {
    if (this.readyState !== TunnelWebSocket.OPEN) throw new DOMException("WebSocket is not open", "InvalidStateError")
    this.bridge.transmitSocket(this, data)
  }

  close(code?: number, reason = ""): void {
    validateClose(code, reason)
    if (this.readyState === TunnelWebSocket.CLOSING || this.readyState === TunnelWebSocket.CLOSED) return
    this.readyState = TunnelWebSocket.CLOSING
    this.bridge.disconnectSocket(this, code, reason)
  }

  accept(protocol?: string): void {
    if (this.readyState !== TunnelWebSocket.CONNECTING) return
    this.protocol = protocol ?? ""
    this.readyState = TunnelWebSocket.OPEN
    const event = new Event("open")
    this.dispatchEvent(event)
    this.onopen?.(event)
  }

  buffer(byteLength: number): void {
    this.bufferedBytes += byteLength
  }

  flush(byteLength: number): void {
    this.bufferedBytes = Math.max(0, this.bufferedBytes - byteLength)
  }

  receive(data: Uint8Array, binary: boolean): void {
    if (this.readyState !== TunnelWebSocket.OPEN) return
    const payload = binary
      ? this.binaryType === "arraybuffer"
        ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        : new Blob([new Uint8Array(data).buffer])
      : new TextDecoder().decode(data)
    const event = new MessageEvent("message", { data: payload, origin: new URL(this.url).origin })
    this.dispatchEvent(event)
    this.onmessage?.(event)
  }

  fail(): void {
    if (this.readyState === TunnelWebSocket.CLOSED) return
    const event = new Event("error")
    this.dispatchEvent(event)
    this.onerror?.(event)
  }

  finish(code = 1005, reason = "", wasClean = true): void {
    if (this.readyState === TunnelWebSocket.CLOSED) return
    this.readyState = TunnelWebSocket.CLOSED
    this.bufferedBytes = 0
    const event = new CloseEvent("close", { code, reason, wasClean })
    this.dispatchEvent(event)
    this.onclose?.(event)
  }
}

export function tunnelAwareWebSocket(
  NativeWebSocket: typeof WebSocket,
  bridge: RemoteSocketBridge,
  shouldTunnel: (url: URL) => boolean,
): typeof WebSocket {
  return new Proxy(NativeWebSocket, {
    get(target, property, receiver) {
      if (property === Symbol.hasInstance) {
        return (value: unknown) => value instanceof TunnelWebSocket || value instanceof target
      }
      return Reflect.get(target, property, receiver)
    },
    construct(target, args, newTarget) {
      if (!args.length) return Reflect.construct(target, args, newTarget)
      const url = new URL(args[0] as string | URL, window.location.href)
      if (shouldTunnel(url)) return new TunnelWebSocket(url, args[1] as string | string[] | undefined, bridge)
      return Reflect.construct(target, args, newTarget)
    },
  })
}

function normalizeProtocols(value: string | string[] | undefined): string[] {
  const protocols = value === undefined ? [] : typeof value === "string" ? [value] : [...value]
  if (protocols.length > MAX_PROTOCOLS || new Set(protocols).size !== protocols.length
    || protocols.some((protocol) => typeof protocol !== "string" || protocol.length > MAX_PROTOCOL_CHARS
      || !/^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/.test(protocol))) {
    throw new DOMException("Invalid WebSocket protocol", "SyntaxError")
  }
  return protocols
}

function validateClose(code: number | undefined, reason: string): void {
  if (code !== undefined && (!Number.isInteger(code) || (code !== 1000 && (code < 3000 || code > 4999)))) {
    throw new DOMException("Invalid WebSocket close code", "InvalidAccessError")
  }
  if (new TextEncoder().encode(reason).byteLength > 123) {
    throw new DOMException("WebSocket close reason is too long", "SyntaxError")
  }
}
