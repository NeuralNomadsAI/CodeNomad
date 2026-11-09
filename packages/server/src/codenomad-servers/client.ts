import { hostname } from "node:os"
import { z } from "zod"
import { createExplicitTransport } from "../opencode/servers/transport"
import { ExplicitEndpointError, type ResolveAddresses } from "../opencode/servers/endpoint"
import type { CodeNomadServerSecret } from "./credentials"
import { SERVER_PAIR_PATH } from "../remote-control/server-pairing"
import { DEVICE_COOKIE_NAME } from "../remote-control/gate"

export type CodeNomadServerErrorCode = "unreachable" | "tls_error" | "auth" | "pairing_unavailable" | "pairing_expired" | "pairing_rate_limited" | "needs_credentials" | "unknown_server"

/** Stable codes only; never a URL, credential or upstream message. */
export class CodeNomadServerError extends Error {
  constructor(readonly code: CodeNomadServerErrorCode) {
    super(code)
    this.name = "CodeNomadServerError"
  }
}

const READ_LIMIT_BYTES = 8 * 1024 * 1024
const CALL_TIMEOUT_MS = 10_000
const AuthStatus = z.object({ authenticated: z.boolean(), pairingRequired: z.boolean().optional(),
  username: z.string().optional(), passwordUserProvided: z.boolean().optional(),
}).strict().refine(value => !(value.authenticated && value.pairingRequired)
  && (value.username === undefined) === (value.passwordUserProvided === undefined)
  && (value.authenticated || value.username === undefined))
type Status = z.infer<typeof AuthStatus>
type AuthFlight = { controller: AbortController; signal: AbortSignal; timer: ReturnType<typeof setTimeout>;
  users: number; loginUsed: boolean; rejected: boolean; observation?: Promise<Status>; restoration?: Promise<void> }
type AuthMode = "observe-status"

