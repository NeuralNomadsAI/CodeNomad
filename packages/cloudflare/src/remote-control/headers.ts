import type { HeaderEntries } from "@codenomad/remote-control-protocol"

const REQUEST_BLOCKLIST = new Set([
  "authorization",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "connection",
  "cookie",
  "host",
  "origin",
  "proxy-authorization",
  "proxy-connection",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-version",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-codenomad-relay-device-id",
  "x-codenomad-relay-operation",
])

const RESPONSE_BLOCKLIST = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "set-cookie",
  "transfer-encoding",
  "upgrade",
])

export function relayRequestHeaders(headers: Headers): HeaderEntries {
  const result: HeaderEntries = []
  headers.forEach((value, name) => {
    if (!REQUEST_BLOCKLIST.has(name.toLowerCase())) result.push([name, value])
  })
  return result
}

export function relayResponseHeaders(entries: HeaderEntries): Headers {
  const headers = new Headers()
  for (const [name, value] of entries) {
    if (!RESPONSE_BLOCKLIST.has(name.toLowerCase())) headers.append(name, value)
  }
  headers.set("Cache-Control", headers.get("Cache-Control") ?? "no-store")
  return headers
}
