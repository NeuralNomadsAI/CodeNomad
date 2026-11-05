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

/** A server's display name before it reports one: its host. */
export function codeNomadLinkName(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}
