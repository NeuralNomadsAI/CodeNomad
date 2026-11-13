import type { FastifyRouterOptions, RawServerDefault } from "fastify"

/** Fastify router options, including the semicolon option its router reads but find-my-way's Config type omits. */
export type RouterOptions = FastifyRouterOptions<RawServerDefault> & { useSemicolonDelimiter?: boolean }

/**
 * Router options of every CodeNomad Fastify application. The semicolon
 * delimiter ends the routed path at the first ";" as well as "?"; routedPath()
 * follows the same setting, so admission and routing always agree. Without an
 * `onMaxParamLength` handler, a target whose named parameter exceeds the
 * router's length limit matches no route and reaches the not-found handler
 * through the ordinary request lifecycle, after Remote Control admission,
 * CORS, authentication and logging.
 */
export const ROUTER_OPTIONS: Readonly<RouterOptions & { useSemicolonDelimiter: boolean }> = Object.freeze({
  useSemicolonDelimiter: true,
  onMaxParamLength: undefined,
})

const PATH_END = ROUTER_OPTIONS.useSemicolonDelimiter ? /[?;]/ : /\?/

/**
 * The path Fastify's router matches for a request target, so admission checks
 * judge the route that will actually run, never the raw target. Like the router,
 * it ends at the first "?" or, with the semicolon delimiter, ";" and is
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
  const end = target.search(PATH_END)
  const path = end < 0 ? target : target.slice(0, end)
  try {
    return decodeURI(path.replace(/%25/g, "%2525"))
  } catch {
    return null
  }
}
