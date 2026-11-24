import { isIP } from "node:net"
import { formatHostForUrl, isLoopbackHost, isWildcardHost, normalizeNetworkHost } from "./network-host"

export interface StartedListenerBaseUrlInput {
  protocol: "http" | "https"
  bindHost: string
  port: number
}

export interface ResolvePluginBaseUrlInput {
  httpStart?: StartedListenerBaseUrlInput | null
  httpsStart?: StartedListenerBaseUrlInput | null
  remoteUrl?: string
}

export function resolvePreferredRemoteListener(
  input: Pick<ResolvePluginBaseUrlInput, "httpStart" | "httpsStart">,
): StartedListenerBaseUrlInput | null {
  return input.httpsStart ?? input.httpStart ?? null
}

export function resolvePluginBaseUrl(input: ResolvePluginBaseUrlInput): string {
  const loopbackListener = [input.httpStart, input.httpsStart].find((listener) => listener && acceptsLoopback(listener.bindHost))
  if (loopbackListener) {
    const bindHost = normalizeNetworkHost(loopbackListener.bindHost)
    const loopbackHost = isWildcardHost(bindHost)
      ? isIP(bindHost) === 6 ? "::1" : "127.0.0.1"
      : bindHost
    return `${loopbackListener.protocol}://${formatHostForUrl(loopbackHost)}:${loopbackListener.port}`
  }

  if (input.remoteUrl) {
    return input.remoteUrl
  }

  const fallbackListener = input.httpStart ?? input.httpsStart
  if (!fallbackListener) {
    throw new Error("No listeners started")
  }

  return `${fallbackListener.protocol}://${formatHostForUrl(fallbackListener.bindHost)}:${fallbackListener.port}`
}

/** Whether a listener bound to this host answers http://127.0.0.1, the only
 * address bridge registrations accept: IPv4 loopback or the IPv4 wildcard. An
 * IPv6 (even ::1 or a dual-stack ::), `localhost` or LAN binding is not proven to. */
export function acceptsIpv4Loopback(bindHost: string): boolean {
  const host = normalizeNetworkHost(bindHost)
  return host === "127.0.0.1" || host === "0.0.0.0"
}

export function resolveAutomationBridgeUrl(listener: StartedListenerBaseUrlInput): string {
  if (listener.protocol !== "http" || !acceptsIpv4Loopback(listener.bindHost)) {
    throw new Error("The local automation bridge requires an HTTP listener reachable on 127.0.0.1")
  }
  return `http://127.0.0.1:${listener.port}`
}

function acceptsLoopback(bindHost: string): boolean {
  return bindHost === "localhost" || isWildcardHost(bindHost) || isLoopbackHost(bindHost)
}
