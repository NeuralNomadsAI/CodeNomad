import os from "os"
import { isIP } from "node:net"
import type { NetworkAddress } from "../api-types"
import { formatHostForUrl, isLoopbackHost, isWildcardHost, normalizeNetworkHost } from "./network-host"

export interface ResolvedRemoteAddresses {
  all: NetworkAddress[]
  userVisible: NetworkAddress[]
  primaryRemoteUrl?: string
}

export function resolveNetworkAddresses(args: {
  host: string
  protocol: "http" | "https"
  port: number
}): NetworkAddress[] {
  const { protocol, port } = args
  const host = normalizeNetworkHost(args.host)
  const interfaces = os.networkInterfaces()
  const seen = new Set<string>()
  const results: NetworkAddress[] = []

  const addAddress = (ip: string, scope: NetworkAddress["scope"]) => {
    const normalizedIp = normalizeNetworkHost(ip)
    const ipVersion = isIP(normalizedIp)
    if (!ipVersion || isWildcardHost(normalizedIp) || (ipVersion === 6 && isLinkLocalIPv6(normalizedIp))) return
    const family = ipVersion === 6 ? "ipv6" : "ipv4"
    const key = `${family}-${normalizedIp}`
    if (seen.has(key)) return
    seen.add(key)
    results.push({ ip: normalizedIp, family, scope, remoteUrl: `${protocol}://${formatHostForUrl(normalizedIp)}:${port}` })
  }

  if (isWildcardHost(host)) {
    const wildcardVersion = isIP(host)
    for (const entries of Object.values(interfaces)) {
      if (!entries) continue
      for (const entry of entries) {
        const entryVersion = isIP(normalizeNetworkHost(entry.address))
        if (entryVersion !== wildcardVersion && !(wildcardVersion === 6 && entryVersion === 4)) continue
        const scope: NetworkAddress["scope"] = entry.internal ? "loopback" : "external"
        addAddress(entry.address, scope)
      }
    }
  } else if (isIP(host)) {
    addAddress(host, isLoopbackHost(host) ? "loopback" : "external")
  }

  const scopeWeight: Record<NetworkAddress["scope"], number> = { external: 0, internal: 1, loopback: 2 }

  return results.sort((a, b) => {
    const scopeDelta = scopeWeight[a.scope] - scopeWeight[b.scope]
    if (scopeDelta !== 0) return scopeDelta

    return 0
  })
}

export function resolveRemoteAddresses(args: {
  host: string
  protocol: "http" | "https"
  port: number
}): ResolvedRemoteAddresses {
  const all = resolveNetworkAddresses(args)
  const userVisible = sortUserVisibleAddresses(all.filter((address) => address.scope === "external"))
  return {
    all,
    userVisible,
    primaryRemoteUrl: userVisible[0]?.remoteUrl,
  }
}

function sortUserVisibleAddresses(addresses: NetworkAddress[]): NetworkAddress[] {
  return [...addresses].sort((left, right) => getUserVisiblePriority(left.ip) - getUserVisiblePriority(right.ip))
}

function getUserVisiblePriority(ip: string): number {
  if (isPrivateIPv4(ip)) return 0
  if (isLinkLocalIPv4(ip)) return 2
  return 1
}

function isLinkLocalIPv4(ip: string): boolean {
  const octets = parseIPv4(ip)
  if (!octets) return false
  const [first, second] = octets
  return first === 169 && second === 254
}

function isPrivateIPv4(ip: string): boolean {
  const octets = parseIPv4(ip)
  if (!octets) return false
  const [first, second] = octets

  if (first === 10) return true
  if (first === 192 && second === 168) return true
  return first === 172 && second >= 16 && second <= 31
}

function parseIPv4(value: string): number[] | null {
  if (isIP(value) !== 4) return null
  return value.split(".").map((part) => Number(part))
}

function isLinkLocalIPv6(ip: string): boolean {
  const firstSegment = Number.parseInt(ip.split(":", 1)[0], 16)
  return Number.isInteger(firstSegment) && firstSegment >= 0xfe80 && firstSegment <= 0xfebf
}
