import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify"
import { randomBytes, randomUUID } from "crypto"
import { Readable } from "stream"
import { pipeline } from "stream/promises"
import { Agent, fetch } from "undici"
import type { AuthManager } from "../auth/manager"
import type { Logger } from "../logger"

const LOOPBACK_HOST = "127.0.0.1"
const BOOTSTRAP_PAGE_PATH = "/__codenomad/auth/token"
const BOOTSTRAP_EXCHANGE_PATH = "/__codenomad/api/auth/token"
const SESSION_IDLE_TTL_MS = 30 * 60_000

interface RemoteProxySession {
  id: string
  bootstrapToken: string
  targetBaseUrl: URL
  skipTlsVerify: boolean
  localBaseUrl: URL
  entryUrl: URL
  bootstrapUrl: string
  activated: boolean
  cookiePrefix: string
  app: FastifyInstance
  dispatcher?: Agent
  createdAt: number
  lastAccessAt: number
}

export interface RemoteProxySessionManagerOptions {
  authManager: AuthManager
  logger: Logger
  httpsOptions?: { key: string | Buffer; cert: string | Buffer; ca?: string | Buffer }
}

export interface RemoteProxySessionCreateResult {
  sessionId: string
  windowUrl: string
}

export class RemoteProxySessionManager {
  private readonly sessions = new Map<string, RemoteProxySession>()
  private readonly cleanupTimer: NodeJS.Timeout

  constructor(private readonly options: RemoteProxySessionManagerOptions) {
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpiredSessions()
    }, 60_000)
    this.cleanupTimer.unref()
  }

  async createSession(baseUrl: string, skipTlsVerify: boolean): Promise<RemoteProxySessionCreateResult> {
    if (!this.options.httpsOptions) {
      throw new Error("Local HTTPS is required for remote proxy sessions")
    }

    const targetBaseUrl = normalizeBaseUrl(baseUrl)
    const sessionId = randomUUID()
    const bootstrapToken = randomBytes(32).toString("base64url")
    const dispatcher = skipTlsVerify ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined
    const app = Fastify({ logger: false, https: this.options.httpsOptions })
    let session: RemoteProxySession | null = null

    app.removeAllContentTypeParsers()
    // Preserve raw request bodies for proxying while still letting token JSON parse from Buffer.
    app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body))

    app.get(BOOTSTRAP_PAGE_PATH, async (request, reply) => {
      if (!this.options.authManager.isLoopbackRequest(request)) {
        reply.code(404).send({ error: "Not found" })
        return
      }

      reply.header("Cache-Control", "no-store")
      reply.header("Pragma", "no-cache")
      reply.header("Expires", "0")
      reply.type("text/html").send(buildBootstrapPageHtml())
    })

    app.post(BOOTSTRAP_EXCHANGE_PATH, async (request, reply) => {
      if (!this.options.authManager.isLoopbackRequest(request)) {
        reply.code(404).send({ error: "Not found" })
        return
      }

      if (!session) {
        reply.code(503).send({ error: "Remote proxy session is unavailable" })
        return
      }

      const body = parseTokenBody(request.body)
      if (body.token !== session.bootstrapToken) {
        reply.code(401).send({ error: "Invalid token" })
        return
      }

      session.activated = true
      session.lastAccessAt = Date.now()
      reply.send({ ok: true })
    })

    app.all("/*", async (request, reply) => {
      if (!session) {
        reply.code(503).send({ error: "Remote proxy session is unavailable" })
        return
      }

      if (!session.activated) {
        reply.code(403).send({ error: "Remote proxy session is not activated" })
        return
      }

      session.lastAccessAt = Date.now()
      await proxyRequest({ request, reply, session, logger: this.options.logger })
    })

    app.setNotFoundHandler(async (request, reply) => {
      if (!session) {
        reply.code(503).send({ error: "Remote proxy session is unavailable" })
        return
      }

      if (!session.activated) {
        reply.code(403).send({ error: "Remote proxy session is not activated" })
        return
      }

      session.lastAccessAt = Date.now()
      await proxyRequest({ request, reply, session, logger: this.options.logger })
    })

    const addressInfo = await app.listen({ host: LOOPBACK_HOST, port: 0 })
    const address = new URL(addressInfo)
    const localBaseUrl = new URL(`https://${LOOPBACK_HOST}:${address.port}`)
    const entryUrl = new URL(targetBaseUrl.pathname || "/", localBaseUrl)
    const returnTo = buildReturnToTarget(entryUrl)

    session = {
      id: sessionId,
      bootstrapToken,
      targetBaseUrl,
      skipTlsVerify,
      localBaseUrl,
      entryUrl,
      bootstrapUrl: `${localBaseUrl.origin}${BOOTSTRAP_PAGE_PATH}?returnTo=${encodeURIComponent(returnTo)}#${encodeURIComponent(bootstrapToken)}`,
      activated: false,
      cookiePrefix: `cnrp_${randomBytes(6).toString("hex")}_`,
      app,
      dispatcher,
      createdAt: Date.now(),
      lastAccessAt: Date.now(),
    }

    this.sessions.set(sessionId, session)
    this.options.logger.info(
      { sessionId, targetBaseUrl: targetBaseUrl.toString(), localBaseUrl: localBaseUrl.toString() },
      "Created remote proxy session",
    )

    return { sessionId, windowUrl: session.bootstrapUrl }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.disposeSession(sessionId)
  }

  private async cleanupExpiredSessions() {
    const now = Date.now()
    for (const session of Array.from(this.sessions.values())) {
      if (now - session.lastAccessAt <= SESSION_IDLE_TTL_MS) {
        continue
      }
      await this.disposeSession(session.id)
    }
  }

  private async disposeSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return false
    }

    this.sessions.delete(sessionId)
    session.dispatcher?.close().catch(() => {})
    await session.app.close().catch(() => {})
    this.options.logger.info({ sessionId }, "Disposed remote proxy session")
    return true
  }
}

