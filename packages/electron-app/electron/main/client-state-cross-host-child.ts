import { existsSync, writeFileSync } from "node:fs"
import { CrossHostRegistration, createCrossHostOwner } from "./client-state-cross-host"
import { getProcessStartIdentity } from "./client-state-process-identity"
import { isPidAlive } from "./client-state-process"
import { ClientStateManager } from "./client-state"
import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"

const [directory, startPath, readyPath, mode, userDataPath, participantReadyPath, participantContinuePath, legacyTauriDataPath, operation, payload] = process.argv.slice(2)
if (!directory || !startPath) throw new Error("Expected election directory and start path")
if (readyPath) writeFileSync(readyPath, "")
while (!existsSync(startPath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)

const identityProbes: Record<string, unknown>[] = []
const originalSpawnSync = childProcess.spawnSync
if (process.platform === "win32") {
  childProcess.spawnSync = ((...args: Parameters<typeof originalSpawnSync>) => {
    if (args[0] !== "powershell.exe" || args[1]?.[3] !== `(Get-Process -Id ${process.pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`
      || identityProbes.length >= 2) return originalSpawnSync(...args)
    const started = performance.now()
    let result: ReturnType<typeof originalSpawnSync> | undefined, failure: unknown
    try { return result = originalSpawnSync(...args) }
    catch (error) { failure = error; throw error }
    finally {
      const error = failure ?? result?.error
      identityProbes.push({
        status: result?.status ?? null, signal: result?.signal ?? null,
        error: error === undefined ? undefined : {
          code: (error as NodeJS.ErrnoException).code?.slice(0, 1000),
          message: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
        },
        timeout: args[2]?.timeout, elapsedMs: performance.now() - started,
        stdout: result?.stdout?.toString().slice(0, 1000) ?? "", stderr: result?.stderr?.toString().slice(0, 1000) ?? "",
      })
    }
  }) as typeof originalSpawnSync
  syncBuiltinESMExports()
}

const manager = mode === "full" && userDataPath
  ? new ClientStateManager(userDataPath, undefined, {
      crossHostElectionDirectory: directory,
      legacyTauriDataPath: legacyTauriDataPath || null,
      crossHostDependencies: {
        pidAlive: isPidAlive,
        processStartIdentity: getProcessStartIdentity,
        onParticipantPublished: participantReadyPath && participantContinuePath
          ? () => {
              writeFileSync(participantReadyPath, "")
              while (!existsSync(participantContinuePath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
            }
          : undefined,
      },
    })
  : undefined
const owner = manager ? undefined : createCrossHostOwner()
const registration = owner && CrossHostRegistration.register(directory, owner, true, {
  pidAlive: mode === "retire-crash" ? () => false : isPidAlive,
  processStartIdentity: getProcessStartIdentity,
  onOwnerPrepared: mode === "owner-crash" ? () => process.exit(91) : undefined,
  onOwnerRetired: mode === "retire-crash" ? () => process.exit(91) : undefined,
})
childProcess.spawnSync = originalSpawnSync
syncBuiltinESMExports()
if (manager?.isPrimary && operation === "save") {
  await manager.setRestoreEnabled(true)
  await manager.saveClientState(JSON.parse(payload))
}
const acquired = manager?.isPrimary ?? Boolean(registration?.isPrimary)
process.stdout.write(`${JSON.stringify({
  acquired,
  diagnostics: !acquired && identityProbes.length ? identityProbes : undefined,
  state: operation === "load" ? manager?.loadClientState() : undefined,
})}\n`)
process.stdin.resume()
process.stdin.once("end", () => {
  if (manager) void manager.drainAndReleasePrimary().finally(() => process.exit())
  else registration?.release()
})
