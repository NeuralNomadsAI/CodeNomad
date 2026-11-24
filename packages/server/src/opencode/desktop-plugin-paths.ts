import path from "node:path"
import { createHash } from "node:crypto"
import type { ServiceConnection } from "../workspaces/opencode-service"
import type { ServiceLaunchSpec } from "../workspaces/spawn"
import type { DesktopPluginPaths } from "./desktop-plugin-installation"
import { assertNativePluginPath, resolveDesktopPluginWslPath, type WslPathExecutor } from "./desktop-plugin-wsl-paths"

// Native config.get returns discovery sources in precedence order. The first
// directory is the global discovery root, including OPENCODE_CONFIG_DIR when
// set in the *running daemon*. CLI debug paths describes the caller instead.
export async function resolveDesktopPluginPaths(
  connection: Pick<ServiceConnection, "client" | "assertCurrent">,
  launch: ServiceLaunchSpec,
  deadlineAt = Date.now() + 15_000,
  executeWslPath?: WslPathExecutor,
): Promise<DesktopPluginPaths> {
  if (deadlineAt <= Date.now()) throw new Error("Desktop plugin path resolution timed out")
  const entries: unknown = await connection.client.config.get(undefined, {
    signal: AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())),
  })
  connection.assertCurrent()
  if (deadlineAt <= Date.now()) throw new Error("Desktop plugin path resolution timed out")
  const directory = Array.isArray(entries)
    ? entries.find(entry => entry?.type === "directory")?.path
    : undefined
  const paths = launch.kind === "wsl" || launch.platform !== "win32" ? path.posix : path.win32
  if (typeof directory !== "string" || !paths.isAbsolute(directory) || directory.includes("\0")) {
    throw new Error("Connected OpenCode daemon did not report an absolute global plugin discovery directory")
  }
  if (launch.kind === "wsl") assertNativePluginPath(directory)
  let config = paths.normalize(directory)
  if (paths.dirname(config) === config) throw new Error("OpenCode discovery root has no unwatched parent")
  const resolveNativePath = launch.kind === "wsl"
    ? (directory: string, assertCurrent: () => void) => resolveDesktopPluginWslPath(directory, launch.distro, deadlineAt, assertCurrent, executeWslPath)
    : undefined
  const resolvedConfig = await resolveNativePath?.(config, connection.assertCurrent)
  connection.assertCurrent()
  if (resolvedConfig) config = resolvedConfig.native
  // OpenCode recursively watches the entire discovery root, not just plugins/.
  // A lease heartbeat inside it reloads configuration in every loaded location.
  // Derive a sibling namespace from the authenticated root, never our process's
  // environment. The hash keeps distinct discovery roots independent.
  if (paths.dirname(config) === config) throw new Error("OpenCode discovery root has no unwatched parent")
  const identity = launch.kind !== "wsl" && launch.platform === "win32" ? config.toLowerCase() : config
  const namespace = createHash("sha256").update(identity).digest("hex")
  const data = paths.join(paths.dirname(config), ".codenomad", namespace)
  if (launch.kind !== "wsl") return { config, data }
  const resolvedData = await resolveNativePath!(data, connection.assertCurrent)
  connection.assertCurrent()
  const relative = path.posix.relative(config, resolvedData.native)
  if (!relative || (!relative.startsWith("../") && relative !== ".." && !path.posix.isAbsolute(relative))) {
    throw new Error("OpenCode plugin storage must stay outside the discovery root")
  }
  return { config: resolvedConfig!.host, data: resolvedData.host, nativeData: resolvedData.native, resolveNativePath }
}
