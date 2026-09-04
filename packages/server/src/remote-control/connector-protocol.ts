import type { ClientToHostMessage, HeaderEntries, RelayToHostMessage } from "@codenomad/remote-control-protocol"

const RESPONSE_HEADER_BLOCKLIST = new Set(["connection", "content-encoding", "content-length", "set-cookie", "transfer-encoding", "upgrade"])
const REQUEST_HEADER_BLOCKLIST = new Set([
  "authorization",
  "connection",
  "cookie",
  "forwarded",
  "host",
  "origin",
  "proxy-authorization",
  "referer",
  "transfer-encoding",
  "upgrade",
])

export const ALLOWED_REMOTE_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"])
const ALLOWED_REMOTE_PATH_PREFIXES = ["/api/", "/workspaces/"]

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
    if (message.type === "tunnel.open" && typeof message.id === "string") return message as RelayToHostMessage
    if (message.type === "tunnel.close" && typeof message.id === "string") return message as RelayToHostMessage
    if (message.type === "tunnel.message" && typeof message.id === "string" && typeof message.data === "string" && typeof message.binary === "boolean") {
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
    if (typeof message.id !== "string" || !message.id || typeof message.type !== "string") return null
    if (message.type === "http.cancel") return message as ClientToHostMessage
    if (message.type === "socket.close") return message as ClientToHostMessage
    if (message.type === "socket.message" && typeof message.data === "string" && typeof message.binary === "boolean") return message as ClientToHostMessage
    if (message.type === "http.request" && typeof message.method === "string" && typeof message.path === "string" && validHeaders(message.headers)) {
      if (message.body !== undefined && typeof message.body !== "string") return null
      return message as ClientToHostMessage
    }
    if (message.type === "socket.open" && typeof message.path === "string" && validHeaders(message.headers) && Array.isArray(message.protocols)) {
      if (!message.protocols.every((protocol) => typeof protocol === "string")) return null
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
  return value === 1000 || (typeof value === "number" && value >= 3000 && value <= 4999)
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === "localhost" || normalized === "::1" || normalized === "[::1]" || normalized.startsWith("127.")
}

function validHeaders(value: unknown): value is HeaderEntries {
  return Array.isArray(value) && value.length <= 256
    && value.every((entry) => Array.isArray(entry) && entry.length === 2 && entry.every((item) => typeof item === "string"))
}

function blockedRequestHeader(name: string): boolean {
  const normalized = name.toLowerCase()
  return REQUEST_HEADER_BLOCKLIST.has(normalized)
    || normalized.startsWith("proxy-")
    || normalized.startsWith("sec-websocket-")
    || normalized.startsWith("x-codenomad-")
    || normalized.startsWith("x-forwarded-")
}
