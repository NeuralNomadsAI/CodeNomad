import { randomUUID } from "node:crypto"
import { ATTACHMENT_REQUEST_ID_PREFIX, nativeResponseId, nativeResponseLimit, NATIVE_RESPONSE_PREFIX } from "./native-response"
export { NATIVE_RESPONSE_PREFIX } from "./native-response"

export const NATIVE_REQUEST_PREFIX = "CODENOMAD_NATIVE_REQUEST:"
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
  expiresAt: number
  method: string
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

    const attachment = method === "projects.attachments.read" || method === "projects.attachments.current"
    const id = `${attachment ? ATTACHMENT_REQUEST_ID_PREFIX : ""}${randomUUID()}`
    const deadline = Date.now() + timeoutMs
    const expiresAt = performance.now() + timeoutMs
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Native request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout, expiresAt, method })
      this.output.write(`${NATIVE_REQUEST_PREFIX}${JSON.stringify({ v: 1, id, method, params, deadline })}\n`)
    })
  }

  handleLine(line: string): boolean {
    const trimmed = line.trim()
    if (!trimmed.startsWith(NATIVE_RESPONSE_PREFIX)) return false
    const id = nativeResponseId(trimmed)
    if (!id) return true
    const pending = this.pending.get(id)
    if (!pending) return true
    if (performance.now() >= pending.expiresAt) { this.expire(id, pending); return true }
    if (Buffer.byteLength(trimmed) > nativeResponseLimit(id)) { this.rejectResponse(id); return true }
    let response: NativeResponse
    try {
      response = JSON.parse(trimmed.slice(NATIVE_RESPONSE_PREFIX.length)) as NativeResponse
    } catch {
      return true
    }
    if (!response || response.v !== 1 || response.id !== id || this.pending.get(id) !== pending) return true
    if (performance.now() >= pending.expiresAt) { this.expire(id, pending); return true }
    this.pending.delete(id)
    clearTimeout(pending.timeout)
    if (response.ok) pending.resolve(response.result)
    else pending.reject(new Error(response.error?.message || response.error?.code || "Native request failed"))
    return true
  }

  rejectResponse(id: string): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timeout)
    pending.reject(new Error("Native response unavailable"))
  }

  private expire(id: string, pending: PendingRequest): void {
    this.pending.delete(id)
    clearTimeout(pending.timeout)
    pending.reject(new Error(`Native request timed out: ${pending.method}`))
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
