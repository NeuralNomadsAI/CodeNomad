export type RestoreActivity = () => boolean
export type RestoreOperation<T> = (signal: AbortSignal) => Promise<T>

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

export async function awaitRestoreStep<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  if (signal.aborted) throw getAbortReason(signal)

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", handleAbort)
      callback()
    }
    const handleAbort = () => finish(() => reject(getAbortReason(signal)))
    signal.addEventListener("abort", handleAbort, { once: true })
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
}

export function withRestoreTimeout<T>(
  operation: RestoreOperation<T>,
  timeoutMs: number,
  message: string,
  parentSignal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController()
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      parentSignal?.removeEventListener("abort", handleParentAbort)
      callback()
    }
    const handleParentAbort = () => {
      const reason = getAbortReason(parentSignal!)
      controller.abort(reason)
      finish(() => reject(reason))
    }
    const timer = setTimeout(() => {
      const error = new RestoreTimeoutError(message)
      controller.abort(error)
      finish(() => reject(error))
    }, timeoutMs)

    if (parentSignal?.aborted) {
      handleParentAbort()
      return
    }
    parentSignal?.addEventListener("abort", handleParentAbort, { once: true })

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

export async function runWithRestoreDeadline<T>(
  operation: (isActive: RestoreActivity, signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return withRestoreTimeout(
    (signal) => operation(() => !signal.aborted, signal),
    timeoutMs,
    message,
  )
}
