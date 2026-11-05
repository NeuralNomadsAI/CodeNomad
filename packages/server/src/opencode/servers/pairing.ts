import { boundedResponseFetch } from "../bounded-response-fetch"
import { ExplicitEndpointError, normalizeExplicitOrigin, type ResolveAddresses } from "./endpoint"
import { createExplicitTransport } from "./transport"
import { SERVER_CONNECTION_LIMITS } from "./types"

// prototype-1236: `opencode pair` / `opencode pair --remote` print `<origin>/auth/connect/<code>`.
const CONNECT_PATH = /^\/auth\/connect\/([A-Za-z0-9_-]{1,128})$/

export type PairingErrorCode = "invalid_link" | "pairing_expired" | "unreachable" | "https_required" | "forbidden_address"
export class OpenCodePairingError extends Error {
  constructor(readonly code: PairingErrorCode) { super(code); this.name = "OpenCodePairingError" }
}

/** Null when the text is not an OpenCode pairing link; throws when it is one we refuse. */
export function parseOpenCodePairingLink(input: string): { origin: string; code: string } | null {
  let url: URL
  try { url = new URL(input.trim()) } catch { return null }
  const match = CONNECT_PATH.exec(url.pathname)
  if (!match || (url.protocol !== "http:" && url.protocol !== "https:")) return null
  if (url.search || url.hash || url.username || url.password) throw new OpenCodePairingError("invalid_link")
  try { return { origin: normalizeExplicitOrigin(url.origin), code: match[1]! } }
  catch (error) { throw endpointFailure(error) }
}

/** One GET, JSON only, no redirect followed, through the verified explicit transport. */
export async function redeemOpenCodePairing(link: { origin: string; code: string }, signal?: AbortSignal,
  resolve?: ResolveAddresses): Promise<string> {
  const deadline = AbortSignal.any([AbortSignal.timeout(SERVER_CONNECTION_LIMITS.probeTimeoutMs), ...(signal ? [signal] : [])])
  const transport = createExplicitTransport({ origin: link.origin, signal: deadline }, resolve)
  let response: Response
  try {
    response = await boundedResponseFetch(transport.fetch, deadline, () => {}, 64 * 1024)(
      new URL(`/auth/connect/${link.code}`, link.origin), { method: "GET", headers: { accept: "application/json" }, signal: deadline })
  } catch (error) { throw endpointFailure(error) }
  // A spent or expired code answers 401; never retry it elsewhere.
  if (response.status === 401 || response.status === 404) throw new OpenCodePairingError("pairing_expired")
  if (!response.ok) throw new OpenCodePairingError("unreachable")
  let token: unknown
  try { token = (await response.json() as { token?: unknown }).token } catch { throw new OpenCodePairingError("unreachable") }
  if (typeof token !== "string" || !token || token.length > 8_192 || /\s/.test(token)) throw new OpenCodePairingError("unreachable")
  return token
}

function endpointFailure(error: unknown): OpenCodePairingError {
  if (error instanceof OpenCodePairingError) return error
  const code = error instanceof ExplicitEndpointError ? error.code : undefined
  if (code === "https_required" || code === "forbidden_address") return new OpenCodePairingError(code)
  if (code === "invalid_origin") return new OpenCodePairingError("invalid_link")
  return new OpenCodePairingError("unreachable")
}
