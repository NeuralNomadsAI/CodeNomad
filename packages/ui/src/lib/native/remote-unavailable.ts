/**
 * Fragment of the loading page an Electron remote window shows when its server cannot be loaded:
 * `#remote-unavailable=<token>`. The page offers Try again, Open a local window and Close window and
 * hands the token back with each request. The token is the host's authority check (with the origin the
 * document committed with, `electron/main/remote-recovery.ts`); this module only reads it for display.
 */
export const REMOTE_UNAVAILABLE_HASH = "remote-unavailable"

/** The recovery token of a loading page opened as the unavailable-server page, otherwise null. */
export function remoteUnavailableToken(url: string): string | null {
  try {
    const parsed = new URL(url)
    const prefix = `#${REMOTE_UNAVAILABLE_HASH}=`
    if (!parsed.pathname.endsWith("/loading.html") || !parsed.hash.startsWith(prefix)) return null
    return parsed.hash.slice(prefix.length) || null
  } catch {
    return null
  }
}
