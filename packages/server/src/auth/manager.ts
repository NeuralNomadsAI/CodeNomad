import type { FastifyReply, FastifyRequest } from "fastify"
import path from "path"
import type { Logger } from "../logger"
import { AuthStore } from "./auth-store"
import { TokenManager } from "./token-manager"
import { SessionManager, type SessionInfo } from "./session-manager"
import { parseCookies } from "./http-auth"
import { isLocalRequest, isRefusedDeviceRequest, isRemoteRequest, remoteDeviceOf } from "../remote-control/request-origin"

export const BOOTSTRAP_TOKEN_STDOUT_PREFIX = "CODENOMAD_BOOTSTRAP_TOKEN:" as const
export const DEFAULT_AUTH_USERNAME = "codenomad" as const
export const DEFAULT_AUTH_COOKIE_NAME = "codenomad_session" as const

export interface AuthManagerInit {
  configPath: string
  username: string
  password?: string
  generateToken: boolean
  managedLocal?: boolean
  dangerouslySkipAuth?: boolean
  cookieName?: string
  sessionIdleMs?: number
  sessionAbsoluteMs?: number
}

export class AuthManager {
  private readonly authStore: AuthStore | null
  private readonly tokenManager: TokenManager | null
  private readonly sessionManager: SessionManager
  private readonly cookieName: string
  private readonly authEnabled: boolean
  private managedSession: { current: string; previous?: string; delivered: boolean } | undefined
  private readonly principalLoggedOutListeners = new Set<(id: string) => void>()

