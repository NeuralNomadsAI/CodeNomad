import { spawn } from "node:child_process"
import type { BackendLaunch } from "./backend"
import { HostError, MAX_BYTES, validateScope, type Scope } from "./protocol"

export interface NodeManagerLaunch {
  node: string
  /** Packaged host-lifetime/manager-entry.js (packaging owns resolving this). */
  entry: string
  nodeArgs?: string[]
  root: string
  scope: Scope
  backend: BackendLaunch
}
/** POSIX independent manager launcher. No cookie/secret in argv or a launch file.
 * Windows must use a native launcher outside the UI Job; detached:true does not
 * prove breakaway. macOS needs an exact start-identity adapter first. */
export async function launchNodeManager(options: NodeManagerLaunch): Promise<void> {
  if (process.platform !== "linux") throw new HostError("native-independent-launcher-required")
  validateScope(options.scope)
  const configuration = JSON.stringify({ root: options.root, scope: options.scope, backend: options.backend })
  if (Buffer.byteLength(configuration) > MAX_BYTES) throw new HostError("launch-configuration-too-large")
  const child = spawn(options.node, [...(options.nodeArgs ?? []), options.entry], {
    detached: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true, shell: false,
  })
  await new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new HostError("manager-launch-failed")))
    child.stdin!.on("error", () => reject(new HostError("manager-launch-failed")))
    child.once("spawn", () => child.stdin!.end(configuration, () => resolve()))
  })
  child.unref()
}
