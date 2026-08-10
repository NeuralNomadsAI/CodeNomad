import { isIP } from "node:net"

export function stripHostBrackets(host: string): string {
  const trimmed = host.trim()
  return trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed
}

export function isWildcardHost(host: string): boolean {
  const value = stripHostBrackets(host).toLowerCase()
  if (value === "0.0.0.0") return true
  return isIP(value) === 6 && value.split(":").every((segment) => segment === "" || /^0+$/.test(segment))
}

export function isLoopbackHost(host: string): boolean {
  const value = stripHostBrackets(host).toLowerCase()
  if (value === "localhost") return true
  if (isIP(value) === 4) return value.startsWith("127.")
  if (isIP(value) !== 6) return false

  const mappedIpv4 = value.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  if (mappedIpv4) return isLoopbackHost(mappedIpv4)

  const segments = value.split(":")
  const last = segments.pop()
  return last === "1" && segments.every((segment) => segment === "" || /^0+$/.test(segment))
}

export function formatHostForUrl(host: string): string {
  const value = stripHostBrackets(host)
  return isIP(value) === 6 ? `[${value}]` : value
}
