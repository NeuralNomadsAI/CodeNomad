import assert from "node:assert/strict"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import {
  cleanStaleRunningMarkers,
  createRunningMarker,
  electClientStateProcess,
  getRunningMarkerPath,
  REGISTRATION_LOCK_WAIT_MS,
  removeProcessOwnerLockIfOwned,
  removeRunningMarkerIfOwned,
  type ProcessOwner,
} from "./client-state-process"
import { getProcessStartIdentity } from "./client-state-process-identity"

function withTempDirectory(testContext: test.TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "codenomad-client-state-"))
  testContext.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

interface ElectionChild {
  process: ChildProcessWithoutNullStreams
  result: Promise<ElectionChildResult>
}

interface ElectionChildResult {
  isPrimary: boolean
  owner: ProcessOwner
  warnings: string[]
}

interface ElectionChildOptions {
  registrationLockWaitMs?: number
  primaryPausedPath?: string
  primaryReleasePath?: string
}

function startElectionChild(
  directory: string,
  startPath: string,
  options: ElectionChildOptions = {},
): ElectionChild {
  const childPath = fileURLToPath(new URL("./client-state-election-child.ts", import.meta.url))
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    childPath,
    directory,
    randomUUID(),
    startPath,
    options.registrationLockWaitMs?.toString() ?? "",
    options.primaryPausedPath ?? "",
    options.primaryReleasePath ?? "",
  ])
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")

  const result = new Promise<ElectionChildResult>((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    let settled = false
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
      const newline = stdout.indexOf("\n")
      if (newline < 0 || settled) {
        return
      }
      settled = true
      resolve(JSON.parse(stdout.slice(0, newline)) as ElectionChildResult)
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("error", (error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })
    child.once("exit", (code) => {
      if (!settled) {
        settled = true
        reject(new Error(`Election child exited with code ${code}: ${stderr}`))
      }
    })
  })

  return { process: child, result }
}

