type ShutdownLogger = Pick<import("./logger").Logger, "info" | "warn" | "error">
type ShutdownOperation = () => void | Promise<void>

export type ServerShutdownOperations = Record<
  "stopInstanceEventBridge" | "stopSidecars" | "stopClientConnections" | "stopRemoteProxySessions" | "stopWorkspaces" |
  "stopHttpServers" | "stopReleaseMonitor",
  ShutdownOperation
>

export function createServerShutdownHandler(options: { shutdown: () => Promise<void>; logger: ShutdownLogger;
  forceExit?: (code: number) => void; setExitCode?: (code: number) => void }) {
  const forceExit = options.forceExit ?? process.exit
  const setExitCode = options.setExitCode ?? ((code: number) => { process.exitCode = code })
  let pending: Promise<void> | undefined
  return (signal: NodeJS.Signals): Promise<void> => {
    if (pending) {
      options.logger.error({ signal }, "Additional shutdown signal received; forcing nonzero exit")
      forceExit(1)
      return pending
    }
    options.logger.info({ signal }, "Received shutdown signal, stopping workspaces and server")
    pending = Promise.resolve().then(options.shutdown).then(() => {
      options.logger.info({}, "Shutdown complete")
      setExitCode(0)
    }, (error) => {
      options.logger.error({ err: error }, "Server shutdown incomplete; forcing nonzero exit")
      forceExit(1)
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

  await settle([
    ["stopInstanceEventBridge", operations.stopInstanceEventBridge], ["stopSidecars", operations.stopSidecars],
    ["stopClientConnections", operations.stopClientConnections], ["stopRemoteProxySessions", operations.stopRemoteProxySessions],
  ])
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
  await settle([["stopHttpServers", operations.stopHttpServers], ["stopReleaseMonitor", operations.stopReleaseMonitor]])
  if (errors.length) throw new AggregateError(errors, "Server shutdown failed")
}
