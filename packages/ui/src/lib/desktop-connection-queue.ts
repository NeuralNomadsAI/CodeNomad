/**
 * One `--connect-server` request the desktop host queued for this window. `failure` is a message
 * another window already produced, to show here; `hidden` marks the hidden window the host opened
 * only for the connection: it never prompts or shows errors, and hands both back to the host.
 */
export interface PendingConnection {
  target: string
  failure?: string
  hidden?: boolean
}

export interface DesktopConnectionLaunchAPI {
  nextPendingConnection?: () => Promise<PendingConnection | null>
  acknowledgePendingConnection?: (target: string, failure: string | null, handOff: boolean) => Promise<unknown>
  onPendingConnections?: (callback: () => void) => () => void
}

/** The connection needs the user (a certificate prompt); a hidden window cannot ask. */
export class InteractionRequiredError extends Error {
  constructor() {
    super("This connection needs a visible window")
    this.name = "InteractionRequiredError"
  }
}

/** A failure's message without Electron's `Error invoking remote method '…': Error:` IPC wrapper. */
export function connectionFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "")
}

export function installDesktopConnectionLaunchHandler(
  api: DesktopConnectionLaunchAPI | undefined,
  connect: (target: string, options: { interactive: boolean }) => Promise<void>,
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
            await api.acknowledgePendingConnection!(pending.target, null, false)
            continue
          }
          const hidden = pending.hidden === true
          let failure: string | null = null
          let handOff = false
          try {
            await connect(pending.target, { interactive: !hidden })
          } catch (error) {
            if (hidden && error instanceof InteractionRequiredError) handOff = true
            else {
              failure = connectionFailureMessage(error)
              if (!hidden) reportFailure(failure)
            }
          }
          await api.acknowledgePendingConnection!(pending.target, failure, handOff)
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
