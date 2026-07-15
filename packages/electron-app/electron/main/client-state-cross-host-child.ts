import { existsSync, writeFileSync } from "node:fs"
import { CrossHostRegistration, createCrossHostOwner } from "./client-state-cross-host"
import { getProcessStartIdentity } from "./client-state-process-identity"
import { isPidAlive } from "./client-state-process"
import { ClientStateManager } from "./client-state"

const [directory, startPath, readyPath, mode, userDataPath, participantReadyPath, participantContinuePath] = process.argv.slice(2)
if (!directory || !startPath) throw new Error("Expected election directory and start path")
if (readyPath) writeFileSync(readyPath, "")
while (!existsSync(startPath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)

const manager = mode === "full" && userDataPath
  ? new ClientStateManager(userDataPath, undefined, {
      crossHostElectionDirectory: directory,
      legacyTauriDataPath: null,
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
const registration = owner && CrossHostRegistration.register(directory, owner, true)
process.stdout.write(`${JSON.stringify({ acquired: manager?.isPrimary ?? Boolean(registration?.isPrimary) })}\n`)
process.stdin.resume()
process.stdin.once("end", () => {
  if (manager) void manager.drainAndReleasePrimary().finally(() => process.exit())
  else registration?.release()
})
