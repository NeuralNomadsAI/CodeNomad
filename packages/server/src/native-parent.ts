import { randomUUID } from "node:crypto"

export const NATIVE_REQUEST_PREFIX = "CODENOMAD_NATIVE_REQUEST:"
export const NATIVE_RESPONSE_PREFIX = "CODENOMAD_NATIVE_RESPONSE:"
const DEFAULT_TIMEOUT_MS = 90_000
const MAX_PENDING = 32

interface NativeResponse {
  v: 1
  id: string
  ok: boolean
  result?: unknown
  error?: { code?: string; message?: string }
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  expire(): void
  absoluteDeadline?: number
  timeout: NodeJS.Timeout
}

/** Admission was refused locally or by an explicit response from the host. */
export class NativeRequestRefused extends Error {}

/** The request was refused before it could reach the host. */
export class NativeRequestNotSent extends NativeRequestRefused {}

export class NativeParent {
  private readonly pending = new Map<string, PendingRequest>()
  private closed = false

  constructor(
    private readonly output: Pick<NodeJS.WriteStream, "write"> = process.stdout,
    readonly available = process.env.CODENOMAD_NATIVE_PARENT === "1",
    readonly browserAutomationUnavailable = process.env.CODENOMAD_NATIVE_BROWSER_AUTOMATION === "0",
  ) {}

  request<T>(method: string, params: unknown, budget: number | { deadline: number } = DEFAULT_TIMEOUT_MS): Promise<T> {
    if (!this.available) return Promise.reject(new NativeRequestNotSent("Native control is unavailable in this host"))
    if (this.closed) return Promise.reject(new NativeRequestNotSent("Native parent is shutting down"))
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new NativeRequestNotSent("Too many pending native requests"))

    const id = randomUUID()
    const deadline = typeof budget === "number" ? Date.now() + budget : budget.deadline
    const absoluteDeadline = typeof budget === "number" ? undefined : deadline
    return new Promise<T>((resolve, reject) => {
      const line = `${NATIVE_REQUEST_PREFIX}${JSON.stringify({ v: 1, id, method, params, deadline })}\n`
      const timeoutMs = typeof budget === "number" ? budget : deadline - Date.now()
      if (typeof budget !== "number" && timeoutMs <= 0) return reject(new NativeRequestNotSent("Native request expired before execution"))
      const expire = () => {
        this.pending.delete(id)
        reject(new Error(`Native request timed out: ${method}`))
      }
      const timeout = setTimeout(expire, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, expire, absoluteDeadline, timeout })
      this.output.write(line)
    })
  }

  handleLine(line: string): boolean {
    const trimmed = line.trim()
    if (!trimmed.startsWith(NATIVE_RESPONSE_PREFIX)) return false
    let response: NativeResponse
    try {
      response = JSON.parse(trimmed.slice(NATIVE_RESPONSE_PREFIX.length)) as NativeResponse
    } catch {
      return true
    }
    if (!response || response.v !== 1 || typeof response.id !== "string" || typeof response.ok !== "boolean") return true
    const pending = this.pending.get(response.id)
    if (!pending) return true
    clearTimeout(pending.timeout)
    if (pending.absoluteDeadline !== undefined && Date.now() >= pending.absoluteDeadline) {
      pending.expire()
      return true
    }
    this.pending.delete(response.id)
    if (response.ok) pending.resolve(response.result)
    else pending.reject(new NativeRequestRefused(response.error?.message || response.error?.code || "Native request failed"))
    return true
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error("Native parent is shutting down"))
    }
    this.pending.clear()
  }
}
