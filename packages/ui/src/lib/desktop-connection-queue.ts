/**
 * One `--connect-server` request the desktop host queued for this window. `failure` is a message
 * another window already produced, to show here; `deferFailure` marks the window opened only for
 * the connection, whose host reports failures in a normally started window instead.
 */
export interface PendingConnection {
  target: string
  failure?: string
  deferFailure?: boolean
}

export interface DesktopConnectionLaunchAPI {
  nextPendingConnection?: () => Promise<PendingConnection | null>
  acknowledgePendingConnection?: (target: string, failure: string | null) => Promise<unknown>
  onPendingConnections?: (callback: () => void) => () => void
}

export function installDesktopConnectionLaunchHandler(
  api: DesktopConnectionLaunchAPI | undefined,
  connect: (target: string) => Promise<void>,
  reportFailure: (message: string) => void,
  reportError: (error: unknown) => void,
): () => void {
  if (!api?.nextPendingConnection || !api.acknowledgePendingConnection || !api.onPendingConnections) return () => {}
  let disposed = false
  let draining = false
  let drainAgain = false
  const drain = async () => {
    if (draining) { drainAgain = true; return }
    draining = true
    try {
      do {
        drainAgain = false
        while (!disposed) {
          const pending = await api.nextPendingConnection!()
          if (!pending) break
          if (pending.failure) {
            reportFailure(pending.failure)
            await api.acknowledgePendingConnection!(pending.target, null)
            continue
          }
          let failure: string | null = null
          try {
            await connect(pending.target)
          } catch (error) {
            failure = error instanceof Error ? error.message : String(error)
            if (!pending.deferFailure) reportFailure(failure)
          }
          await api.acknowledgePendingConnection!(pending.target, failure)
        }
      } while (drainAgain && !disposed)
    } catch (error) { reportError(error) } finally {
      draining = false
    }
  }
  const unsubscribe = api.onPendingConnections(() => { void drain() })
  void drain()
  return () => { disposed = true; unsubscribe() }
}
