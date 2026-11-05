import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

import { admitAddress, ExplicitEndpointError, normalizeExplicitOrigin } from "./origin"
export { admitAddress, ExplicitEndpointError, normalizeExplicitOrigin, type EndpointErrorCode } from "./origin"

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
  if (url.protocol === "http:" && admitted.some(answer => !answer.loopback)) throw new ExplicitEndpointError("https_required")
  return admitted[0]!
}