async function stopElectionChildren(children: ElectionChild[]) {
  const exits = children.map((child) => once(child.process, "exit"))
  for (const child of children) {
    child.process.stdin.end()
  }
  await Promise.all(exits)
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${path}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test("the current process exposes a stable OS start identity", () => {
  const first = getProcessStartIdentity(process.pid)
  const second = getProcessStartIdentity(process.pid)

  assert.ok(first, `process start identity is unavailable on ${process.platform}`)
  assert.equal(second, first)
})

test("a live secondary marker prevents a successor from becoming primary", (testContext) => {
  const directory = withTempDirectory(testContext)
  const exitedPrimary: ProcessOwner = { pid: 101, runToken: "exited-primary" }
  const liveSecondary: ProcessOwner = { pid: 202, runToken: "live-secondary" }
  const successor: ProcessOwner = { pid: 303, runToken: "successor" }

  createRunningMarker(directory, exitedPrimary)
  createRunningMarker(directory, liveSecondary)
  createRunningMarker(directory, successor)

  const hasOtherLiveProcess = cleanStaleRunningMarkers(directory, successor, (pid) => pid === liveSecondary.pid)

  assert.equal(hasOtherLiveProcess, true)
  assert.equal(existsSync(getRunningMarkerPath(directory, exitedPrimary)), false)
  assert.equal(existsSync(getRunningMarkerPath(directory, liveSecondary)), true)
  assert.equal(existsSync(getRunningMarkerPath(directory, successor)), true)
})

test("a reused PID marker with a different run token is stale", (testContext) => {
  const directory = withTempDirectory(testContext)
  const oldRun: ProcessOwner = { pid: 404, runToken: "old-run" }
  const currentRun: ProcessOwner = { pid: 404, runToken: "current-run" }

  createRunningMarker(directory, oldRun)
  createRunningMarker(directory, currentRun)

  assert.equal(cleanStaleRunningMarkers(directory, currentRun, () => true), false)
  assert.equal(existsSync(getRunningMarkerPath(directory, oldRun)), false)
  assert.equal(existsSync(getRunningMarkerPath(directory, currentRun)), true)
})

test("a marker from a crashed process is stale when its PID has been reused", (testContext) => {
  const directory = withTempDirectory(testContext)
  const crashedOwner: ProcessOwner = {
    pid: 404,
    runToken: "crashed-run",
    processStartIdentity: "start:old",
  }
  const currentOwner: ProcessOwner = {
    pid: 505,
    runToken: "current-run",
    processStartIdentity: "start:current",
  }
  createRunningMarker(directory, crashedOwner)

  const hasOtherLiveProcess = cleanStaleRunningMarkers(
    directory,
    currentOwner,
    () => true,
    (pid) => pid === crashedOwner.pid ? "start:reused" : currentOwner.processStartIdentity,
  )

  assert.equal(hasOtherLiveProcess, false)
  assert.equal(existsSync(getRunningMarkerPath(directory, crashedOwner)), false)
})

test("an identity lookup failure remains conservative for election safety", (testContext) => {
  const directory = withTempDirectory(testContext)
  const unverifiedOwner: ProcessOwner = {
    pid: 606,
    runToken: "unverified-run",
    processStartIdentity: "start:missing",
  }
  const currentOwner: ProcessOwner = { pid: 707, runToken: "current-run" }
  createRunningMarker(directory, unverifiedOwner)

  assert.equal(cleanStaleRunningMarkers(directory, currentOwner, () => true, () => undefined), true)
  assert.equal(existsSync(getRunningMarkerPath(directory, unverifiedOwner)), true)
})

test("a secondary that observed the current primary does not make it relinquish ownership", (testContext) => {
  const directory = withTempDirectory(testContext)
  const currentPrimary: ProcessOwner = { pid: 303, runToken: "current-primary" }
  const overlappingSecondary: ProcessOwner = { pid: 404, runToken: "overlapping-secondary" }
  createRunningMarker(directory, overlappingSecondary, currentPrimary)

  const hasBlockingProcess = cleanStaleRunningMarkers(
    directory,
    currentPrimary,
    (pid) => pid === overlappingSecondary.pid,
  )

  assert.equal(hasBlockingProcess, false)
  assert.equal(existsSync(getRunningMarkerPath(directory, overlappingSecondary)), true)
})

test("shutdown does not remove a marker whose ownership changed", (testContext) => {
  const directory = withTempDirectory(testContext)
  const owner: ProcessOwner = { pid: 505, runToken: "owned-run" }
  const replacement: ProcessOwner = { pid: 606, runToken: "replacement-run" }
  const markerPath = createRunningMarker(directory, owner)
  writeFileSync(markerPath, JSON.stringify(replacement), "utf8")

  assert.equal(removeRunningMarkerIfOwned(markerPath, owner), false)
  assert.deepEqual(JSON.parse(readFileSync(markerPath, "utf8")), replacement)
})

test("simultaneous process registration elects exactly one primary", async (testContext) => {
  const directory = withTempDirectory(testContext)
  const startPath = join(directory, "start")
  const children = [startElectionChild(directory, startPath), startElectionChild(directory, startPath)]
  writeFileSync(startPath, "", "utf8")

  const roles = await Promise.all(children.map((child) => child.result))
  await stopElectionChildren(children)

  assert.equal(roles.filter((role) => role.isPrimary).length, 1)
})

test("an unrelated live PID in a stale registration file still elects exactly one primary", async (testContext) => {
  const directory = withTempDirectory(testContext)
  const registrationLockPath = join(directory, "client-state.registration.lock")
  writeFileSync(
    registrationLockPath,
    JSON.stringify({ pid: process.pid, runToken: "unrelated-live-process" }),
    "utf8",
  )
  const startPath = join(directory, "start")
  const children = [startElectionChild(directory, startPath), startElectionChild(directory, startPath)]
  writeFileSync(startPath, "", "utf8")

  const roles = await Promise.all(children.map((child) => child.result))
  await stopElectionChildren(children)

  assert.equal(roles.filter((role) => role.isPrimary).length, 1)
})

async function assertStaleLivePidPrimaryRecovery(testContext: test.TestContext, round: number) {
  const directory = withTempDirectory(testContext)
  const primaryLockPath = join(directory, "client-state.primary.lock")
  const crashedOwner: ProcessOwner = {
    pid: process.pid,
    runToken: `reused-live-primary-${round}`,
    processStartIdentity: `old-process-start-${round}`,
  }
  writeFileSync(
    primaryLockPath,
    JSON.stringify(crashedOwner),
    "utf8",
  )
  createRunningMarker(directory, crashedOwner)
  const startPath = join(directory, "start")
  const options: ElectionChildOptions = { registrationLockWaitMs: 40 }
  const children = [startElectionChild(directory, startPath, options), startElectionChild(directory, startPath, options)]
  let stopped = false
  try {
    writeFileSync(startPath, "", "utf8")
    const roles = await Promise.all(children.map((child) => child.result))
    assert.equal(
      roles.filter((role) => role.isPrimary).length,
      1,
      JSON.stringify({ round, roles }),
    )
    await stopElectionChildren(children)
    stopped = true
  } finally {
    if (!stopped) await stopElectionChildren(children)
  }
}

test("a crash-left primary marker whose PID was reused still elects exactly one primary", async (testContext) => {
  await assertStaleLivePidPrimaryRecovery(testContext, 0)
})

test("simultaneous reused-PID recovery remains single-primary under stress", async (testContext) => {
  for (let round = 1; round <= 20; round += 1) {
    await assertStaleLivePidPrimaryRecovery(testContext, round)
  }
})

test("overlapping stale-registration recovery cannot leave every contender secondary", async (testContext) => {
  const directory = withTempDirectory(testContext)
  const registrationLockPath = join(directory, "client-state.registration.lock")
  const startPath = join(directory, "start")
  const primaryPausedPath = join(directory, "primary-paused")
  const primaryReleasePath = join(directory, "primary-release")
  writeFileSync(
    registrationLockPath,
    JSON.stringify({ pid: process.pid, runToken: "unrelated-live-process" }),
    "utf8",
  )
  const options: ElectionChildOptions = {
    registrationLockWaitMs: 40,
    primaryPausedPath,
    primaryReleasePath,
  }
  const children = [startElectionChild(directory, startPath, options), startElectionChild(directory, startPath, options)]
  let stopped = false
  try {
    writeFileSync(startPath, "", "utf8")

    await waitForFile(primaryPausedPath, 2_000)
    await Promise.race(children.map((child) => child.result))
    writeFileSync(primaryReleasePath, "", "utf8")
    const roles = await Promise.all(children.map((child) => child.result))
    const electionFiles = Object.fromEntries(
      readdirSync(directory)
        .filter((filename) => filename.startsWith("client-state."))
        .map((filename) => [filename, readFileSync(join(directory, filename), "utf8")]),
    )
    assert.equal(
      roles.filter((role) => role.isPrimary).length,
      1,
      JSON.stringify({ roles, electionFiles }),
    )
    await stopElectionChildren(children)
    stopped = true
  } finally {
    if (!existsSync(primaryReleasePath)) {
      writeFileSync(primaryReleasePath, "", "utf8")
    }
    if (!stopped) {
      await stopElectionChildren(children)
    }
  }
})

test("a new process remains secondary after primary exits while an older secondary lives", async (testContext) => {
  const directory = withTempDirectory(testContext)
  const firstStart = join(directory, "start-first")
  const first = startElectionChild(directory, firstStart)
  writeFileSync(firstStart, "", "utf8")
  assert.equal((await first.result).isPrimary, true)

  const secondStart = join(directory, "start-second")
  const second = startElectionChild(directory, secondStart)
  writeFileSync(secondStart, "", "utf8")
  assert.equal((await second.result).isPrimary, false)
  await stopElectionChildren([first])

  const thirdStart = join(directory, "start-third")
  const third = startElectionChild(directory, thirdStart)
  writeFileSync(thirdStart, "", "utf8")
  const thirdRole = await third.result
  await stopElectionChildren([second, third])

  assert.equal(thirdRole.isPrimary, false)
})

test("a primary lock with the current PID and an old token is reclaimed", (testContext) => {
  const directory = withTempDirectory(testContext)
  const primaryLockPath = join(directory, "client-state.primary.lock")
  const registrationLockPath = join(directory, "client-state.registration.lock")
  const owner: ProcessOwner = { pid: process.pid, runToken: "current-run" }
  writeFileSync(primaryLockPath, JSON.stringify({ pid: process.pid, runToken: "old-run" }), "utf8")

  const election = electClientStateProcess(directory, owner, { primaryLockPath, registrationLockPath })

  assert.equal(election.isPrimary, true)
  removeRunningMarkerIfOwned(election.runningMarkerPath, owner)
  removeProcessOwnerLockIfOwned(primaryLockPath, owner)
})

test("a malformed marker-backed lock cannot keep the outer recovery loop alive", (testContext) => {
  const directory = withTempDirectory(testContext)
  const primaryLockPath = join(directory, "client-state.primary.lock")
  const registrationLockPath = join(directory, "client-state.registration.lock")
  const owner: ProcessOwner = { pid: process.pid, runToken: "bounded-recovery" }
  writeFileSync(registrationLockPath, "malformed", "utf8")

  const startedAt = Date.now()
  const election = electClientStateProcess(
    directory,
    owner,
    { primaryLockPath, registrationLockPath },
    () => {},
    () => true,
    0,
  )

  assert.ok(Date.now() - startedAt < 500)
  assert.equal(election.isPrimary, false)
  removeRunningMarkerIfOwned(election.runningMarkerPath, owner)
})

test("a live registration-lock owner with a matching marker remains conservative", (testContext) => {
  const directory = withTempDirectory(testContext)
  const primaryLockPath = join(directory, "client-state.primary.lock")
  const registrationLockPath = join(directory, "client-state.registration.lock")
  const stuckOwner: ProcessOwner = { pid: 8181, runToken: "stuck-registration" }
  const currentOwner: ProcessOwner = { pid: 9191, runToken: "current-registration" }
  const boundedTestWaitMs = 30
  writeFileSync(registrationLockPath, JSON.stringify(stuckOwner), "utf8")
  createRunningMarker(directory, stuckOwner)

  const startedAt = Date.now()
  const election = electClientStateProcess(
    directory,
    currentOwner,
    { primaryLockPath, registrationLockPath },
    () => {},
    (pid) => pid === stuckOwner.pid,
    boundedTestWaitMs,
  )
  const elapsedMs = Date.now() - startedAt

  assert.equal(election.isPrimary, false)
  assert.ok(elapsedMs >= boundedTestWaitMs - 5, `registration wait ended too early after ${elapsedMs}ms`)
  assert.ok(elapsedMs < 500, `registration wait was not bounded: ${elapsedMs}ms`)
  assert.equal(existsSync(election.runningMarkerPath), true)
  assert.deepEqual(JSON.parse(readFileSync(registrationLockPath, "utf8")), stuckOwner)
  assert.equal(REGISTRATION_LOCK_WAIT_MS, 1_000)
  removeRunningMarkerIfOwned(election.runningMarkerPath, currentOwner)
})

test("a verified live registration owner is not stolen before publishing its marker", (testContext) => {
  const directory = withTempDirectory(testContext)
  const primaryLockPath = join(directory, "client-state.primary.lock")
  const registrationLockPath = join(directory, "client-state.registration.lock")
  const registeringOwner: ProcessOwner = {
    pid: 8282,
    runToken: "registering-process",
    processStartIdentity: "start:registering",
  }
  const currentOwner: ProcessOwner = { pid: 9292, runToken: "current-process" }
  writeFileSync(registrationLockPath, JSON.stringify(registeringOwner), "utf8")

  const election = electClientStateProcess(
    directory,
    currentOwner,
    { primaryLockPath, registrationLockPath },
    () => {},
    (pid) => pid === registeringOwner.pid,
    30,
    () => {},
    (pid) => pid === registeringOwner.pid ? registeringOwner.processStartIdentity : undefined,
  )

  assert.equal(election.isPrimary, false)
  assert.deepEqual(JSON.parse(readFileSync(registrationLockPath, "utf8")), registeringOwner)
  removeRunningMarkerIfOwned(election.runningMarkerPath, currentOwner)
})

test("a live primary-lock owner with a matching marker remains conservative", (testContext) => {
  const directory = withTempDirectory(testContext)
  const primaryLockPath = join(directory, "client-state.primary.lock")
  const registrationLockPath = join(directory, "client-state.registration.lock")
  const primaryOwner: ProcessOwner = { pid: 7171, runToken: "live-primary" }
  const currentOwner: ProcessOwner = { pid: 8181, runToken: "current-process" }
  const boundedTestWaitMs = 30
  writeFileSync(primaryLockPath, JSON.stringify(primaryOwner), "utf8")
  createRunningMarker(directory, primaryOwner)

  const startedAt = Date.now()
  const election = electClientStateProcess(
    directory,
    currentOwner,
    { primaryLockPath, registrationLockPath },
    () => {},
    (pid) => pid === primaryOwner.pid,
    boundedTestWaitMs,
  )
  const elapsedMs = Date.now() - startedAt

  assert.equal(election.isPrimary, false)
  assert.ok(elapsedMs >= boundedTestWaitMs - 5, `primary wait ended too early after ${elapsedMs}ms`)
  assert.ok(elapsedMs < 500, `primary wait was not bounded: ${elapsedMs}ms`)
  assert.deepEqual(JSON.parse(readFileSync(primaryLockPath, "utf8")), primaryOwner)
  removeRunningMarkerIfOwned(election.runningMarkerPath, currentOwner)
})
