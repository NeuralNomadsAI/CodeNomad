import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import { Service } from "@opencode/client/service"
import { lookupProcess, type ProcessLookup } from "./process-identity"
import { readNativeScheduleIncarnation, sameNativeScheduleIncarnation } from "../opencode/missions/native-schedule-transport-identity"
import { type SupervisionHealth } from "./service-supervision-contract"

export async function nativeSupervisionStartPermitted(configFile: string): Promise<boolean> {
  try {
    const stat = await lstat(configFile).catch(error => { if (error.code !== "ENOENT") throw error; return null })
    if (!stat) return true
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) return false
    const bytes = await readFile(configFile)
    if (bytes.length > 32768) return false
    const config = JSON.parse(bytes.toString("utf8"))
    return config !== null && typeof config === "object" && !Array.isArray(config)
      && (config.disabled === undefined || config.disabled === false)
  } catch { return false }
}

interface Dependencies {
  discover: typeof Service.discover
  lookup: ProcessLookup
}

/** A health read has no lifecycle capability. A live but unresponsive process,
 * an unreadable registration, or PID reuse always stays unknown/unhealthy.
 * Absence is an observation, not permission to spawn: the guard must still hold
 * its Start exclusion and prove the acquired namespace vacant. */
export async function readSupervisionHealth(registrationFile: string,
  overrides: Partial<Dependencies> = {}): Promise<SupervisionHealth> {
  if (!path.isAbsolute(registrationFile)) return { state: "unknown" }
  const deps: Dependencies = { discover: Service.discover, lookup: lookupProcess, ...overrides }
  try {
    // Missing path and an existing malformed/dangling entry are distinct.
    const stat = await lstat(registrationFile).catch(error => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    // Namespace absence alone cannot prove a previously observed process ended;
    // linger rollback separately checks its durable PID/start identity.
    if (!stat) return { state: "absent" }
    if (stat.isSymbolicLink() || !stat.isFile()) return { state: "unknown" }
    const before = readNativeScheduleIncarnation(registrationFile)
    const processBefore = await deps.lookup(before.pid)
    if (processBefore.state !== "live") return { state: processBefore.state === "dead" ? "absent" : "unknown" }
    // Official discovery authenticates its bounded health probe, with credentials
    // scoped to this invocation. It neither ensures a daemon nor spawns a CLI.
    const endpoint = await deps.discover({ file: registrationFile })
    const after = readNativeScheduleIncarnation(registrationFile)
    const processAfter = await deps.lookup(after.pid)
    if (!sameNativeScheduleIncarnation(before, after) || processAfter.state !== "live"
      || processBefore.startIdentity !== processAfter.startIdentity) return { state: "unknown" }
    if (!endpoint || endpoint.url !== after.url) return { state: "unhealthy" }
    return { state: "healthy", pid: after.pid, id: after.id, startIdentity: processAfter.startIdentity }
  } catch {
    // Never propagate SDK/parser/native errors containing credentials or paths.
    return { state: "unknown" }
  }
}
