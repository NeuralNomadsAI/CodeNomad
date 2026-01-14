import type { FastifyReply, FastifyRequest } from "fastify"
import path from "path"
import type { Logger } from "../logger"
import { AuthStore } from "./auth-store"
import { TokenManager } from "./token-manager"
import { SessionManager } from "./session-manager"
import { isLoopbackAddress, parseCookies } from "./http-auth"

export const BOOTSTRAP_TOKEN_STDOUT_PREFIX = "CODENOMAD_BOOTSTRAP_TOKEN:" as const
export const DEFAULT_AUTH_USERNAME = "codenomad" as const
export const DEFAULT_AUTH_COOKIE_NAME = "codenomad_session" as const

export interface AuthManagerInit {
  configPath: string
  username: string
  password?: string
  generateToken: boolean
}

export class AuthManager {
  private readonly authStore: AuthStore
  private readonly tokenManager: TokenManager | null
  private readonly sessionManager = new SessionManager()
  private readonly cookieName = DEFAULT_AUTH_COOKIE_NAME

  constructor(private readonly init: AuthManagerInit, private readonly logger: Logger) {
    const authFilePath = resolveAuthFilePath(init.configPath)
    this.authStore = new AuthStore(authFilePath, logger.child({ component: "auth" }))

    // Startup: password comes from CLI/env, auth.json, or bootstrap-only mode.
    this.authStore.ensureInitialized({
      username: init.username,
      password: init.password,
      allowBootstrapWithoutPassword: init.generateToken,
    })

    this.tokenManager = init.generateToken ? new TokenManager(60_000) : null
  }

  getCookieName(): string {
    return this.cookieName
  }

  isTokenBootstrapEnabled(): boolean {
    return Boolean(this.tokenManager)
  }

  issueBootstrapToken(): string | null {
    if (!this.tokenManager) return null
    return this.tokenManager.generate()
  }

  consumeBootstrapToken(token: string): boolean {
    if (!this.tokenManager) return false
    return this.tokenManager.consume(token)
  }

  validateLogin(username: string, password: string): boolean {
    return this.authStore.validateCredentials(username, password)
  }

  createSession(username: string) {
    return this.sessionManager.createSession(username)
  }

  getStatus() {
    return this.authStore.getStatus()
  }

  setPassword(password: string) {
    return this.authStore.setPassword({ password, markUserProvided: true })
  }

  isLoopbackRequest(request: FastifyRequest): boolean {
    return isLoopbackAddress(request.socket.remoteAddress)
  }

  getSessionFromRequest(request: FastifyRequest): { username: string; sessionId: string } | null {
    const cookies = parseCookies(request.headers.cookie)
    const sessionId = cookies[this.cookieName]
    const session = this.sessionManager.getSession(sessionId)
    if (!session) return null
    return { username: session.username, sessionId: session.id }
  }

  setSessionCookie(reply: FastifyReply, sessionId: string) {
    reply.header("Set-Cookie", buildSessionCookie(this.cookieName, sessionId))
  }

  clearSessionCookie(reply: FastifyReply) {
    reply.header("Set-Cookie", buildSessionCookie(this.cookieName, "", { maxAgeSeconds: 0 }))
  }
}

function resolveAuthFilePath(configPath: string) {
  const resolvedConfigPath = resolvePath(configPath)
  return path.join(path.dirname(resolvedConfigPath), "auth.json")
}

function resolvePath(filePath: string) {
  if (filePath.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", filePath.slice(2))
  }
  return path.resolve(filePath)
}

function buildSessionCookie(name: string, value: string, options?: { maxAgeSeconds?: number }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "HttpOnly", "Path=/", "SameSite=Lax"]
  if (options?.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`)
  }
  return parts.join("; ")
}
