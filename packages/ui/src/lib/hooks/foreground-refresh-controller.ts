import type { WorkspaceEventTransportStatus } from "../event-transport"

interface ForegroundRefreshControllerOptions {
  retryDelaysMs?: readonly number[]
  onError?: (error: unknown) => void
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

export function createForegroundRefreshController(
  onRefresh: () => void | Promise<void>,
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
      await onRefresh()
      recoveredGeneration = Math.max(recoveredGeneration, targetGeneration)
      retryAttempt = 0
      succeeded = true
    } catch (error) {
      options.onError?.(error)
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

  return {
    invalidate() {
      dirtyGeneration += 1
      void runRefresh()
    },
    handle(status: WorkspaceEventTransportStatus) {
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
    dispose() {
      disposed = true
      cancelRetry()
    },
  }
}
