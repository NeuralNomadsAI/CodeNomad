// Mirrors the server's PAIR_PAGE_PATH (packages/server/src/remote-control/gate.ts).
const PAIR_PAGE_PATH = "/remote-pair"

/**
 * Splits a Remote Control pairing link into the server address to save and the
 * single-use link that only the first window opens. The code lives in the
 * fragment and is never stored with the server.
 */
export function splitPairingLink(input: string): { baseUrl: string; entryUrl: string } | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.protocol !== "https:" || url.pathname !== PAIR_PAGE_PATH || url.hash.length <= 1) return null
  return { baseUrl: url.origin, entryUrl: `${url.origin}${PAIR_PAGE_PATH}${url.hash}` }
}
