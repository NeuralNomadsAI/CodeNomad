import type { Logger } from "../logger"

interface DesktopPluginProvisioning<Paths> {
  connection: { assertCurrent(): void }
  resolvePaths: () => Promise<Paths>
  install: (paths: Paths) => Promise<void>
  logger: Pick<Logger, "debug" | "error">
}

/**
 * Provisions the bundled plugins for one OpenCode connection. Replacing a
 * connection aborts its in-flight requests (`OpenCodeSharedService.clear`), so a
 * failure on a connection that is no longer current is not an error: the newer
 * connection provisions again. Only a failure on the current one is reported.
 */
export async function provisionDesktopPlugins<Paths>(options: DesktopPluginProvisioning<Paths>): Promise<boolean> {
  const report = (error: unknown, message: string) => {
    let current = true
    try { options.connection.assertCurrent() } catch { current = false }
    if (current) options.logger.error({ err: error }, message)
    else options.logger.debug({ err: error }, "Bundled plugin provisioning was superseded by a newer OpenCode connection")
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
    return true
  } catch (error) {
    report(error, "Failed to provision bundled desktop plugins for the current connection")
    return false
  }
}
