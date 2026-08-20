import { isIP } from "node:net"

export function assertLoopbackServiceUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported OpenCode service protocol: ${url.protocol}`)
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  const ipVersion = isIP(hostname)
  const loopback = hostname === "localhost"
    || (ipVersion === 4 && hostname.startsWith("127."))
    || (ipVersion === 6 && (hostname === "::1" || hostname.startsWith("::ffff:127.")))
  if (!loopback) throw new Error(`OpenCode service endpoint must be loopback: ${url.hostname}`)
  return url
}
