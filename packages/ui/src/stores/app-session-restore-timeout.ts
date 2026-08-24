export class RestoreTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RestoreTimeoutError"
  }
}

export function getAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error("Restore operation was aborted")
  error.name = "AbortError"
  return error
}

export function runAbortable<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number; message?: string } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController()
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener("abort", handleParentAbort)
      callback()
    }
    const handleParentAbort = () => {
      const reason = getAbortReason(options.signal!)
      controller.abort(reason)
      finish(() => reject(reason))
    }
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      const error = new RestoreTimeoutError(options.message ?? "Operation timed out")
      controller.abort(error)
      finish(() => reject(error))
    }, options.timeoutMs)

    if (options.signal?.aborted) {
      handleParentAbort()
      return
    }
    options.signal?.addEventListener("abort", handleParentAbort, { once: true })

    Promise.resolve().then(() => operation(controller.signal)).then(
      (value) => {
        finish(() => resolve(value))
      },
      (error) => {
        finish(() => reject(error))
      },
    )
  })
}
