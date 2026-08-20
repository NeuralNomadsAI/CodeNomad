export type NavigationDecision = "allow" | "external" | "deny"

export function requireHttpUrl(value: string, name: string): URL {
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${name} must use HTTP or HTTPS`)
  return url
}

export function decideNavigation(
  value: string,
  allowedOrigins: readonly string[],
  loadingUrl: string,
): NavigationDecision {
  let url: URL
  try { url = new URL(value) } catch { return "deny" }

  try {
    if (url.toString() === new URL(loadingUrl).toString()) return "allow"
  } catch {}

  if (url.protocol === "http:" || url.protocol === "https:") {
    return allowedOrigins.includes(url.origin) ? "allow" : "external"
  }
  return url.protocol === "file:" || url.protocol === "data:" || url.protocol === "javascript:" ? "deny" : "external"
}
