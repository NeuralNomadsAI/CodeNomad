/**
 * The path Fastify's router matches for a request target, so admission checks
 * judge the route that will actually run, never the raw target. Like the router,
 * it ends at the first "?" or ";" (Fastify's default semicolon delimiter) and is
 * decoded with decodeURI: "/%61pi" routes as "/api", while reserved characters
 * such as "%2F" stay encoded and "%25" is never decoded twice.
 *
 * Returns null for a target to refuse: anything but origin-form (the router
 * also routes absolute-form and "//" targets and strips fragments, which
 * browsers never send) and malformed percent-encoding, which the router answers
 * with 400.
 */
export function routedPath(target: string): string | null {
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("#")) return null
  const end = target.search(/[?;]/)
  const path = end < 0 ? target : target.slice(0, end)
  try {
    return decodeURI(path.replace(/%25/g, "%2525"))
  } catch {
    return null
  }
}
