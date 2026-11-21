import type { WorkspaceEventTransportStatus } from "../event-transport"

interface ForegroundRefreshControllerOptions {
  signal?: AbortSignal
  retryDelaysMs?: readonly number[]
  onError?: (error: unknown) => void
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

export function createForegroundRefreshController(
  onRefresh: (signal: AbortSignal) => void | Promise<void>,
  options: ForegroundRefreshControllerOptions = {},
) {
  const retryDelaysMs = options.retryDelaysMs ?? [1_000, 3_000]
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimer = options.clearTimer ?? clearTimeout
  let connected = false
  let dirtyGeneration = 0
  let recoveredGeneration = 0
  let refreshInFlight = false
  let retryAttempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const lifetime = new AbortController()

  const cancelRetry = () => {
    if (retryTimer === undefined) return
    clearTimer(retryTimer)
    retryTimer = undefined
  }

  const runRefresh = async () => {
    if (disposed || !connected || refreshInFlight || recoveredGeneration >= dirtyGeneration) return
    const targetGeneration = dirtyGeneration
    refreshInFlight = true
    let succeeded = false
    try {
      await onRefresh(lifetime.signal)
      if (disposed) return
      recoveredGeneration = Math.max(recoveredGeneration, targetGeneration)
      retryAttempt = 0
      succeeded = true
    } catch (error) {
      if (!disposed) options.onError?.(error)
    } finally {
      refreshInFlight = false
    }

    if (disposed || !connected || recoveredGeneration >= dirtyGeneration) return
    if (succeeded) {
      void runRefresh()
      return
    }

    const delayMs = retryDelaysMs[retryAttempt]
    if (delayMs === undefined || retryTimer !== undefined) return
    retryAttempt += 1
    retryTimer = setTimer(() => {
      retryTimer = undefined
      void runRefresh()
    }, delayMs)
  }

  const dispose = () => {
    disposed = true
    lifetime.abort()
    cancelRetry()
    options.signal?.removeEventListener("abort", dispose)
  }
  options.signal?.addEventListener("abort", dispose, { once: true })
  if (options.signal?.aborted) dispose()

  return {
    invalidate() {
      dirtyGeneration += 1
      void runRefresh()
    },
    handle(status: WorkspaceEventTransportStatus) {
      if (disposed) return
      if (status === "disconnected") {
        connected = false
        dirtyGeneration += 1
        retryAttempt = 0
        cancelRetry()
        return
      }
      if (status !== "connected") return

      connected = true
      cancelRetry()
      void runRefresh()
    },
    dispose,
  }
}
