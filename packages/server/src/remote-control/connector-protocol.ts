import type { ClientToHostMessage, HeaderEntries, RelayToHostMessage } from "@codenomad/remote-control-protocol"

const RESPONSE_HEADER_BLOCKLIST = new Set(["connection", "content-encoding", "content-length", "set-cookie", "transfer-encoding", "upgrade"])
const REQUEST_HEADER_BLOCKLIST = new Set([
  "authorization",
  "cf-connecting-ip",
  "client-ip",
  "connection",
  "content-length",
  "cookie",
  "forwarded",
  "host",
  "keep-alive",
  "origin",
  "proxy-authorization",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "true-client-ip",
  "upgrade",
  "via",
  "x-real-ip",
])

export const ALLOWED_REMOTE_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"])
const ALLOWED_REMOTE_PATH_PREFIXES = ["/api/", "/workspaces/"]
const MESSAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const PROTOCOL_PATTERN = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/
const MAX_PATH_CHARS = 8 * 1024
const MAX_HEADER_ENTRIES = 256
const MAX_HEADER_NAME_CHARS = 256
const MAX_HEADER_VALUE_BYTES = 16 * 1024
const MAX_HEADER_BYTES = 64 * 1024
const MAX_PROTOCOLS = 16
const MAX_PROTOCOL_CHARS = 128
const MAX_CLOSE_REASON_CHARS = 120

export function relaySocketUrl(relayUrl: string, hostId: string): URL {
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

export function allowedRemotePath(path: string): boolean {
  return ALLOWED_REMOTE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))
}

export function localHeaders(entries: HeaderEntries, cookie: string): Headers {
  const headers = new Headers()
  for (const [name, value] of entries) if (!blockedRequestHeader(name)) headers.append(name, value)
  headers.set("Cookie", cookie)
  headers.set("X-CodeNomad-Remote-Control", "1")
  return headers
}

export function responseHeaders(headers: Headers): HeaderEntries {
  const entries: HeaderEntries = []
  headers.forEach((value, name) => {
    if (!RESPONSE_HEADER_BLOCKLIST.has(name.toLowerCase())) entries.push([name, value])
  })
  return entries
}

export function parseRelayMessage(value: string): RelayToHostMessage | null {
  try {
    const message = JSON.parse(value) as Partial<RelayToHostMessage>
    if (message.type === "ready" && typeof message.protocol === "number") return message as RelayToHostMessage
    if (!validMessageId((message as { id?: unknown }).id)) return null
    if (message.type === "tunnel.open") return message as RelayToHostMessage
    if (message.type === "tunnel.close" && validCloseMetadata(message.code, message.reason)) return message as RelayToHostMessage
    if (message.type === "tunnel.message" && typeof message.data === "string" && typeof message.binary === "boolean") {
      return message as RelayToHostMessage
    }
    return null
  } catch {
    return null
  }
}

export function parseClientMessage(value: string): ClientToHostMessage | null {
  try {
    const message = JSON.parse(value) as Partial<ClientToHostMessage>
    if (!validMessageId(message.id) || typeof message.type !== "string") return null
    if (message.type === "http.cancel") return message as ClientToHostMessage
    if (message.type === "socket.close" && validClientCloseMetadata(message.code, message.reason)) return message as ClientToHostMessage
    if (message.type === "socket.message" && typeof message.data === "string" && typeof message.binary === "boolean") return message as ClientToHostMessage
    if (message.type === "http.request" && validMethod(message.method) && validPath(message.path) && validHeaders(message.headers)) {
      if (message.body !== undefined && typeof message.body !== "string") return null
      return message as ClientToHostMessage
    }
    if (message.type === "socket.open" && validPath(message.path) && validHeaders(message.headers) && validProtocols(message.protocols)) {
      return message as ClientToHostMessage
    }
    return null
  } catch {
    return null
  }
}

export function base64ByteLength(value: string): number {
  if (!value) return 0
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return Math.floor(value.length * 3 / 4) - padding
}

export function validCloseCode(value: number | undefined): value is number {
  return value === 1000 || (typeof value === "number" && Number.isSafeInteger(value) && value >= 3000 && value <= 4999)
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === "localhost" || normalized === "::1" || normalized === "[::1]" || normalized.startsWith("127.")
}

function validHeaders(value: unknown): value is HeaderEntries {
  if (!Array.isArray(value) || value.length > MAX_HEADER_ENTRIES) return false
  let bytes = 0
  return value.every((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) return false
    const [name, headerValue] = entry as unknown[]
    if (typeof name !== "string" || typeof headerValue !== "string"
      || !name || name.length > MAX_HEADER_NAME_CHARS || !HEADER_NAME_PATTERN.test(name)
      || /[\0\r\n]/.test(headerValue)) return false
    const valueBytes = new TextEncoder().encode(headerValue).byteLength
    if (valueBytes > MAX_HEADER_VALUE_BYTES) return false
    bytes += name.length + valueBytes
    return bytes <= MAX_HEADER_BYTES
  })
}

function blockedRequestHeader(name: string): boolean {
  const normalized = name.toLowerCase()
  return REQUEST_HEADER_BLOCKLIST.has(normalized)
    || normalized.startsWith("proxy-")
    || normalized.startsWith("sec-websocket-")
    || normalized.startsWith("x-codenomad-")
    || normalized.startsWith("x-forwarded-")
}

function validMessageId(value: unknown): value is string {
  return typeof value === "string" && MESSAGE_ID_PATTERN.test(value)
}

function validMethod(value: unknown): value is string {
  return typeof value === "string" && value.length <= 16 && /^[A-Za-z]+$/.test(value)
}

function validPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 1 && value.length <= MAX_PATH_CHARS && value.startsWith("/")
}

function validProtocols(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_PROTOCOLS
    && new Set(value).size === value.length
    && value.every((protocol) => typeof protocol === "string" && protocol.length <= MAX_PROTOCOL_CHARS && PROTOCOL_PATTERN.test(protocol))
}

function validClientCloseMetadata(code: unknown, reason: unknown): boolean {
  return (code === undefined || validCloseCode(typeof code === "number" ? code : undefined))
    && validCloseReason(reason)
}

function validCloseMetadata(code: unknown, reason: unknown): boolean {
  return (code === undefined || (typeof code === "number" && Number.isSafeInteger(code) && code >= 0 && code <= 0xffff))
    && validCloseReason(reason)
}

function validCloseReason(reason: unknown): boolean {
  return reason === undefined || (typeof reason === "string" && reason.length <= MAX_CLOSE_REASON_CHARS
    && new TextEncoder().encode(reason).byteLength <= 123 && !/[\0\r\n]/.test(reason))
}
