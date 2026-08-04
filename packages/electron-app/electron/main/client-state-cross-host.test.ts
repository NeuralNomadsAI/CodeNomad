import assert from "node:assert/strict"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, posix, win32 } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import {
  CrossHostRegistration,
  CROSS_HOST_OWNER_DIRECTORY,
  crossHostParticipants,
  resolveCrossHostElectionDirectory,
  resolveCrossHostStatePath,
  type CrossHostLeaseDependencies,
} from "./client-state-cross-host"
import type { ProcessOwner } from "./client-state-process"

function temp(t: test.TestContext): string {
  const path = mkdtempSync(join(tmpdir(), "codenomad-cross-host-"))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

function owner(pid: number, token: string, identity = `${token}-start`): ProcessOwner {
  return { pid, runToken: token, processStartIdentity: identity }
}

function dependencies(alive: boolean, identity?: string): CrossHostLeaseDependencies {
  return { pidAlive: () => alive, processStartIdentity: () => identity }
}

function ownerFile(directory: string): string {
  return join(directory, CROSS_HOST_OWNER_DIRECTORY, "owner.json")
}

interface Child {
  process: ChildProcessWithoutNullStreams
  result: Promise<boolean>
}

function child(directory: string, start: string, mode = ""): Child {
  const process = spawn(globalThis.process.execPath, [
    "--import", "tsx", fileURLToPath(new URL("./client-state-cross-host-child.ts", import.meta.url)), directory, start, "", mode,
  ]) as ChildProcessWithoutNullStreams
  process.stdout.setEncoding("utf8"); process.stderr.setEncoding("utf8")
  const result = new Promise<boolean>((resolve, reject) => {
    let output = "", errors = ""
    process.stdout.on("data", (chunk: string) => {
      output += chunk
      if (output.includes("\n")) resolve(JSON.parse(output).acquired)
    })
    process.stderr.on("data", (chunk: string) => { errors += chunk })
    process.once("error", reject)
    process.once("exit", (code) => { if (!output && code !== 91) reject(new Error(`child ${code}: ${errors}`)) })
  })
  return { process, result }
}

async function stop(...children: Child[]): Promise<void> {
  const running = children.filter(({ process }) => process.exitCode === null && process.signalCode === null)
  const exits = running.map(({ process }) => once(process, "exit"))
  running.forEach(({ process }) => process.stdin.end())
  await Promise.all(exits)
}

async function waitForExit(child: Child): Promise<void> {
  if (child.process.exitCode === null && child.process.signalCode === null) await once(child.process, "exit")
}

test("simultaneous acquisition across processes yields one owner", async (t) => {
  const directory = temp(t), start = join(directory, "start")
  const children = Array.from({ length: 4 }, () => child(directory, start))
  try {
    writeFileSync(start, "")
    assert.equal((await Promise.all(children.map(({ result }) => result))).filter(Boolean).length, 1)
  } finally { await stop(...children) }
})

test("owner publication crash leaves no visible owner", async (t) => {
  const directory = temp(t), start = join(directory, "start")
  const crashed = child(directory, start, "owner-crash")
  writeFileSync(start, "")
  await waitForExit(crashed)
  assert.equal(existsSync(join(directory, CROSS_HOST_OWNER_DIRECTORY)), false)
  const winner = CrossHostRegistration.register(directory, owner(101, "winner"), true, dependencies(true, "winner-start"))!
  assert.equal(winner.isPrimary, true)
})

test("stale retirement crash cannot retire a successor", async (t) => {
  const directory = temp(t), staleDirectory = join(directory, CROSS_HOST_OWNER_DIRECTORY)
  mkdirSync(staleDirectory)
  writeFileSync(join(staleDirectory, "owner.json"), JSON.stringify(owner(4_000_000_000, "stale")))
  const start = join(directory, "start"), crashed = child(directory, start, "retire-crash")
  writeFileSync(start, "")
  await waitForExit(crashed)
  const winner = CrossHostRegistration.register(directory, owner(102, "successor"), true, dependencies(true, "successor-start"))!
  assert.equal(winner.isPrimary, true)
  assert.equal(JSON.parse(readFileSync(ownerFile(directory), "utf8")).runToken, "successor")
})

test("stale recovery is identity guarded and blocked by non-claiming live participants", (t) => {
  for (const value of [
    { alive: false, identity: undefined, recover: true },
    { alive: true, identity: "reused", recover: true },
    { alive: true, identity: "old-start", recover: false },
    { alive: true, identity: undefined, recover: false },
  ]) {
    const directory = temp(t), staleDirectory = join(directory, CROSS_HOST_OWNER_DIRECTORY)
    mkdirSync(staleDirectory); writeFileSync(join(staleDirectory, "owner.json"), JSON.stringify(owner(201, "old", "old-start")))
    const registration = CrossHostRegistration.register(directory, owner(202, "new"), true, dependencies(value.alive, value.identity))!
    assert.equal(registration.isPrimary, value.recover)
  }

  const directory = temp(t), staleDirectory = join(directory, CROSS_HOST_OWNER_DIRECTORY)
  mkdirSync(staleDirectory); writeFileSync(join(staleDirectory, "owner.json"), JSON.stringify(owner(301, "dead")))
  writeFileSync(join(directory, "participant.302.secondary.json"), JSON.stringify(owner(302, "secondary")))
  const identities = new Map([[302, "secondary-start"]])
  const blocked = CrossHostRegistration.register(directory, owner(303, "next"), true, {
    pidAlive: (pid) => pid === 302,
    processStartIdentity: (pid) => identities.get(pid),
  })!
  assert.equal(blocked.isPrimary, false)
})

test("simultaneous claimants deterministically recover a stale owner", (t) => {
  const directory = temp(t), staleDirectory = join(directory, CROSS_HOST_OWNER_DIRECTORY)
  const stale = owner(601, "stale"), first = owner(602, "a"), second = owner(603, "b")
  mkdirSync(staleDirectory)
  const observed = JSON.stringify(stale)
  writeFileSync(join(staleDirectory, "owner.json"), observed)
  writeFileSync(join(directory, "participant.603.b.json"), JSON.stringify(second))
  writeFileSync(join(directory, "recovery.603.b.claim"), observed)
  const identities = new Map([[602, first.processStartIdentity], [603, second.processStartIdentity]])
  const deps = {
    pidAlive: (pid: number) => pid !== stale.pid,
    processStartIdentity: (pid: number) => identities.get(pid),
  }
  const winner = CrossHostRegistration.register(directory, first, true, deps)!
  const loser = CrossHostRegistration.register(directory, second, true, deps)!
  assert.equal(winner.isPrimary, true)
  assert.equal(loser.isPrimary, false)
})

test("async recovery replaces a prior claim for a consecutive crashed owner", async (t) => {
  const directory = temp(t), candidate = owner(620, "candidate")
  const registration = CrossHostRegistration.register(directory, candidate, false, {
    pidAlive: () => true,
    processStartIdentity: () => { throw new Error("sync identity lookup must not run") },
    processStartIdentityAsync: async () => "reused-start",
  })!
  const publishStaleOwner = (stale: ProcessOwner) => {
    mkdirSync(join(directory, CROSS_HOST_OWNER_DIRECTORY))
    writeFileSync(ownerFile(directory), JSON.stringify(stale))
  }
  const first = owner(621, "first", "first-start")
  publishStaleOwner(first)
  assert.equal(await registration.tryAcquireAsync(true), true)
  rmSync(join(directory, CROSS_HOST_OWNER_DIRECTORY), { recursive: true, force: true })

  const second = owner(622, "second", "second-start")
  publishStaleOwner(second)
  assert.equal(await registration.tryAcquireAsync(true), true)
  assert.equal(readFileSync(join(directory, "recovery.620.candidate.claim"), "utf8"), JSON.stringify(second))
})

test("graceful primary release allows a successor while a secondary remains", (t) => {
  const directory = temp(t)
  const primary = CrossHostRegistration.register(directory, owner(401, "primary"), true, dependencies(true, "primary-start"))!
  const secondary = CrossHostRegistration.register(directory, owner(402, "secondary"), true, dependencies(true, "primary-start"))!
  assert.equal(secondary.isPrimary, false)

  assert.equal(primary.release(), true)
  const successor = CrossHostRegistration.register(directory, owner(403, "successor"), true, dependencies(true, "successor-start"))!
  assert.equal(successor.isPrimary, true)
})

test("graceful handoff retires the old cohort so a crashed successor can recover", (t) => {
  const directory = temp(t), secondaryOwner = owner(422, "secondary"), successorOwner = owner(423, "successor"), lateOwner = owner(425, "late")
  const malformed = join(directory, "participant.malformed.json")
  const primary = CrossHostRegistration.register(directory, owner(421, "primary"), true, {
    pidAlive: () => true,
    processStartIdentity: () => "primary-start",
    onGracefulOwnerChecked: () => {
      writeFileSync(join(directory, "participant.423.successor.json"), JSON.stringify(successorOwner))
      writeFileSync(join(directory, "participant.425.late.json"), JSON.stringify(lateOwner))
      writeFileSync(malformed, "malformed")
    },
    onOwnerRetired: () => {
      mkdirSync(join(directory, CROSS_HOST_OWNER_DIRECTORY))
      writeFileSync(ownerFile(directory), JSON.stringify(successorOwner))
    },
  })!
  CrossHostRegistration.register(directory, secondaryOwner, true, dependencies(true, "primary-start"))!

  primary.release()
  assert.equal(readdirSync(directory).some((name) => name.startsWith("retired.participant.")), true)
  assert.equal(JSON.parse(readFileSync(ownerFile(directory), "utf8")).runToken, "successor")
  assert.equal(existsSync(join(directory, "participant.423.successor.json")), false)
  assert.equal(existsSync(join(directory, "participant.425.late.json")), false)
  assert.equal(existsSync(malformed), false)
  assert.deepEqual(
    crossHostParticipants(directory).map(({ runToken }) => runToken).sort(),
    ["late", "secondary", "successor"],
  )

  const claimantOwner = owner(424, "claimant"), identities = new Map([
    [secondaryOwner.pid, secondaryOwner.processStartIdentity],
    [lateOwner.pid, lateOwner.processStartIdentity],
    [claimantOwner.pid, claimantOwner.processStartIdentity],
  ])
  const claimant = CrossHostRegistration.register(directory, claimantOwner, true, {
    pidAlive: (pid) => identities.has(pid),
    processStartIdentity: (pid) => identities.get(pid),
  })!
  assert.equal(claimant.isPrimary, true)
})

test("non-owner release does not remove a live owner's record", (t) => {
  const directory = temp(t)
  const primary = CrossHostRegistration.register(directory, owner(411, "primary"), true, dependencies(true, "primary-start"))!
  const secondary = CrossHostRegistration.register(directory, owner(412, "secondary"), true, dependencies(true, "primary-start"))!

  assert.equal(secondary.release(), true)
  assert.equal(primary.isPrimary, true)
  assert.equal(JSON.parse(readFileSync(ownerFile(directory), "utf8")).runToken, "primary")
})

test("primary crash remains fenced by its non-claiming secondary cohort", async (t) => {
  const directory = temp(t), firstStart = join(directory, "first-start")
  const primary = child(directory, firstStart), secondary = child(directory, firstStart)
  writeFileSync(firstStart, "")
  const roles = await Promise.all([primary.result, secondary.result])
  const winner = roles[0] ? primary : secondary, survivor = roles[0] ? secondary : primary
  winner.process.kill()
  await waitForExit(winner)
  const blocked = CrossHostRegistration.register(directory, owner(501, "blocked"), true)!
  assert.equal(blocked.isPrimary, false)
  blocked.release()
  survivor.process.kill()
  await waitForExit(survivor)
  const successor = CrossHostRegistration.register(directory, owner(502, "successor"), true)!
  assert.equal(successor.isPrimary, true)
})

test("platform paths match the Rust contract", () => {
  assert.equal(resolveCrossHostElectionDirectory({ HOME: "/Users/dev" }, "darwin", "/fallback"), posix.join("/Users/dev", ".codenomad", "client-state", "election"))
  assert.equal(resolveCrossHostElectionDirectory({ HOME: "/home/dev" }, "linux", "/fallback"), posix.join("/home/dev", ".codenomad", "client-state", "election"))
  assert.equal(resolveCrossHostElectionDirectory({ USERPROFILE: "", HOME: "D:\\Home" }, "win32", "C:\\Fallback"), win32.join("D:\\Home", ".codenomad", "client-state", "election"))
  assert.equal(resolveCrossHostStatePath({ HOME: "/Users/dev" }, "darwin", "/fallback"), posix.join("/Users/dev", ".codenomad", "client-state", "client-state.json"))
  assert.equal(resolveCrossHostStatePath({ HOME: "/home/dev" }, "linux", "/fallback"), posix.join("/home/dev", ".codenomad", "client-state", "client-state.json"))
  assert.equal(resolveCrossHostStatePath({ USERPROFILE: "", HOME: "D:\\Home" }, "win32", "C:\\Fallback"), win32.join("D:\\Home", ".codenomad", "client-state", "client-state.json"))
})
