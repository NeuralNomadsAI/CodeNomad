import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

import { ExplicitEndpointError, normalizeExplicitOrigin } from "./origin"
export { ExplicitEndpointError, normalizeExplicitOrigin, type EndpointErrorCode } from "./origin"

/** A saved profile chooses its destination; only the resolver's IP syntax is checked here. */
export function admitAddress(address: string): { address: string; family: 4 | 6 } {
  const family = isIP(address)
  if (!family) throw new ExplicitEndpointError("dns")
  return { address, family: family as 4 | 6 }
}

export type ResolveAddresses = (hostname: string) => Promise<readonly { address: string; family: number }[]>
export const resolveAddresses: ResolveAddresses = hostname => lookup(hostname, { all: true, verbatim: true })

/** Validate every answer and return the exact address the dialer must use. */
export async function resolveExplicitAddress(origin: string, resolve: ResolveAddresses = resolveAddresses) {
  const url = new URL(normalizeExplicitOrigin(origin))
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  let answers: readonly { address: string; family: number }[]
  try { answers = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolve(hostname) }
  catch { throw new ExplicitEndpointError("dns") }
  if (!answers.length) throw new ExplicitEndpointError("dns")
  const admitted = answers.map(answer => admitAddress(answer.address))
  return admitted[0]!
}
