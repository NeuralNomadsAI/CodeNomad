interface StreamStalenessWatchdogOptions {
  thresholdMs?: number
  checkIntervalMs?: number
  now?: () => number
  setTimer?: typeof setInterval
  clearTimer?: typeof clearInterval
  onStale?: (reason: string) => void
}

/**
 * Detects a silently dead stream: while connected, a periodic check fires
 * `onStale` once per episode once no `activity()` arrived for `thresholdMs`.
 * `now`/`setTimer`/`clearTimer` are injectable so tests drive time manually;
 * by default the watchdog runs on real timers against the wall clock.
 */
export function createStreamStalenessWatchdog(options: StreamStalenessWatchdogOptions = {}) {
  const thresholdMs = options.thresholdMs ?? 45_000
  const checkIntervalMs = options.checkIntervalMs ?? 15_000
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? setInterval
  const clearTimer = options.clearTimer ?? clearInterval
  const onStale = options.onStale
  let lastActivityAt = now()
  let connected = false
  let timer: ReturnType<typeof setInterval> | undefined
  let staleEpisode = false
  let disposed = false

  const check = () => {
    if (disposed || !connected || staleEpisode) return
    if (now() - lastActivityAt < thresholdMs) return
    staleEpisode = true
    onStale?.("stream stale")
  }

  return {
    /** Records stream progress and clears any open stale episode. */
    activity() {
      lastActivityAt = now()
      staleEpisode = false
    },
    /** Gates evaluation on the connection; the interval exists only once ever connected. */
    setConnected(value: boolean) {
      if (disposed) return
      if (!value) {
        connected = false
        staleEpisode = false
        return
      }
      connected = true
      if (timer === undefined) timer = setTimer(check, checkIntervalMs)
    },
    stale() {
      return staleEpisode
    },
    dispose() {
      disposed = true
      if (timer === undefined) return
      clearTimer(timer)
      timer = undefined
    },
  }
}
