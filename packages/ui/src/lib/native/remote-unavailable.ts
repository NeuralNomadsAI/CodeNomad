/**
 * Fragment of the loading page an Electron remote window shows when its server cannot be loaded. The page offers
 * Try again, Open a local window and Close window; the host honours those requests only from this page.
 */
export const REMOTE_UNAVAILABLE_HASH = "remote-unavailable"

export function isRemoteUnavailablePage(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.pathname.endsWith("/loading.html") && parsed.hash === `#${REMOTE_UNAVAILABLE_HASH}`
  } catch {
    return false
  }
}
