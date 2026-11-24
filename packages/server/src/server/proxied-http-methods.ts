/**
 * WebDAV, CalDAV and SEARCH methods beyond Fastify's defaults, with whether a
 * request body is parsed. Proxied surfaces (SideCars, web previews, the OpenCode
 * instance proxy and remote windows) forward them like any other method.
 */
export const PROXIED_HTTP_METHODS: ReadonlyArray<readonly [method: string, hasBody: boolean]> = [
  ["PROPFIND", true], ["PROPPATCH", true], ["MKCOL", true], ["COPY", true], ["MOVE", true],
  ["LOCK", true], ["UNLOCK", false], ["SEARCH", true], ["REPORT", true], ["MKCALENDAR", true],
]

/** Registers PROXIED_HTTP_METHODS on a Fastify application before any route is declared. */
export function addProxiedHttpMethods(app: { addHttpMethod(method: string, options: { hasBody: boolean }): unknown }): void {
  for (const [method, hasBody] of PROXIED_HTTP_METHODS) app.addHttpMethod(method, { hasBody })
}
