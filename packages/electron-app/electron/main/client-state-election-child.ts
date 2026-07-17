import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  electClientStateProcess,
  isPidAlive,
  REGISTRATION_LOCK_WAIT_MS,
  removeProcessOwnerLockIfOwned,
  removeRunningMarkerIfOwned,
  type ProcessOwner,
} from "./client-state-process"
import { getProcessStartIdentity } from "./client-state-process-identity"

const [directory, runToken, startPath, registrationWaitArgument, primaryPausedPath, primaryReleasePath] =
  process.argv.slice(2)
if (!directory || !runToken || !startPath) {
  throw new Error("Expected election directory, run token, and start path")
}

while (!existsSync(startPath)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
}

const owner: ProcessOwner = {
  pid: process.pid,
  runToken,
  processStartIdentity: getProcessStartIdentity(process.pid),
}
const primaryLockPath = join(directory, "client-state.primary.lock")
const registrationLockPath = join(directory, "client-state.registration.lock")
const registrationLockWaitMs = registrationWaitArgument
  ? Number(registrationWaitArgument)
  : REGISTRATION_LOCK_WAIT_MS
const warnings: string[] = []
const election = electClientStateProcess(
  directory,
  owner,
  { primaryLockPath, registrationLockPath },
  (message, error) => warnings.push(`${message}: ${String(error)}`),
  isPidAlive,
  registrationLockWaitMs,
  () => {
    if (!primaryPausedPath || !primaryReleasePath) {
      return
    }
    try {
      writeFileSync(primaryPausedPath, JSON.stringify(owner), { encoding: "utf8", flag: "wx" })
    } catch {
      // Only the contender that published the synchronization point owns the pause gate.
      return
    }
    while (!existsSync(primaryReleasePath)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  },
)

process.stdout.write(`${JSON.stringify({ isPrimary: election.isPrimary, owner, warnings })}\n`)
process.stdin.resume()
process.stdin.once("end", () => {
  removeRunningMarkerIfOwned(election.runningMarkerPath, owner)
  removeProcessOwnerLockIfOwned(primaryLockPath, owner)
})
