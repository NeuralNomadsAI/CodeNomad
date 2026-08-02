import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"

export class OpencodeApiError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = "OpencodeApiError"
    if (options && "cause" in options) {
      ;(this as any).cause = options.cause
    }
  }
}

export function getOpencodeErrorMessage(error: unknown, fallback: string): string {
  const seen = new Set<unknown>()

  const extract = (value: unknown): string | undefined => {
    if (typeof value === "string") return value.trim() || undefined
    if (!value || typeof value !== "object" || seen.has(value)) return undefined
    seen.add(value)

    const candidate = value as any
    const direct = [candidate.data?.message, candidate.body?.message, candidate.error]
      .find((item) => typeof item === "string" && item.trim())
    if (direct) return direct.trim()

    const nested = extract(candidate.cause) ?? extract(candidate.error) ?? extract(candidate.body)
    if (nested) return nested

    if (typeof candidate.message === "string" && candidate.message.trim()) return candidate.message.trim()
    return undefined
  }

  return extract(error) ?? fallback
}

export function isDeliveryAmbiguousError(error: unknown): boolean {
  const seen = new Set<unknown>()
  const pending = [error]
  while (pending.length > 0) {
    const value = pending.pop()
    if (!value || typeof value !== "object" || seen.has(value)) continue
    seen.add(value)
    const candidate = value as any
    const status = candidate.status ?? candidate.statusCode ?? candidate.response?.status
    if (typeof status === "number") {
      if (status >= 400 && status < 500 && status !== 408) return false
    }
    pending.push(candidate.cause, candidate.error, candidate.response)
  }
  // Once dispatch has started, unknown failures are ambiguous unless the server
  // returned a definitive client rejection.
  return true
}

type RequestResultLike<T> =
  | {
      data: T
      error?: undefined
      response?: { status?: number }
    }
  | {
      data?: undefined
      error: unknown
      response?: { status?: number }
    }

export async function requestData<T>(
  promise: Promise<RequestResultLike<T> | undefined>,
  label: string,
): Promise<T> {
  const result = await promise
  if (!result) {
    throw new OpencodeApiError(`${label} returned no result`)
  }
  if ((result as any).error) {
    const response = (result as any).response
    throw new OpencodeApiError(`${label} failed`, {
      cause: response ? { error: (result as any).error, response } : (result as any).error,
    })
  }
  return (result as any).data as T
}

export type { OpencodeClient }
