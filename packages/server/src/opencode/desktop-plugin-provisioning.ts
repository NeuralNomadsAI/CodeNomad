import type { Logger } from "../logger"

interface DesktopPluginProvisioning<Paths> {
  connection: { assertCurrent(): void }
  resolvePaths: () => Promise<Paths>
  install: (paths: Paths) => Promise<void>
  logger: Pick<Logger, "debug" | "error">
  /** Failures already logged as errors, shared by every connection of one server. */
  reported?: Set<string>
}

const CONSEQUENCE = "Until this succeeds, CodeNomad cannot list questions and permissions that were already waiting, "
  + "and Missions and automation are unavailable. Each new OpenCode connection retries; identical failures are logged once."

/**
 * Provisions the bundled plugins for one OpenCode connection. Replacing a
 * connection aborts its in-flight requests (`OpenCodeSharedService.clear`), so a
 * failure on a connection that is no longer current is not an error: the newer
 * connection provisions again. Only a failure on the current one is reported, as
 * an error the first time and at debug level while it repeats; a success re-arms it.
 */
export async function provisionDesktopPlugins<Paths>(options: DesktopPluginProvisioning<Paths>): Promise<boolean> {
  const report = (error: unknown, message: string) => {
    let current = true
    try { options.connection.assertCurrent() } catch { current = false }
    if (!current) {
      options.logger.debug({ err: error }, "Bundled plugin provisioning was superseded by a newer OpenCode connection")
      return
    }
    const key = `${message}\n${error instanceof Error ? error.message : String(error)}`
    if (options.reported?.has(key)) {
      options.logger.debug({ err: error }, `${message} (repeated)`)
      return
    }
    options.reported?.add(key)
    options.logger.error({ err: error }, `${message}. ${CONSEQUENCE}`)
  }
  let paths: Paths
  try {
    paths = await options.resolvePaths()
  } catch (error) {
    report(error, "Cannot provision bundled plugins without the connected daemon's discovery directory")
    return false
  }
  try {
    await options.install(paths)
    options.reported?.clear()
    return true
  } catch (error) {
    report(error, "Failed to provision bundled desktop plugins for the current connection")
    return false
  }
}
