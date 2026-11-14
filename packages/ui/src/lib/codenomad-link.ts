import { splitPairingLink } from "./remote-pairing-link"

export type CodeNomadLink =
  | { kind: "pairing"; baseUrl: string; entryUrl: string }
  | { kind: "address"; baseUrl: string }

export const carriesCredentials = (value: string) => /^[a-z][a-z\d+.-]*:\/\/[^/?#]*@/i.test(value.trim())

export function classifyCodeNomadLink(input: string): CodeNomadLink | null {
  const text = input.trim()
  let url: URL
  try { url = new URL(text) } catch { return null }
  // Validate the raw URL before splitPairingLink discards userinfo.
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || carriesCredentials(text)) return null
  const pairing = splitPairingLink(text)
  if (pairing) return { kind: "pairing", ...pairing }
  if (url.hash || url.pathname === "/remote-pair") return null
  return { kind: "address", baseUrl: url.origin }
}

export function codeNomadLinkName(baseUrl: string): string {
  try { return new URL(baseUrl).host } catch { return baseUrl }
}

type ServerNaming = { id?: string; name: string; baseUrl: string }
const hostnameOf = (baseUrl: string) => { try { return new URL(baseUrl).hostname } catch { return undefined } }

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