  constructor(private readonly init: AuthManagerInit, private readonly logger: Logger) {
    this.cookieName = sanitizeCookieName(init.cookieName)
    this.sessionManager = new SessionManager({ idleMs: init.sessionIdleMs, absoluteMs: init.sessionAbsoluteMs })
    this.authEnabled = !Boolean(init.dangerouslySkipAuth)

    if (!this.authEnabled) {
      this.authStore = null
      this.tokenManager = null
      return
    }

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

  isAuthEnabled(): boolean {
    return this.authEnabled
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

  createBootstrapSession(token: string): SessionInfo | undefined {
    if (!this.tokenManager?.consume(token)) return undefined
    const session = this.sessionManager.createSession(this.getStatus().username)
    if (this.init.managedLocal && this.authStore?.canRenewBootstrapSession()) {
      this.managedSession = { current: session.id, delivered: true }
    }
    return session
  }

  /** Called only by the authenticated process parent on stdin. */
  renewManagedSession(): string | null {
    const managed = this.managedSession
    if (!managed || !this.authStore?.canRenewBootstrapSession()) return null
    if (this.sessionManager.hasSession(managed.current)) return managed.delivered ? null : managed.current
    const current = this.sessionManager.createSession(this.getStatus().username).id
    this.managedSession = { current, previous: managed.delivered ? managed.current : managed.previous, delivered: false }
    return current
  }

  async validateLogin(username: string, password: string): Promise<boolean> {
    if (!this.authEnabled) {
      return true
    }
    return this.requireAuthStore().validateCredentials(username, password)
  }

  createSession(username: string) {
    if (!this.authEnabled) {
      return { id: "auth-disabled", createdAt: Date.now(), username: this.init.username }
    }
    return this.sessionManager.createSession(username)
  }

  getStatus() {
    if (!this.authEnabled) {
      return { username: this.init.username, passwordUserProvided: false }
    }
    return this.requireAuthStore().getStatus()
  }

  async setPassword(password: string) {
    if (!this.authEnabled) {
      throw new Error("Internal authentication is disabled")
    }
    const status = await this.requireAuthStore().setPassword({ password, markUserProvided: true })
    this.managedSession = undefined
    this.sessionManager.revokeUser(status.username)
    return status
  }

  revokeSession(request: FastifyRequest): void {
    const session = this.getSessionFromRequest(request)
    const managed = this.managedSession
    const cookie = !isRemoteRequest(request) && !isRefusedDeviceRequest(request) && !remoteDeviceOf(request)
      ? this.cookieSessionId(request.headers) : undefined
    // The immediate predecessor is accepted only for sign-out, including a
    // request already in flight when the desktop replaced its cookie.
    const revokingManaged = managed && cookie && (cookie === managed.current || cookie === managed.previous)
    if (revokingManaged) this.managedSession = undefined
    const id = revokingManaged ? managed.current : session?.sessionId
    if (!id) return
    this.sessionManager.revoke(id)
    const errors: unknown[] = []
    for (const listener of this.principalLoggedOutListeners) {
      try { listener(id) } catch (error) { errors.push(error) }
    }
    if (errors.length) throw errors[0]
  }

  onPrincipalLoggedOut(listener: (id: string) => void): () => void {
    this.principalLoggedOutListeners.add(listener)
    return () => { this.principalLoggedOutListeners.delete(listener) }
  }

  onSessionInvalidated(sessionId: string, listener: () => void): () => void {
    return this.authEnabled ? this.sessionManager.onInvalidated(sessionId, listener) : () => {}
  }

  isSessionValid(id: string): boolean {
    return this.authEnabled && this.sessionManager.hasSession(id)
  }

  /** From this machine's own listeners; tunnelled Remote Control traffic never qualifies. */
  isLoopbackRequest(request: FastifyRequest): boolean {
    return isLocalRequest(request)
  }

  getSessionFromRequest(request: FastifyRequest): { username: string; sessionId: string } | null {
    // Device scope applies on both listeners, even when local auth is skipped.
    const deviceId = remoteDeviceOf(request)
    if (deviceId) return { username: this.init.username, sessionId: `remote-device:${deviceId}` }
    if (isRemoteRequest(request) || isRefusedDeviceRequest(request)) return null
    return this.getSessionFromHeaders(request.headers)
  }

  getSessionFromHeaders(headers: { cookie?: string | string[] | undefined }): { username: string; sessionId: string } | null {
    if (!this.authEnabled) {
      // When auth is disabled, treat all requests as authenticated.
      // We still return a stable username so callers can display it.
      return { username: this.init.username, sessionId: "auth-disabled" }
    }

    const session = this.sessionManager.getSession(this.cookieSessionId(headers))
    if (!session) return null
    if (this.managedSession?.current === session.id) this.managedSession.delivered = true
    return { username: session.username, sessionId: session.id }
  }

  private cookieSessionId(headers: { cookie?: string | string[] | undefined }): string | undefined {
    const cookieHeader = Array.isArray(headers.cookie) ? headers.cookie.join("; ") : headers.cookie
    return parseCookies(cookieHeader)?.[this.cookieName]
  }

  watchSessionRevocation(sessionId: string, close: () => void): () => void {
    return this.authEnabled ? this.sessionManager.watch(sessionId, close) : () => {}
  }

  setSessionCookie(reply: FastifyReply, sessionId: string) {
    this.setSessionCookieWithOptions(reply, sessionId)
  }

  setSessionCookieWithOptions(reply: FastifyReply, sessionId: string, options?: { secure?: boolean }) {
    reply.header("Set-Cookie", buildSessionCookie(this.cookieName, sessionId, { ...options, maxAgeSeconds: this.authEnabled ? 7 * 24 * 60 * 60 : undefined }))
  }

  clearSessionCookie(reply: FastifyReply) {
    reply.header("Set-Cookie", buildSessionCookie(this.cookieName, "", { maxAgeSeconds: 0 }))
  }

  clearSessionCookieWithOptions(reply: FastifyReply, options?: { secure?: boolean }) {
    reply.header("Set-Cookie", buildSessionCookie(this.cookieName, "", { maxAgeSeconds: 0, ...options }))
  }

  private requireAuthStore(): AuthStore {
    if (!this.authStore) {
      throw new Error("Auth store is unavailable")
    }
    return this.authStore
  }
}

function sanitizeCookieName(value: string | undefined): string {
  const trimmed = value?.trim()
  if (!trimmed) {
    return DEFAULT_AUTH_COOKIE_NAME
  }

  const sanitized = trimmed.replace(/[^A-Za-z0-9_-]/g, "_")
  return sanitized.length > 0 ? sanitized : DEFAULT_AUTH_COOKIE_NAME
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

function buildSessionCookie(name: string, value: string, options?: { maxAgeSeconds?: number; secure?: boolean }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "HttpOnly", "Path=/", "SameSite=Lax"]
  if (options?.secure) {
    parts.push("Secure")
  }
  if (options?.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`)
  }
  return parts.join("; ")
}
