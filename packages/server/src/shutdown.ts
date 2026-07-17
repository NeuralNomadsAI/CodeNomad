type ShutdownLogger = Pick<import("./logger").Logger, "info" | "warn" | "error">
type ShutdownOperation = () => void | Promise<void>

export type ServerShutdownTrigger = NodeJS.Signals | "stdin"
export const SERVER_SHUTDOWN_COMPLETE = "CODENOMAD_SHUTDOWN_STATUS:complete"
export const SERVER_SHUTDOWN_INCOMPLETE = "CODENOMAD_SHUTDOWN_STATUS:incomplete"

export type ServerShutdownOperations = Record<
  "stopInstanceEventBridge" | "stopSidecars" | "stopClientConnections" | "stopRemoteProxySessions" | "stopWorkspaces" |
  "stopHttpServers" | "stopReleaseMonitor",
  ShutdownOperation
>

export function createServerShutdownHandler(options: { shutdown: () => Promise<void>; logger: ShutdownLogger;
  forceExit?: (code: number) => void; setExitCode?: (code: number) => void;
  reportStatus?: (status: string) => void; holdAfterFailure?: () => Promise<void>;
  retryDelayMs?: number; retryAttempts?: number }) {
  const forceExit = options.forceExit ?? process.exit
  const setExitCode = options.setExitCode ?? ((code: number) => { process.exitCode = code })
  const reportStatus = options.reportStatus ?? ((status: string) => console.log(status))
  let pending: Promise<void> | undefined
  return (signal: ServerShutdownTrigger): Promise<void> => {
    if (pending) {
      options.logger.error({ signal }, "Additional shutdown signal received; forcing nonzero exit")
      forceExit(1)
      return pending
    }
    options.logger.info({ signal }, "Received shutdown signal, stopping workspaces and server")
    pending = Promise.resolve().then(options.shutdown).then(() => {
      options.logger.info({}, "Shutdown complete")
      reportStatus(SERVER_SHUTDOWN_COMPLETE)
      setExitCode(0)
    }, async (error) => {
      options.logger.error({ err: error }, "Server shutdown incomplete; awaiting final process-tree enforcement")
      reportStatus(SERVER_SHUTDOWN_INCOMPLETE)
      const retryAttempts = Math.max(0, Math.floor(options.retryAttempts ?? 3))
      for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, options.retryDelayMs ?? 250))
        try {
          await options.shutdown()
          options.logger.info({}, "Shutdown cleanup retry completed")
          reportStatus(SERVER_SHUTDOWN_COMPLETE)
          setExitCode(0)
          return
        } catch (retryError) {
          options.logger.warn({ err: retryError, attempt, attempts: retryAttempts }, "Shutdown cleanup retry remains incomplete")
        }
      }
      options.logger.error({ attempts: retryAttempts }, "Shutdown cleanup retries exhausted; preserving process-tree containment")
      setExitCode(1)
      if (options.holdAfterFailure) await options.holdAfterFailure()
    })
    return pending
  }
}

export async function orchestrateServerShutdown(
  operations: ServerShutdownOperations,
  logger: ShutdownLogger,
  workspaceAttempts = 2,
): Promise<void> {
  const errors: unknown[] = []
  const namedError = (name: keyof ServerShutdownOperations, cause: unknown) => Object.assign(
    new Error(`${name} failed: ${cause instanceof Error ? cause.message : String(cause)}`),
    { cause },
  )
  const settle = async (pending: Array<[keyof ServerShutdownOperations, ShutdownOperation]>) => {
    const results = await Promise.allSettled(pending.map(([, run]) => Promise.resolve().then(run)))
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index]!
      if (result.status !== "rejected") continue
      const error = namedError(pending[index]![0], result.reason)
      errors.push(error)
      logger.error({ err: error }, "Server resource shutdown failed")
    }
  }

  const workspaceShutdown = (async () => {
    const attempts = Math.max(1, Math.floor(workspaceAttempts))
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const [result] = await Promise.allSettled([Promise.resolve().then(operations.stopWorkspaces)])
      if (result.status === "fulfilled") break
      if (attempt < attempts) {
        logger.warn({ err: result.reason, attempt, attempts }, "Workspace manager shutdown failed; retrying cleanup")
        continue
      }
      const error = namedError("stopWorkspaces", result.reason)
      errors.push(error)
      logger.error({ err: error, attempts }, "Workspace manager shutdown failed")
    }
  })()
  await Promise.all([
    settle([
      ["stopInstanceEventBridge", operations.stopInstanceEventBridge], ["stopSidecars", operations.stopSidecars],
      ["stopClientConnections", operations.stopClientConnections], ["stopRemoteProxySessions", operations.stopRemoteProxySessions],
    ]),
    workspaceShutdown,
  ])
  await settle([["stopHttpServers", operations.stopHttpServers], ["stopReleaseMonitor", operations.stopReleaseMonitor]])
  if (errors.length) throw new AggregateError(errors, "Server shutdown failed")
}
