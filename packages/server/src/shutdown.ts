interface ShutdownLogger {
  info: (data: unknown, message?: string) => void
  warn: (data: unknown, message?: string) => void
  error: (data: unknown, message?: string) => void
}

export interface ServerShutdownOperations {
  stopInstanceEventBridge: () => void | Promise<void>
  stopSidecars: () => void | Promise<void>
  stopClientConnections: () => void | Promise<void>
  stopWorkspaces: () => void | Promise<void>
  stopHttpServers: () => void | Promise<void>
  stopReleaseMonitor: () => void | Promise<void>
}

export class ServerShutdownError extends Error {
  readonly failures: Array<{ resource: string; error: unknown }>

  constructor(failures: Array<{ resource: string; error: unknown }>) {
    super(`Server shutdown failed while stopping: ${failures.map((failure) => failure.resource).join(", ")}`)
    this.name = "ServerShutdownError"
    this.failures = failures
  }
}

export interface ServerShutdownHandlerOptions {
  shutdown: () => Promise<void>
  logger: ShutdownLogger
  forceExit?: (code: number) => void
  setExitCode?: (code: number) => void
}

export function createServerShutdownHandler(options: ServerShutdownHandlerOptions) {
  const forceExit = options.forceExit ?? ((code: number) => process.exit(code))
  const setExitCode = options.setExitCode ?? ((code: number) => {
    process.exitCode = code
  })
  let shutdownPromise: Promise<void> | undefined

  return (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownPromise) {
      options.logger.error({ signal }, "Additional shutdown signal received; forcing nonzero exit")
      forceExit(1)
      return shutdownPromise
    }

    options.logger.info({ signal }, "Received shutdown signal, stopping workspaces and server")
    shutdownPromise = (async () => {
      try {
        await options.shutdown()
        options.logger.info({}, "Shutdown complete")
        setExitCode(0)
      } catch (error) {
        options.logger.error({ err: error }, "Server shutdown incomplete; forcing nonzero exit")
        forceExit(1)
      }
    })()
    return shutdownPromise
  }
}

export async function orchestrateServerShutdown(
  operations: ServerShutdownOperations,
  logger: ShutdownLogger,
  workspaceAttempts = 2,
): Promise<void> {
  const failures: Array<{ resource: string; error: unknown }> = []
  const run = async (resource: string, operation: () => void | Promise<void>) => {
    try {
      await operation()
    } catch (error) {
      failures.push({ resource, error })
      logger.error({ err: error, resource }, `${resource} shutdown failed`)
    }
  }

  await run("Instance event bridge", operations.stopInstanceEventBridge)
  await run("SideCar manager", operations.stopSidecars)
  await run("Client connection manager", operations.stopClientConnections)

  const attempts = Math.max(1, Math.floor(workspaceAttempts))
  let workspaceFailure: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await operations.stopWorkspaces()
      workspaceFailure = undefined
      logger.info({ attempt }, "Workspace manager shutdown complete")
      break
    } catch (error) {
      workspaceFailure = error
      if (attempt < attempts) {
        logger.warn({ err: error, attempt, attempts }, "Workspace manager shutdown failed; retrying cleanup")
      }
    }
  }
  if (workspaceFailure !== undefined) {
    failures.push({ resource: "Workspace manager", error: workspaceFailure })
    logger.error({ err: workspaceFailure, attempts }, "Workspace manager shutdown failed")
  }

  await run("HTTP servers", operations.stopHttpServers)
  await run("Release monitor", operations.stopReleaseMonitor)

  if (failures.length > 0) {
    throw new ServerShutdownError(failures)
  }
}
