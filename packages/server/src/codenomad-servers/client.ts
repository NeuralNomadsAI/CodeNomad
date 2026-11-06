import { createExplicitTransport } from "../opencode/servers/transport"
import { ExplicitEndpointError, type ResolveAddresses } from "../opencode/servers/endpoint"
import type { CodeNomadServerSecret } from "./credentials"

export type CodeNomadServerErrorCode = "unreachable" | "tls_error" | "auth" | "pairing_unavailable" | "needs_credentials" | "unknown_server"

/** Stable codes only; never a URL, credential or upstream message. */
export class CodeNomadServerError extends Error {
  constructor(readonly code: CodeNomadServerErrorCode) {
    super(code)
    this.name = "CodeNomadServerError"
  }
}

const READ_LIMIT_BYTES = 8 * 1024 * 1024
const CALL_TIMEOUT_MS = 10_000

export function endpointErrorCode(error: unknown): CodeNomadServerErrorCode {
  if (error instanceof CodeNomadServerError) return error.code
  if (error instanceof ExplicitEndpointError && error.code === "tls") return "tls_error"
  return "unreachable"
}

/** Name=value pairs of Set-Cookie values; attributes are dropped. */
function cookiePairs(values: string[]): Map<string, string> {
  const pairs = new Map<string, string>()
  for (const value of values) {
    const pair = value.split(";", 1)[0]!.trim()
    const index = pair.indexOf("=")
    if (index > 0) pairs.set(pair.slice(0, index), pair.slice(index + 1))
  }
  return pairs
}

/** One authenticated, read-only client per saved CodeNomad profile. */
export class CodeNomadServerClient {
  #cookies = new Map<string, string>()
  #login?: Promise<void>
  #controller = new AbortController()
  readonly #transport: ReturnType<typeof createExplicitTransport>

  constructor(readonly origin: string, private secret: CodeNomadServerSecret | undefined, private readonly options: {
    /** A refused credential (bad password, revoked device). */
    onRejected?: () => void
    /** A successful session/device cookie rotation to persist. */
    onSecretChanged?: (secret: CodeNomadServerSecret) => void
    resolve?: ResolveAddresses
    skipTlsVerify?: boolean
  } = {}) {
    if (secret?.cookie) for (const [name, value] of cookiePairs([secret.cookie])) this.#cookies.set(name, value)
    this.#transport = createExplicitTransport({
      origin, signal: this.#controller.signal,
      skipTlsVerify: options.skipTlsVerify,
      headers: (): Record<string, string> => (this.#cookies.size ? { cookie: [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ") } : {}),
      onSetCookie: values => this.capture(values),
    }, options.resolve)
  }

  private capture(values: string[]) {
    for (const [name, value] of cookiePairs(values)) {
      if (value) this.#cookies.set(name, value)
      else this.#cookies.delete(name)
    }
    if (this.secret) {
      const cookie = [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ")
      if (cookie && cookie !== this.secret.cookie) {
        this.secret = { ...this.secret, cookie }
        this.options.onSecretChanged?.(this.secret)
      }
    }
  }

  close() { this.#controller.abort() }
  get closed() { return this.#controller.signal.aborted }

  /** Password login; cookies and passwords stay in the backend's private store. */
  login(signal?: AbortSignal): Promise<void> {
    if (this.secret?.kind !== "password") return Promise.reject(new CodeNomadServerError("needs_credentials"))
    const secret = this.secret
    return this.#login ??= (async () => {
      const response = await this.#transport.fetch(new URL("/api/auth/login", this.origin), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: secret.username, password: secret.password }),
        signal: AbortSignal.any([AbortSignal.timeout(CALL_TIMEOUT_MS), ...(signal ? [signal] : [])]),
      })
      await response.body?.cancel().catch(() => {})
      if (response.status === 401 || response.status === 400) { this.options.onRejected?.(); throw new CodeNomadServerError("auth") }
      if (!response.ok) throw new CodeNomadServerError("unreachable")
    })().finally(() => { this.#login = undefined })
  }

  /** Authenticated call. A 401 means the remote did not process the request: log in again and retry once. */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, this.origin)
    if (url.origin !== this.origin) throw new CodeNomadServerError("unreachable")
    if (this.secret?.kind === "password" && !this.#cookies.size) await this.login(init.signal ?? undefined)
    let response = await this.#transport.fetch(url, init)
    if (response.status === 401 && this.secret?.kind === "password") {
      await response.body?.cancel().catch(() => {})
      this.#cookies.clear()
      await this.login(init.signal ?? undefined)
      response = await this.#transport.fetch(url, init)
    }
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {})
      this.options.onRejected?.()
      throw new CodeNomadServerError(this.secret ? "auth" : "needs_credentials")
    }
    return response
  }

  /** Bounded JSON read of a fixed backend route. */
  async json<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T | undefined }> {
    const signal = AbortSignal.any([AbortSignal.timeout(CALL_TIMEOUT_MS), ...(init.signal ? [init.signal] : [])])
    const response = await this.fetch(path, { ...init, signal })
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    if (reader) {
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          length += chunk.value.byteLength
          if (length > READ_LIMIT_BYTES) throw new CodeNomadServerError("unreachable")
          chunks.push(chunk.value)
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error }
    }
    let body: T | undefined
    try { body = length ? JSON.parse(Buffer.concat(chunks, length).toString("utf8")) as T : undefined } catch { body = undefined }
    return { status: response.status, body }
  }

}
