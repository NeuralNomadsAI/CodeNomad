import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import { Service } from "@opencode/client/service"
import { lookupProcess, type ProcessLookup } from "./process-identity"
import { readNativeScheduleIncarnation, sameNativeScheduleIncarnation, type NativeScheduleIncarnation } from "../opencode/missions/native-schedule-transport-identity"
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
  return (await readSupervisionSample(registrationFile, overrides)).health
}

export interface SupervisionSample {
  health: SupervisionHealth
  identity?: NativeScheduleIncarnation & { startIdentity: string }
}

/** Process continuity is independent of HTTP health and grants only OFF release
 * acknowledgement. Start and Running still require their existing health gates. */
export function supervisionReleasePreserved(before: SupervisionSample, after: SupervisionSample): boolean {
  return before.identity !== undefined && after.identity !== undefined
    ? sameNativeScheduleIncarnation(before.identity, after.identity)
      && before.identity.startIdentity === after.identity.startIdentity
    : !before.identity && !after.identity && before.health.state === "absent" && after.health.state === "absent"
}

export async function readSupervisionSample(registrationFile: string,
  overrides: Partial<Dependencies> = {}): Promise<SupervisionSample> {
  if (!path.isAbsolute(registrationFile)) return { health: { state: "unknown" } }
  const deps: Dependencies = { discover: Service.discover, lookup: lookupProcess, ...overrides }
  try {
    // Missing path and an existing malformed/dangling entry are distinct.
    const stat = await lstat(registrationFile).catch(error => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    // Namespace absence alone cannot prove a previously observed process ended;
    // linger rollback separately checks its durable PID/start identity.
    if (!stat) return { health: { state: "absent" } }
    if (stat.isSymbolicLink() || !stat.isFile()) return { health: { state: "unknown" } }
    const before = readNativeScheduleIncarnation(registrationFile)
    const processBefore = await deps.lookup(before.pid)
    if (processBefore.state !== "live") return { health: { state: processBefore.state === "dead" ? "absent" : "unknown" } }
    // Official discovery authenticates its bounded health probe, with credentials
    // scoped to this invocation. It neither ensures a daemon nor spawns a CLI.
    let discoveryFailed = false
    const endpoint = await deps.discover({ file: registrationFile }).catch(() => { discoveryFailed = true; return undefined })
    const afterStat = await lstat(registrationFile)
    if (afterStat.isSymbolicLink() || !afterStat.isFile()) return { health: { state: "unknown" } }
    const after = readNativeScheduleIncarnation(registrationFile)
    const processAfter = await deps.lookup(after.pid)
    if (!sameNativeScheduleIncarnation(before, after) || processAfter.state !== "live"
      || processBefore.startIdentity !== processAfter.startIdentity) return { health: { state: "unknown" } }
    const identity = { ...after, startIdentity: processAfter.startIdentity }
    if (!endpoint || endpoint.url !== after.url) return { health: { state: discoveryFailed ? "unknown" : "unhealthy" }, identity }
    return { health: { state: "healthy", pid: after.pid, id: after.id, startIdentity: processAfter.startIdentity }, identity }
  } catch {
    // Never propagate SDK/parser/native errors containing credentials or paths.
    return { health: { state: "unknown" } }
  }
}