function normalizeBaseUrl(input: string): URL {
  const parsed = new URL(input.trim())
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Server URL must use http:// or https://")
  }

  parsed.hash = ""
  parsed.search = ""
  parsed.pathname = parsed.pathname === "/" ? "/" : parsed.pathname.replace(/\/+$/, "") || "/"
  return parsed
}

function buildReturnToTarget(entryUrl: URL): string {
  const query = entryUrl.search ? entryUrl.search : ""
  return `${entryUrl.pathname || "/"}${query}`
}

function buildBootstrapPageHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CodeNomad</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; background: #0b0b0f; color: #fff; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
      .card { width: 420px; max-width: calc(100vw - 32px); background: #14141c; border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 24px; }
      h1 { font-size: 18px; margin: 0 0 12px; }
      p { margin: 0; color: rgba(255,255,255,0.7); font-size: 13px; line-height: 1.4; }
      .error { margin-top: 12px; color: #ff6b6b; font-size: 13px; display: none; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Connecting...</h1>
      <p>Finalizing local authentication.</p>
      <div id="error" class="error"></div>
    </div>
    <script>
      const token = decodeURIComponent((location.hash || "").replace(/^#/, "").trim())
      const params = new URLSearchParams(location.search)
      const returnTo = sanitizeReturnTo(params.get("returnTo"))
      const errorEl = document.getElementById("error")

      function sanitizeReturnTo(value) {
        if (!value || typeof value !== "string") return "/"
        if (!value.startsWith("/")) return "/"
        if (value.startsWith("//")) return "/"
        return value
      }

      function showError(message) {
        errorEl.textContent = message
        errorEl.style.display = "block"
      }

      async function run() {
        if (!token) {
          showError("Missing bootstrap token.")
          return
        }

        try {
          const res = await fetch("${BOOTSTRAP_EXCHANGE_PATH}", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token }),
            credentials: "include",
          })

          if (!res.ok) {
            let message = ""
            try {
              const json = await res.json()
              message = json && json.error ? String(json.error) : ""
            } catch {
              message = ""
            }
            showError(message || "Token exchange failed (" + res.status + ")")
            return
          }

          window.location.replace(returnTo)
        } catch (error) {
          showError(error && error.message ? error.message : String(error))
        }
      }

      run()
    </script>
  </body>
</html>`
}

function parseTokenBody(body: unknown): { token: string } {
  const value = normalizeJsonBody(body) as { token?: unknown } | null | undefined
  const token = typeof value?.token === "string" ? value.token.trim() : ""
  if (!token) {
    throw new Error("Missing bootstrap token")
  }
  return { token }
}

function normalizeJsonBody(body: unknown): unknown {
  if (Buffer.isBuffer(body)) {
    return JSON.parse(body.toString("utf-8"))
  }
  if (typeof body === "string") {
    return JSON.parse(body)
  }
  return body
}

function toRequestBody(body: unknown): any {
  if (body == null) {
    return undefined
  }
  if (Buffer.isBuffer(body) || typeof body === "string" || body instanceof Uint8Array) {
    return body
  }
  return JSON.stringify(body)
}

async function proxyRequest(args: {
  request: FastifyRequest
  reply: FastifyReply
  session: RemoteProxySession
  logger: Logger
}) {
  const { request, reply, session, logger } = args
  const upstreamUrl = buildUpstreamUrl(session.targetBaseUrl, request.raw.url ?? request.url)
  const headers = filterRequestHeaders(request.headers, session)

  const init: any = {
    method: request.method,
    headers,
    dispatcher: session.dispatcher,
    redirect: "manual",
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    const body = toRequestBody(request.body)
    if (body !== undefined) {
      init.body = body
      init.duplex = "half"
    }
  }

  try {
    const response = await fetch(upstreamUrl, init as any)
    reply.code(response.status)
    applyResponseHeaders(reply, response, session)

    if (!response.body || request.method === "HEAD") {
      reply.send()
      return
    }

    reply.hijack()
    reply.raw.writeHead(reply.statusCode, toOutgoingHeaders(reply.getHeaders()))
    await pipeline(Readable.fromWeb(response.body as any), reply.raw)
  } catch (error) {
    logger.error({ err: error, upstreamUrl }, "Failed to proxy remote session request")
    if (!reply.sent) {
      reply.code(502).send({ error: "Remote proxy request failed" })
    }
  }
}

function buildUpstreamUrl(baseUrl: URL, rawUrl: string): string {
  const parsed = new URL(rawUrl, "https://localhost")
  const url = new URL(baseUrl.toString())
  url.pathname = rewriteRequestPath(baseUrl, parsed.pathname)
  url.search = stripInternalQuery(parsed.search)
  url.hash = ""
  return url.toString()
}

function rewriteRequestPath(baseUrl: URL, requestPath: string): string {
  const basePath = normalizedBasePath(baseUrl)
  if (basePath === "/") {
    return requestPath
  }

  if (requestPath === "/") {
    return basePath
  }

  if (pathHasBasePrefix(basePath, requestPath)) {
    return requestPath
  }

  return `${basePath}${requestPath}`
}

function normalizedBasePath(baseUrl: URL): string {
  return baseUrl.pathname || "/"
}

function pathHasBasePrefix(basePath: string, requestPath: string): boolean {
  return requestPath === basePath || requestPath.startsWith(`${basePath}/`)
}

function stripInternalQuery(search: string): string {
  if (!search || search === "?") {
    return ""
  }
  return search
}

function filterRequestHeaders(
  headers: FastifyRequest["headers"],
  session: RemoteProxySession,
): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (!value) continue
    const lower = key.toLowerCase()
    if (
      isHopByHopHeader(lower) ||
      lower === "host" ||
      lower === "content-length" ||
      lower === "accept-encoding"
    ) {
      continue
    }
    if (lower === "origin") {
      next[key] = session.targetBaseUrl.origin
      continue
    }
    if (lower === "referer") {
      const rewritten = rewriteRefererHeader(Array.isArray(value) ? value[0] : value, session.targetBaseUrl)
      if (rewritten) {
        next[key] = rewritten
      }
      continue
    }
    if (lower === "cookie") {
      const rewritten = rewriteRequestCookieHeader(Array.isArray(value) ? value.join("; ") : value, session.cookiePrefix)
      if (rewritten) {
        next[key] = rewritten
      }
      continue
    }
    next[key] = Array.isArray(value) ? value.join(",") : value
  }

  next.host = session.targetBaseUrl.port ? `${session.targetBaseUrl.hostname}:${session.targetBaseUrl.port}` : session.targetBaseUrl.hostname
  if (!next.origin) {
    next.origin = session.targetBaseUrl.origin
  }
  return next
}

function rewriteRefererHeader(referer: string | undefined, targetBaseUrl: URL): string | null {
  if (!referer) {
    return null
  }

  try {
    const parsed = new URL(referer)
    const rewritten = new URL(targetBaseUrl.toString())
    rewritten.pathname = rewriteRequestPath(targetBaseUrl, parsed.pathname)
    rewritten.search = parsed.search
    rewritten.hash = parsed.hash
    return rewritten.toString()
  } catch {
    return null
  }
}

function applyResponseHeaders(reply: FastifyReply, response: any, session: RemoteProxySession) {
  const setCookie = (response.headers as any).getSetCookie?.() as string[] | undefined
  if (Array.isArray(setCookie)) {
    for (const cookie of setCookie) {
      reply.header("set-cookie", rewriteSetCookie(cookie, session.cookiePrefix))
    }
  }

  response.headers.forEach((value: string, key: string) => {
    const lower = key.toLowerCase()
    if (
      isHopByHopHeader(lower) ||
      lower === "set-cookie" ||
      lower === "content-length" ||
      lower === "content-encoding"
    ) {
      return
    }

    if (lower === "location") {
      reply.header(key, rewriteLocation(value, session.targetBaseUrl, session.localBaseUrl))
      return
    }

    reply.header(key, value)
  })
}

function toOutgoingHeaders(headers: ReturnType<FastifyReply["getHeaders"]>): Record<string, string | string[]> {
  const next: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue
    }
    next[key] = Array.isArray(value) ? value.map(String) : String(value)
  }
  return next
}

function rewriteSetCookie(cookie: string, cookiePrefix: string): string {
  const parts = cookie.split(";").map((part) => part.trim())
  const first = parts.shift() ?? ""
  const separator = first.indexOf("=")
  if (separator <= 0) {
    return cookie
  }

  const name = first.slice(0, separator).trim()
  const value = first.slice(separator + 1)
  const rewritten = [`${cookiePrefix}${name}=${value}`]
  for (const part of parts) {
    if (part.slice(0, 7).toLowerCase().startsWith("domain=")) {
      continue
    }
    rewritten.push(part)
  }
  return rewritten.join("; ")
}

function rewriteRequestCookieHeader(cookieHeader: string, cookiePrefix: string): string {
  const next: string[] = []
  for (const rawPart of cookieHeader.split(";")) {
    const part = rawPart.trim()
    if (!part) continue
    const separator = part.indexOf("=")
    if (separator <= 0) continue
    const name = part.slice(0, separator).trim()
    const value = part.slice(separator + 1)
    if (!name.startsWith(cookiePrefix)) {
      continue
    }
    next.push(`${name.slice(cookiePrefix.length)}=${value}`)
  }
  return next.join("; ")
}

function rewriteLocation(location: string, targetBaseUrl: URL, localBaseUrl: URL): string {
  try {
    const parsed = new URL(location, targetBaseUrl)
    if (parsed.origin !== targetBaseUrl.origin) {
      return location
    }

    const rewritten = new URL(localBaseUrl.toString())
    rewritten.pathname = parsed.pathname
    rewritten.search = parsed.search
    rewritten.hash = parsed.hash
    return rewritten.toString()
  } catch {
    return location
  }
}

function isHopByHopHeader(name: string): boolean {
  return new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]).has(name)
}
