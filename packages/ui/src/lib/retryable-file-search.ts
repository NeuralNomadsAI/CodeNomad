export class HttpResponseError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter: string | null) {
    super(message)
  }
}

/** Retry only explicit admission failures, and only for the live picker query. */
export async function retryFileSearch<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  while (true) {
    signal.throwIfAborted()
    try { return await operation() }
    catch (error) {
      if (!(error instanceof HttpResponseError) || error.status !== 503 || !error.retryAfter) throw error
      const seconds = Number(error.retryAfter)
      if (!Number.isFinite(seconds) || seconds < 0) throw error
      const delayMs = Math.min(30_000, Math.max(1000, seconds * 1000))
      await new Promise<void>((resolve, reject) => {
        signal.throwIfAborted()
        const finish = () => { signal.removeEventListener("abort", abort); resolve() }
        const timer = setTimeout(finish, delayMs)
        const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason) }
        signal.addEventListener("abort", abort, { once: true })
      })
    }
  }
}
