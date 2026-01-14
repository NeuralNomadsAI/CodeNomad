import type { FastifyReply, FastifyRequest } from "fastify"

export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!header) return result

  const parts = header.split(";")
  for (const part of parts) {
    const index = part.indexOf("=")
    if (index < 0) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (!key) continue
    result[key] = decodeURIComponent(value)
  }
  return result
}

export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false
  if (remoteAddress === "127.0.0.1" || remoteAddress === "::1") return true
  if (remoteAddress === "::ffff:127.0.0.1") return true
  return false
}

export function wantsHtml(request: FastifyRequest): boolean {
  const accept = (request.headers["accept"] ?? "").toString().toLowerCase()
  return accept.includes("text/html") || accept.includes("application/xhtml")
}

export function sendUnauthorized(request: FastifyRequest, reply: FastifyReply) {
  if (request.method === "GET" && !request.url.startsWith("/api/") && wantsHtml(request)) {
    reply.redirect("/login")
    return
  }

  reply.code(401).send({ error: "Unauthorized" })
}
