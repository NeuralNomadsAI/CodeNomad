import { isIP } from "node:net"
import { domainToASCII } from "node:url"

export function stripHostBrackets(host: string): string {
  const trimmed = host.trim()
  return trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed
}

export function normalizeNetworkHost(host: string): string {
  const value = stripHostBrackets(host).toLowerCase()
  if (isIP(value) === 6) {
    const canonical = canonicalIPv6(value)
    const mapped = canonical?.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (mapped) {
      const high = Number.parseInt(mapped[1], 16)
      const low = Number.parseInt(mapped[2], 16)
      return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
    }
  }
  if (isIP(value)) return value
  return domainToASCII(value) || value
}

export function hasIPv6Zone(host: string): boolean {
  const value = stripHostBrackets(host)
  return value.includes("%") && isIP(value) === 6
}

export function stripIPv6Zone(host: string): string {
  const value = stripHostBrackets(host)
  return hasIPv6Zone(value) ? value.slice(0, value.lastIndexOf("%")) : value
}

export function isWildcardHost(host: string): boolean {
  const value = normalizeNetworkHost(host)
  if (value === "0.0.0.0") return true
  return isIP(value) === 6 && value.split(":").every((segment) => segment === "" || /^0+$/.test(segment))
}

export function isLoopbackHost(host: string): boolean {
  const value = normalizeNetworkHost(host)
  if (value === "localhost") return true
  if (isIP(value) === 4) return value.startsWith("127.")
  if (isIP(value) !== 6) return false

  const segments = value.split(":")
  const last = segments.pop()
  return Boolean(last && /^0*1$/.test(last)) && segments.every((segment) => segment === "" || /^0+$/.test(segment))
}

export function formatHostForUrl(host: string): string {
  const value = normalizeNetworkHost(host)
  return isIP(value) === 6 ? `[${value}]` : value
}

function canonicalIPv6(value: string): string | null {
  if (hasIPv6Zone(value)) return null
  try {
    return new URL(`http://[${value}]`).hostname.slice(1, -1)
  } catch {
    return null
  }
}
