import { splitPairingLink } from "./remote-pairing-link"

/**
 * A pasted CodeNomad link: a Remote Control pairing link, or a server address
 * (direct access) for the existing probe. Links carrying credentials are refused:
 * nothing secret is ever saved with a server.
 */
export type CodeNomadLink =
  | { kind: "pairing"; baseUrl: string; entryUrl: string }
  | { kind: "address"; baseUrl: string }

export function classifyCodeNomadLink(input: string): CodeNomadLink | null {
  const text = input.trim()
  const pairing = splitPairingLink(text)
  if (pairing) return { kind: "pairing", ...pairing }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null
  return { kind: "address", baseUrl: url.origin }
}

/** A newly added server is saved under its host; `serverDisplayName` shows it as its host name. */
export function codeNomadLinkName(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

type ServerNaming = { id?: string; name: string; baseUrl: string }

const hostnameOf = (baseUrl: string) => { try { return new URL(baseUrl).hostname } catch { return undefined } }

/**
 * A saved server as people read it: its saved name, else its host name, never
 * a raw address. The port stays only to tell apart servers on the same host.
 */
export function serverDisplayName(profile: ServerNaming, servers: readonly ServerNaming[] = []): string {
  const name = profile.name.trim()
  try {
    const url = new URL(profile.baseUrl)
    const raw = [url.host, url.origin, url.href, profile.baseUrl.trim()]
    if (!name || raw.includes(name.replace(/\/+$/, ""))) {
      const shared = servers.some((other) => other !== profile && (other.id === undefined || other.id !== profile.id)
        && other.baseUrl !== profile.baseUrl && hostnameOf(other.baseUrl) === url.hostname)
      return shared ? url.host : url.hostname
    }
  } catch {}
  return name || profile.baseUrl
}
