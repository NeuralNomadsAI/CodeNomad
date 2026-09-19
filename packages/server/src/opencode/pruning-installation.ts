import { installDesktopPluginPresence, type DesktopPluginPaths } from "./desktop-plugin-installation"

export type PruningPaths = DesktopPluginPaths

export function installPruningPresence(bundle: Uint8Array, paths: PruningPaths) {
  return installDesktopPluginPresence("session-pruning", bundle, paths)
}
