import path from "node:path"
import { createHash } from "node:crypto"
import type { ServiceConnection } from "../workspaces/opencode-service"
import type { ServiceLaunchSpec } from "../workspaces/spawn"
import type { DesktopPluginPaths } from "./desktop-plugin-installation"

// Native config.get returns discovery sources in precedence order. The first
// directory is the global discovery root, including OPENCODE_CONFIG_DIR when
// set in the *running daemon*. CLI debug paths describes the caller instead.
export async function resolveDesktopPluginPaths(
  connection: Pick<ServiceConnection, "client" | "assertCurrent">,
  launch: ServiceLaunchSpec,
  deadlineAt = Date.now() + 15_000,
): Promise<DesktopPluginPaths> {
  const entries: unknown = await connection.client.config.get(undefined, {
    signal: AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())),
  })
  connection.assertCurrent()
  const directory = Array.isArray(entries)
    ? entries.find(entry => entry?.type === "directory")?.path
    : undefined
  const paths = launch.kind === "wsl" || launch.platform !== "win32" ? path.posix : path.win32
  if (typeof directory !== "string" || !paths.isAbsolute(directory) || directory.includes("\0")) {
    throw new Error("Connected OpenCode daemon did not report an absolute global plugin discovery directory")
  }
  const config = paths.normalize(directory)
  // OpenCode recursively watches the entire discovery root, not just plugins/.
  // A lease heartbeat inside it reloads configuration in every loaded location.
  // Derive a sibling namespace from the authenticated root, never our process's
  // environment. The hash keeps distinct discovery roots independent.
  if (paths.dirname(config) === config) throw new Error("OpenCode discovery root has no unwatched parent")
  const identity = launch.kind !== "wsl" && launch.platform === "win32" ? config.toLowerCase() : config
  const namespace = createHash("sha256").update(identity).digest("hex")
  const data = paths.join(paths.dirname(config), ".codenomad", namespace)
  if (launch.kind !== "wsl") return { config, data }
  if (config.includes("\\") || config.startsWith("//")) {
    throw new Error("Connected WSL daemon reported a path that cannot be accessed through its distro")
  }
  const unc = (directory: string) => `\\\\wsl.localhost\\${launch.distro}${directory.replaceAll("/", "\\")}`
  return { config: unc(config), data: unc(data), nativeData: data }
}
