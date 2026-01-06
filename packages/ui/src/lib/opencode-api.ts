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
    throw new OpencodeApiError(`${label} failed`, { cause: (result as any).error })
  }
  return (result as any).data as T
}

export type { OpencodeClient }
