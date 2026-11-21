import dns from "node:dns"
import { BlockList, isIP, type LookupFunction } from "node:net"
import os from "node:os"
import { buildConnector } from "undici"
import { isLoopbackHost, isWildcardHost, normalizeNetworkHost, stripHostBrackets } from "./network-host"

type ProxyListener = {
  address(): { address: string; port: number } | string | null
  once(event: "close", listener: () => void): unknown
}
const listeners = new Set<ProxyListener>()

/** Track actual bound sockets, including ephemeral ports and sibling HTTP/HTTPS listeners. */
export function guardProxyListener(server: ProxyListener): void {
  listeners.add(server)
  server.once("close", () => listeners.delete(server))
}

export class ProxyDestinationDenied extends Error {
  constructor() { super("Proxy destination is a host listener") }
}

export function targetsListener(address: string, port: number, bound: { address: string; port: number }): boolean {
  if (port !== bound.port) return false
  const target = normalizeNetworkHost(address)
  if (isWildcardHost(target)) return true
  const host = normalizeNetworkHost(bound.address)
  const addresses = new BlockList()
  const add = (ip: string) => addresses.addAddress(ip, isIP(ip) === 6 ? "ipv6" : "ipv4")
  if (isWildcardHost(host)) {
    if (host === "0.0.0.0" && isIP(target) !== 4) return false
    if (isLoopbackHost(target)) return true
    for (const entry of Object.values(os.networkInterfaces()).flat()) if (entry) add(entry.address)
  } else add(host)
  return addresses.check(target, isIP(target) === 6 ? "ipv6" : "ipv4")
}

/** Resolve once; native IPv4/IPv6 fallback uses only these checked answers. */
export async function proxyDestination(hostname: string, port: number): Promise<LookupFunction> {
  const host = stripHostBrackets(hostname)
  const resolved = isIP(host) ? [{ address: host, family: isIP(host) }] : await new Promise<dns.LookupAddress[]>((resolve, reject) => {
    dns.lookup(host, { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses))
  })
  if (!resolved.length) throw new Error("Proxy destination has no addresses")
  for (const { address } of resolved) {
    for (const server of listeners) {
      const bound = server.address()
      if (bound && typeof bound !== "string" && targetsListener(address, port, bound)) throw new ProxyDestinationDenied()
    }
  }
  return (_hostname, options, callback) => options.all
    ? callback(null, resolved)
    : callback(null, resolved[0].address, resolved[0].family)
}

export const proxyConnector: ReturnType<typeof buildConnector> = (options, callback) => {
  void proxyDestination(options.hostname, Number(options.port) || (options.protocol === "https:" ? 443 : 80)).then(
    lookup => buildConnector({ lookup })(options, callback),
    error => callback(error, null),
  )
}
