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
    const cause = (result as any).error
    const causeMsg = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : JSON.stringify(cause)
    throw new OpencodeApiError(`${label} failed: ${causeMsg}`, { cause })
  }
  return (result as any).data as T
}

export type { OpencodeClient }
