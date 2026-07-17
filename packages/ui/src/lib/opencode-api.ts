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

type RequestResultLike<T> =
  | {
      data: T
      error?: undefined
    }
  | {
      data?: undefined
      error: unknown
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
    throw new OpencodeApiError(`${label} failed`, { cause: (result as any).error })
  }
  return (result as any).data as T
}

export type { OpencodeClient }
