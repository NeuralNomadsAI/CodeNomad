import os from "os"
import type { NetworkAddress } from "../api-types"

export function resolveNetworkAddresses(args: {
  host: string
  protocol: "http" | "https"
  port: number
}): NetworkAddress[] {
  const { host, protocol, port } = args
  const interfaces = os.networkInterfaces()
  const seen = new Set<string>()
  const results: NetworkAddress[] = []

  const addAddress = (ip: string, scope: NetworkAddress["scope"]) => {
    if (!ip || ip === "0.0.0.0") return
    const key = `ipv4-${ip}`
    if (seen.has(key)) return
    seen.add(key)
    results.push({ ip, family: "ipv4", scope, remoteUrl: `${protocol}://${ip}:${port}` })
  }

  const normalizeFamily = (value: string | number) => {
    if (typeof value === "string") {
      const lowered = value.toLowerCase()
      if (lowered === "ipv4") {
        return "ipv4" as const
      }
    }
    if (value === 4) return "ipv4" as const
    return null
  }

  if (host === "0.0.0.0") {
    // Enumerate system interfaces (IPv4 only)
    for (const entries of Object.values(interfaces)) {
      if (!entries) continue
      for (const entry of entries) {
        const family = normalizeFamily(entry.family)
        if (!family) continue
        if (!entry.address || entry.address === "0.0.0.0") continue
        const scope: NetworkAddress["scope"] = entry.internal ? "loopback" : "external"
        addAddress(entry.address, scope)
      }
    }
  }

  // Always include loopback address
  addAddress("127.0.0.1", "loopback")

  // Include explicitly configured host if it was IPv4
  if (isIPv4Address(host) && host !== "0.0.0.0") {
    const isLoopback = host.startsWith("127.")
    addAddress(host, isLoopback ? "loopback" : "external")
  }

  const scopeWeight: Record<NetworkAddress["scope"], number> = { external: 0, internal: 1, loopback: 2 }

  return results.sort((a, b) => {
    const scopeDelta = scopeWeight[a.scope] - scopeWeight[b.scope]
    if (scopeDelta !== 0) return scopeDelta

    const addressDelta = compareAddressPriority(a.ip, b.ip)
    if (addressDelta !== 0) return addressDelta

    return 0
  })
}

export function isAdvertisableRemoteAddress(address: Pick<NetworkAddress, "ip" | "scope">): boolean {
  if (address.scope !== "external") return false
  return !isLinkLocalIPv4(address.ip)
}

function compareAddressPriority(left: string, right: string): number {
  return getAddressPriority(left) - getAddressPriority(right)
}

function getAddressPriority(ip: string): number {
  const octets = parseIPv4(ip)
  if (!octets) return 100

  const [first, second] = octets

  if (isLinkLocalIPv4(ip)) return 90
  if (first === 172 && second >= 16 && second <= 31) return 10
  if (first === 10) return 10
  if (first === 192 && second === 168) return 10

  return 50
}

function isLinkLocalIPv4(ip: string): boolean {
  const octets = parseIPv4(ip)
  if (!octets) return false
  const [first, second] = octets
  return first === 169 && second === 254
}

function parseIPv4(value: string): number[] | null {
  if (!isIPv4Address(value)) return null
  return value.split(".").map((part) => Number(part))
}

function isIPv4Address(value: string | undefined): value is string {
  if (!value) return false
  const parts = value.split(".")
  if (parts.length !== 4) return false
  return parts.every((part) => {
    if (part.length === 0 || part.length > 3) return false
    if (!/^[0-9]+$/.test(part)) return false
    const num = Number(part)
    return Number.isInteger(num) && num >= 0 && num <= 255
  })
}
