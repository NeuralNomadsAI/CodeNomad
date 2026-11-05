// prototype-1236: mirrors CONNECT_PATH in packages/server/src/opencode/servers/pairing.ts.
const CONNECT_PATH = /^\/auth\/connect\/[A-Za-z0-9_-]{1,128}$/

/**
 * True for an `opencode pair` link (`<origin>/auth/connect/<code>`) or the manual
 * `scheme://user:password@host` form. The UI never opens or fetches it: the single-use
 * code is exchanged by the host backend only.
 */
export function isOpenCodeServerAddress(input: string): boolean {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return false
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  return CONNECT_PATH.test(url.pathname) || url.password.length > 0
}
