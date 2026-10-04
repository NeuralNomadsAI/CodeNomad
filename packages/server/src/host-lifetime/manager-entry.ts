import { HostLifetimeManager } from "./manager"
import { HostStorage } from "./storage"
import { HostError, MAX_BYTES, validateScope } from "./protocol"
import type { NodeManagerLaunch } from "./launcher"

// Hidden independent Node entry. Launch configuration is one bounded private pipe
// message, not renderer IPC, argv secrets, a persisted environment, or user config.
try {
  // A contained Windows M needs a live native owner/service channel, not this
  // POSIX one-shot configuration pipe. Never auto-load an addon from JSON/env.
  if (process.platform === "win32") throw new HostError("native-manager-binding-entry-required")
  const chunks: Buffer[] = []
  let size = 0
  const timer = setTimeout(() => process.exit(2), 5_000)
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BYTES) throw new HostError("launch-configuration-too-large")
    chunks.push(buffer)
  }
  clearTimeout(timer)
  const config = JSON.parse(Buffer.concat(chunks).toString()) as NodeManagerLaunch
  validateScope(config.scope)
  if (typeof config.root !== "string" || !config.backend || typeof config.backend.file !== "string"
    || !Array.isArray(config.backend.args) || config.backend.args.some(arg => typeof arg !== "string")
    || typeof config.backend.cwd !== "string") throw new HostError("invalid-launch-configuration")
  const manager = new HostLifetimeManager({ storage: new HostStorage(config.root, config.scope), backend: config.backend })
  if (!await manager.start()) process.exit(0)
} catch {
  // Do not print launch bodies/auth/config/environment on failure.
  process.exit(2)
}
