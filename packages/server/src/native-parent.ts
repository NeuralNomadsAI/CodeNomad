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
  timeout: NodeJS.Timeout
}

export class NativeParent {
  private readonly pending = new Map<string, PendingRequest>()
  private closed = false

  constructor(
    private readonly output: Pick<NodeJS.WriteStream, "write"> = process.stdout,
    readonly available = process.env.CODENOMAD_NATIVE_PARENT === "1",
  ) {}

  request<T>(method: string, params: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    if (!this.available) return Promise.reject(new Error("Native control is unavailable in this host"))
    if (this.closed) return Promise.reject(new Error("Native parent is shutting down"))
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new Error("Too many pending native requests"))

    const id = randomUUID()
    const deadline = Date.now() + timeoutMs
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Native request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout })
      this.output.write(`${NATIVE_REQUEST_PREFIX}${JSON.stringify({ v: 1, id, method, params, deadline })}\n`)
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
    if (response.v !== 1 || typeof response.id !== "string") return true
    const pending = this.pending.get(response.id)
    if (!pending) return true
    this.pending.delete(response.id)
    clearTimeout(pending.timeout)
    if (response.ok) pending.resolve(response.result)
    else pending.reject(new Error(response.error?.message || response.error?.code || "Native request failed"))
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