/** A follower owns its wait, never the shared exchange's cancellation. */
function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new CodeNomadServerError("unreachable"))
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
    if (signal.aborted) { abort(); return }
    signal.addEventListener("abort", abort, { once: true })
  })
}
const PairResponse = z.object({
  device: z.object({ id: z.string().uuid(), name: z.string().min(1).max(80), createdAt: z.string().datetime(), lastSeenAt: z.string().datetime() }).strict(),
  credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict()

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

/** One authenticated client per saved CodeNomad profile. */
export class CodeNomadServerClient {
  #cookies = new Map<string, string>()
  #login?: Promise<void>
  #loginController?: AbortController
  #authFlight?: AuthFlight
  #controller = new AbortController()
  readonly #signal: AbortSignal
  readonly #transport: ReturnType<typeof createExplicitTransport>

  constructor(readonly origin: string, private secret: CodeNomadServerSecret | undefined, private readonly options: {
    /** A refused credential (bad password, revoked device). */
    onRejected?: () => void
    /** A successful session/device cookie rotation to persist. */
    onSecretChanged?: (secret: CodeNomadServerSecret) => void
    resolve?: ResolveAddresses
    skipTlsVerify?: boolean
    signal?: AbortSignal
  } = {}) {
    this.#signal = options.signal ? AbortSignal.any([this.#controller.signal, options.signal]) : this.#controller.signal
    if (secret?.cookie) for (const [name, value] of cookiePairs([secret.cookie])) this.#cookies.set(name, value)
    this.#transport = createExplicitTransport({
      origin, signal: this.#signal,
      omitFetchMetadata: true,
      skipTlsVerify: options.skipTlsVerify,
      headers: (): Record<string, string> => ({ ...(this.#cookies.size ? { cookie: [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ") } : {}),
        ...(this.secret?.kind === "device" ? { "x-codenomad-server-request": "1" } : {}) }),
      onSetCookie: values => this.capture(values),
    }, options.resolve)
  }

  private capture(values: string[]) {
    if (this.closed || this.secret?.kind === "device") return
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
  get closed() { return this.#signal.aborted }

  /** A fresh, cookie-free exchange; the code is never retained by the client. */
  async pair(code: string): Promise<CodeNomadServerSecret> {
    const transport = createExplicitTransport({ origin: this.origin, signal: this.#signal,
      skipTlsVerify: this.options.skipTlsVerify, omitFetchMetadata: true }, this.options.resolve)
    const response = await transport.fetch(new URL(SERVER_PAIR_PATH, this.origin), {
      method: "POST", headers: { "content-type": "application/json", "x-codenomad-server-pairing": "1" },
      body: JSON.stringify({ code, hostName: hostname().slice(0, 255) }), signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    })
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {})
      throw new CodeNomadServerError([403, 404, 405].includes(response.status) ? "pairing_unavailable"
        : [400, 401, 410].includes(response.status) ? "pairing_expired" : response.status === 429 ? "pairing_rate_limited" : "unreachable")
    }
    if (!/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) {
      await response.body?.cancel().catch(() => {})
      throw new CodeNomadServerError("unreachable")
    }
    const parsed = PairResponse.safeParse(await readJson(response, 4096))
    if (!parsed.success) throw new CodeNomadServerError("unreachable")
    const cookie = `${DEVICE_COOKIE_NAME}=${parsed.data.credential}`
    this.#cookies.clear()
    this.#cookies.set(DEVICE_COOKIE_NAME, parsed.data.credential)
    return this.secret = { kind: "device", cookie }
  }

  /** Password login; cookies and passwords stay in the backend's private store. */
  login(signal?: AbortSignal, destructive = true): Promise<void> {
    if (this.secret?.kind !== "password") return Promise.reject(new CodeNomadServerError("needs_credentials"))
    if (this.#login) return this.#login
    const controller = this.#loginController = new AbortController()
    const secret = this.secret
    return this.#login ??= (async () => {
      const response = await this.#transport.fetch(new URL("/api/auth/login", this.origin), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: secret.username, password: secret.password }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(CALL_TIMEOUT_MS), ...(signal ? [signal] : [])]),
      })
      void response.body?.cancel().catch(() => {})
      if (response.status === 401 || response.status === 400) { if (destructive) this.options.onRejected?.(); throw new CodeNomadServerError("auth") }
      if (!response.ok) throw new CodeNomadServerError("unreachable")
    })().finally(() => { this.#login = undefined; this.#loginController = undefined })
  }

  private acquireAuth() {
    let flight = this.#authFlight
    if (!flight || flight.signal.aborted) {
      const controller = new AbortController()
      flight = { controller, signal: AbortSignal.any([this.#signal, controller.signal]), users: 0,
        loginUsed: false, rejected: false, timer: setTimeout(() => controller.abort(), 8000) }
      this.#authFlight = flight
    }
    flight.users++
    const owned = flight
    return { flight, release: () => {
      if (--owned.users) return
      clearTimeout(owned.timer)
      owned.controller.abort()
      if (this.#authFlight === owned) this.#authFlight = undefined
    } }
  }

  private async restore(flight: AuthFlight) {
    flight.signal.throwIfAborted()
    if (flight.restoration) return flight.restoration
    flight.loginUsed = true
    const login = this.login(flight.signal, false)
    const controller = this.#loginController!
    const abort = () => controller.abort()
    flight.signal.addEventListener("abort", abort, { once: true })
    return flight.restoration = waitFor(login, flight.signal).finally(() => flight.signal.removeEventListener("abort", abort))
  }

  private observe(flight: AuthFlight): Promise<Status> {
    // Publish the flight before dispatch, including direct status followers.
    return flight.observation ??= Promise.resolve().then(async () => {
      const status = async () => {
        flight.signal.throwIfAborted()
        const response = await this.#transport.fetch(new URL("/api/auth/status", this.origin), { signal: flight.signal, cache: "no-store" })
        if (response.status !== 200 || !/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(response.headers.get("content-type") ?? "")) {
          void response.body?.cancel().catch(() => {})
          throw new CodeNomadServerError("unreachable")
        }
        return readStatus(response)
      }
      // A login already owned by this client consumes the episode's single quota.
      if (this.#login && !flight.loginUsed) {
        try { await this.restore(flight) }
        catch (error) {
          if (error instanceof CodeNomadServerError && error.code === "auth") return { authenticated: false }
          throw error
        }
      }
      const loginBeforeStatus = flight.loginUsed
      let result = await status()
      if (!result.authenticated && !loginBeforeStatus && flight.loginUsed) {
        await flight.restoration
        result = await status()
      }
      if (!result.authenticated && !result.pairingRequired && this.secret?.kind === "password" && !flight.loginUsed) {
        try { await this.restore(flight) }
        catch (error) {
          if (error instanceof CodeNomadServerError && error.code === "auth") return { authenticated: false }
          throw error
        }
        result = await status()
      }
      return result
    })
  }

  private rejectAuth(flight: AuthFlight) {
    if (flight.rejected || flight.signal.aborted || this.#authFlight !== flight) return
    flight.rejected = true
    this.options.onRejected?.()
  }

  private async observedFetch(path: string, init: RequestInit): Promise<Response> {
    const direct = new URL(path, this.origin).pathname === "/api/auth/status" && (init.method ?? "GET") === "GET"
    const signal = init.signal ? AbortSignal.any([this.#signal, init.signal]) : this.#signal
    signal.throwIfAborted()
    const lease = this.acquireAuth()
    try {
      if (!direct && this.secret?.kind === "password" && !this.#cookies.size) {
        const flight = lease.flight
        if (!flight.loginUsed) {
          try { await waitFor(this.restore(flight), AbortSignal.any([signal, flight.signal])) }
          catch (error) {
            if (!signal.aborted && error instanceof CodeNomadServerError && error.code === "auth") this.rejectAuth(flight)
            throw error
          }
        } else if (flight.restoration) await waitFor(flight.restoration, AbortSignal.any([signal, flight.signal]))
      }
      const response = direct ? undefined : await this.#transport.fetch(new URL(path, this.origin), init)
      if (response && response.status !== 401) return response
      const flight = lease.flight
      let result: Status
      try { result = await waitFor(this.observe(flight), AbortSignal.any([signal, flight.signal])) }
      catch (error) { signal.throwIfAborted(); if (response && !this.closed) return response; throw error }
      init.signal?.throwIfAborted()
      if (this.closed && !flight.rejected) throw new CodeNomadServerError("unreachable")
      if (!result.authenticated) {
        this.rejectAuth(flight)
        if (response) throw new CodeNomadServerError(this.secret ? "auth" : "needs_credentials")
      }
      return response ?? Response.json(result)
    } finally { lease.release() }
  }

  /** Legacy recovery or per-call status observation; opted-in business calls are never replayed. */
  async fetch(path: string, init: RequestInit = {}, mode?: AuthMode): Promise<Response> {
    const url = new URL(path, this.origin)
    if (url.origin !== this.origin) throw new CodeNomadServerError("unreachable")
    if (mode === "observe-status") return this.observedFetch(path, init)
    if (this.secret?.kind === "password" && !this.#cookies.size) await this.login(init.signal ?? undefined)
    let response = await this.#transport.fetch(url, init)
    if (response.status === 401 && this.secret?.kind === "password" && !init.body) {
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
  async json<T>(path: string, init: RequestInit = {}, mode?: AuthMode): Promise<{ status: number; body: T | undefined }> {
    const signal = AbortSignal.any([AbortSignal.timeout(CALL_TIMEOUT_MS), ...(init.signal ? [init.signal] : [])])
    const response = await this.fetch(path, { ...init, signal }, mode)
    return { status: response.status, body: await readJson(response, READ_LIMIT_BYTES) as T | undefined }
  }

}

async function readStatus(response: Response): Promise<Status> {
  const reader = response.body?.getReader()
  if (!reader) throw new CodeNomadServerError("unreachable")
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let bytes = 0, text = ""
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 4096) throw new CodeNomadServerError("unreachable")
      text += decoder.decode(chunk.value, { stream: true })
    }
    return AuthStatus.parse(JSON.parse(text + decoder.decode()))
  } catch (error) { void reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
}

async function readJson(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        length += chunk.value.byteLength
        if (length > limit) throw new CodeNomadServerError("unreachable")
        chunks.push(chunk.value)
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error }
  }
  try { return length ? JSON.parse(Buffer.concat(chunks, length).toString("utf8")) : undefined } catch { return undefined }
}
