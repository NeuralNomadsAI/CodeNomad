import fs from "fs"
import path from "path"
import type { Logger } from "../logger"
import { hashPassword, type PasswordHashRecord, verifyPassword } from "./password-hash"

export interface AuthFile {
  version: 1
  username: string
  password: PasswordHashRecord
  userProvided: boolean
  updatedAt: string
}

export interface AuthStatus {
  username: string
  passwordUserProvided: boolean
}

export class AuthStore {
  private cachedFile: AuthFile | null = null
  private overrideAuth: AuthFile | null = null
  private bootstrapUsername: string | null = null

  constructor(private readonly authFilePath: string, private readonly logger: Logger) {}

  getAuthFilePath() {
    return this.authFilePath
  }

  load(): AuthFile | null {
    if (this.overrideAuth) {
      return this.overrideAuth
    }

    if (this.cachedFile) {
      return this.cachedFile
    }

    try {
      if (!fs.existsSync(this.authFilePath)) {
        return null
      }
      const raw = fs.readFileSync(this.authFilePath, "utf-8")
      const parsed = JSON.parse(raw) as AuthFile
      if (!parsed || parsed.version !== 1) {
        this.logger.warn({ authFilePath: this.authFilePath }, "Auth file has unsupported version")
        return null
      }
      this.cachedFile = parsed
      return parsed
    } catch (error) {
      this.logger.warn({ err: error, authFilePath: this.authFilePath }, "Failed to load auth file")
      return null
    }
  }

  ensureInitialized(params: {
    username: string
    password?: string
    allowBootstrapWithoutPassword: boolean
  }): void {
    const password = params.password?.trim()
    if (password) {
      const now = new Date().toISOString()
      const runtime: AuthFile = {
        version: 1,
        username: params.username,
        password: hashPassword(password),
        userProvided: true,
        updatedAt: now,
      }
      this.overrideAuth = runtime
      this.cachedFile = null
      this.bootstrapUsername = null
      this.logger.debug({ authFilePath: this.authFilePath }, "Using runtime auth password override; ignoring auth file")
      return
    }

    const existing = this.load()
    if (existing) {
      if (existing.username !== params.username) {
        // Keep existing username unless explicitly overridden later.
        this.logger.debug({ existing: existing.username, requested: params.username }, "Auth username differs from requested")
      }
      this.bootstrapUsername = null
      return
    }

    if (params.allowBootstrapWithoutPassword) {
      this.bootstrapUsername = params.username
      this.logger.debug({ authFilePath: this.authFilePath }, "No auth file present; bootstrap-only mode enabled")
      return
    }

    throw new Error(
      `No server password configured. Create ${this.authFilePath} or start with --password / CODENOMAD_SERVER_PASSWORD.`,
    )
  }

  validateCredentials(username: string, password: string): boolean {
    const auth = this.load()
    if (!auth) {
      return false
    }

    if (username !== auth.username) {
      return false
    }

    return verifyPassword(password, auth.password)
  }

  setPassword(params: { password: string; markUserProvided: boolean }): AuthStatus {
    if (this.overrideAuth) {
      throw new Error(
        "Server password is provided via CLI/env and cannot be changed while running. Restart without --password / CODENOMAD_SERVER_PASSWORD to use auth.json.",
      )
    }

    const current = this.load()

    if (!current) {
      if (!this.bootstrapUsername) {
        throw new Error("Auth is not initialized")
      }

      const created: AuthFile = {
        version: 1,
        username: this.bootstrapUsername,
        password: hashPassword(params.password),
        userProvided: params.markUserProvided,
        updatedAt: new Date().toISOString(),
      }

      this.persist(created)
      this.bootstrapUsername = null
      return { username: created.username, passwordUserProvided: created.userProvided }
    }

    const next: AuthFile = {
      ...current,
      password: hashPassword(params.password),
      userProvided: params.markUserProvided,
      updatedAt: new Date().toISOString(),
    }

    this.persist(next)
    return { username: next.username, passwordUserProvided: next.userProvided }
  }

  getStatus(): AuthStatus {
    const current = this.load()
    if (current) {
      return { username: current.username, passwordUserProvided: current.userProvided }
    }

    if (this.bootstrapUsername) {
      return { username: this.bootstrapUsername, passwordUserProvided: false }
    }

    throw new Error("Auth is not initialized")
  }

  private persist(auth: AuthFile) {
    try {
      fs.mkdirSync(path.dirname(this.authFilePath), { recursive: true })
      fs.writeFileSync(this.authFilePath, JSON.stringify(auth, null, 2), "utf-8")
      this.cachedFile = auth
      this.logger.debug({ authFilePath: this.authFilePath }, "Persisted auth file")
    } catch (error) {
      this.logger.error({ err: error, authFilePath: this.authFilePath }, "Failed to persist auth file")
      throw error
    }
  }
}
