/**
 * The capability token and path of a `/previews/<token>/…` target, parsed as the
 * preview WebSocket proxy routes it. Remote Control admits upgrades with the same
 * parse, so both judge the same token.
 */
export function parsePreviewUpgradePath(rawUrl: string): { token: string; pathname: string; search: string } | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl, "http://localhost")
  } catch {
    return null
  }

  const match = parsed.pathname.match(/^\/previews\/([^/]+)(?:\/.*)?$/)
  if (!match) {
    return null
  }

  try {
    return {
      token: decodeURIComponent(match[1] ?? ""),
      pathname: parsed.pathname,
      search: parsed.search,
    }
  } catch {
    return null
  }
}
