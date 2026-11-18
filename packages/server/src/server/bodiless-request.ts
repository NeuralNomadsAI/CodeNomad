import type { IncomingHttpHeaders } from "node:http"

/**
 * A DELETE or OPTIONS request without Content-Length or Transfer-Encoding has no
 * body, whatever its Content-Type. The proxy scopes that forward request bodies
 * (the OpenCode instance proxy, SideCars and remote windows) forward none for it
 * rather than a parsed empty one.
 */
export function framesNoBody(request: { method: string; headers: IncomingHttpHeaders }): boolean {
  return (request.method === "DELETE" || request.method === "OPTIONS")
    && request.headers["content-length"] === undefined && request.headers["transfer-encoding"] === undefined
}
