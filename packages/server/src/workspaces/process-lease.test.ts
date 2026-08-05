import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { WorkspaceProcessLeaseRegistry } from "./process-lease"

test("a stale lease is reclaimed without an old owner deleting its replacement", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-process-lease-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspacePath = path.join(directory, "workspace")
  const stale = new WorkspaceProcessLeaseRegistry({
    directory,
    managerToken: "stale-manager",
    pid: 101,
    hostname: "same-host",
    isPidAlive: () => false,
  })
  const replacement = new WorkspaceProcessLeaseRegistry({
    directory,
    managerToken: "replacement-manager",
    pid: 202,
    hostname: "same-host",
    isPidAlive: (pid) => pid === 202,
  })

  const staleLease = await stale.acquire(workspacePath)
  assert.ok(staleLease)
  const replacementLease = await replacement.acquire(workspacePath)
  assert.ok(replacementLease)

  await staleLease.release()
  const blocked = new WorkspaceProcessLeaseRegistry({
    directory,
    managerToken: "blocked-manager",
    isPidAlive: (pid) => pid === 202,
  })
  assert.equal(await blocked.acquire(workspacePath), undefined)
  await replacementLease.release()
  const successorLease = await blocked.acquire(workspacePath)
  assert.ok(successorLease)
  await successorLease.release()
})

test("a live detached process identity keeps a same-host lease valid", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-process-identity-lease-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspacePath = path.join(directory, "workspace")
  let processAlive = true
  const owner = new WorkspaceProcessLeaseRegistry({
    directory, managerToken: "owner", pid: 101, hostname: "same-host", isPidAlive: () => false,
  })
  const contender = new WorkspaceProcessLeaseRegistry({
    directory, managerToken: "contender", pid: 202, hostname: "same-host", isPidAlive: () => false,
    isProcessIdentityAlive: () => processAlive,
  })
  const lease = await owner.acquire(workspacePath)
  assert.ok(lease)
  await lease.prepareLaunch()
  await lease.setProcessIdentities([{ pid: 303, parentPid: 1, groupId: 303, startTime: "immutable-start" }])

  assert.equal(await contender.acquire(workspacePath), undefined)
  processAlive = false
  const replacement = await contender.acquire(workspacePath)
  assert.ok(replacement)
  await lease.release()
  await replacement.release()
})

test("an inconclusive detached process probe fails closed", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-process-identity-unknown-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspacePath = path.join(directory, "workspace")
  const owner = new WorkspaceProcessLeaseRegistry({
    directory, managerToken: "owner", pid: 101, hostname: "same-host", isPidAlive: () => false,
  })
  const contender = new WorkspaceProcessLeaseRegistry({
    directory, managerToken: "contender", pid: 202, hostname: "same-host", isPidAlive: () => false,
    isProcessIdentityAlive: () => undefined,
  })
  const lease = await owner.acquire(workspacePath)
  assert.ok(lease)
  await lease.prepareLaunch()
  await lease.setProcessIdentities([{ pid: 303, parentPid: 1, groupId: 303, startTime: "immutable-start" }])

  assert.equal(await contender.acquire(workspacePath), undefined)
  await lease.release()
})

test("a same-host live server blocks takeover without relying on heartbeat age", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-process-live-server-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspacePath = path.join(directory, "workspace")
  const owner = new WorkspaceProcessLeaseRegistry({ directory, managerToken: "owner", pid: 101, hostname: "same-host" })
  const contender = new WorkspaceProcessLeaseRegistry({
    directory, managerToken: "contender", pid: 202, hostname: "same-host", isPidAlive: (pid) => pid === 101,
  })
  const lease = await owner.acquire(workspacePath)
  assert.ok(lease)
  assert.equal(await contender.acquire(workspacePath), undefined)
  await lease.release()
})

test("owner replacement reports lease loss", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-process-lease-loss-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspacePath = path.join(directory, "workspace")
  const owner = new WorkspaceProcessLeaseRegistry({
    directory, managerToken: "owner", pid: 101, hostname: "same-host", heartbeatMs: 10, staleMs: 20,
    isPidAlive: () => false,
  })
  const replacement = new WorkspaceProcessLeaseRegistry({
    directory, managerToken: "replacement", pid: 202, hostname: "same-host", heartbeatMs: 60_000, staleMs: 20,
    isPidAlive: (pid) => pid === 202,
  })
  const lease = await owner.acquire(workspacePath)
  assert.ok(lease)
  const lost = new Promise<void>((resolve) => lease.onLost(resolve))
  const successor = await replacement.acquire(workspacePath)
  assert.ok(successor)
  await lost
  await lease.release().catch(() => undefined)
  await successor.release()
})

test("a pre-spawn cleanup token closes the process identity publication gap", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-process-launch-anchor-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspacePath = path.join(directory, "workspace")
  let launchAlive = true
  const owner = new WorkspaceProcessLeaseRegistry({
    directory, managerToken: "owner", pid: 101, hostname: "same-host", isPidAlive: () => false,
  })
  const contender = new WorkspaceProcessLeaseRegistry({
    directory, managerToken: "contender", pid: 202, hostname: "same-host", isPidAlive: () => false,
    platform: "linux", isLaunchTokenAlive: () => launchAlive,
  })
  const lease = await owner.acquire(workspacePath)
  assert.ok(lease)
  const token = await lease.prepareLaunch()
  assert.ok(token)
  assert.equal(await contender.acquire(workspacePath), undefined)

  launchAlive = false
  const replacement = await contender.acquire(workspacePath)
  assert.ok(replacement)
  await lease.release()
  await replacement.release()
})

test("an unknown launch token is checked before process identity discovery", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-process-launch-first-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspacePath = path.join(directory, "workspace")
  const owner = new WorkspaceProcessLeaseRegistry({
    directory, managerToken: "owner", pid: 101, hostname: "same-host", isPidAlive: () => false,
  })
  const contender = new WorkspaceProcessLeaseRegistry({
    directory, managerToken: "contender", pid: 202, hostname: "same-host", isPidAlive: () => false,
    isLaunchTokenAlive: () => undefined,
    isProcessIdentityAlive: () => { throw new Error("process discovery failed") },
  })
  const lease = await owner.acquire(workspacePath)
  assert.ok(lease)
  await lease.prepareLaunch()
  await lease.setProcessIdentities([{ pid: 303, parentPid: 1, groupId: 303, startTime: "immutable-start" }])

  assert.equal(await contender.acquire(workspacePath), undefined)
  await lease.release()
})

test("an inconclusive Windows token probe falls through to immutable identities", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-process-win32-token-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspacePath = path.join(directory, "workspace")
  let processAlive = true
  const owner = new WorkspaceProcessLeaseRegistry({
    directory, managerToken: "owner", pid: 101, hostname: "same-host", isPidAlive: () => false,
  })
  const contender = new WorkspaceProcessLeaseRegistry({
    directory, managerToken: "contender", pid: 202, hostname: "same-host", platform: "win32",
    isPidAlive: () => false, isLaunchTokenAlive: () => undefined, isProcessIdentityAlive: () => processAlive,
  })
  const lease = await owner.acquire(workspacePath)
  assert.ok(lease)
  await lease.prepareLaunch()
  await lease.setProcessIdentities([{ pid: 303, parentPid: 1, groupId: 303, startTime: "windows-creation-ticks" }])

  assert.equal(await contender.acquire(workspacePath), undefined)
  processAlive = false
  const replacement = await contender.acquire(workspacePath)
  assert.ok(replacement)
  await lease.release()
  await replacement.release()
})

for (const platform of ["linux", "win32"] as const) {
  test(`a complete legacy ${platform} lease blocks while live and reclaims when dead`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-process-legacy-complete-"))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const workspacePath = path.join(directory, "workspace")
    const owner = new WorkspaceProcessLeaseRegistry({
      directory, managerToken: "owner", pid: 101, hostname: "same-host", isPidAlive: () => false,
    })
    let processAlive = true
    const contender = new WorkspaceProcessLeaseRegistry({
      directory, managerToken: "contender", pid: 202, hostname: "same-host", platform,
      isPidAlive: () => false, isLaunchTokenAlive: () => platform === "linux" ? false : undefined,
      isProcessIdentityAlive: () => processAlive,
    })
    const lease = await owner.acquire(workspacePath)
    assert.ok(lease)
    const [key] = await readdir(directory)
    const leaseDirectory = path.join(directory, key!)
    const ownerRecord = JSON.parse(await readFile(path.join(leaseDirectory, "owner", "owner.json"), "utf8"))
    const serialized = JSON.stringify({ pid: 303, parentPid: 1, groupId: 303, startTime: "legacy-start" })
    const digest = createHash("sha256").update(serialized).digest("hex")
    await writeFile(path.join(leaseDirectory, `launch.${ownerRecord.leaseToken}.json`), JSON.stringify({ token: "legacy-token" }))
    await writeFile(path.join(leaseDirectory, `process.${ownerRecord.leaseToken}.${digest}.json`), serialized)

    assert.equal(await contender.acquire(workspacePath), undefined)
    processAlive = false
    const replacement = await contender.acquire(workspacePath)
    assert.ok(replacement)
    await lease.release()
    await replacement.release()
  })

  for (const legacyState of ["partial", "malformed"] as const) {
    test(`a ${legacyState} legacy ${platform} lease fails closed`, async (t) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-process-legacy-incomplete-"))
      t.after(() => rm(directory, { recursive: true, force: true }))
      const workspacePath = path.join(directory, "workspace")
      const owner = new WorkspaceProcessLeaseRegistry({
        directory, managerToken: "owner", pid: 101, hostname: "same-host", isPidAlive: () => false,
      })
      const contender = new WorkspaceProcessLeaseRegistry({
        directory, managerToken: "contender", pid: 202, hostname: "same-host", platform,
        isPidAlive: () => false, isLaunchTokenAlive: () => false, isProcessIdentityAlive: () => false,
      })
      const lease = await owner.acquire(workspacePath)
      assert.ok(lease)
      const [key] = await readdir(directory)
      const leaseDirectory = path.join(directory, key!)
      const ownerRecord = JSON.parse(await readFile(path.join(leaseDirectory, "owner", "owner.json"), "utf8"))
      await writeFile(path.join(leaseDirectory, `launch.${ownerRecord.leaseToken}.json`), JSON.stringify({ token: "legacy-token" }))
      if (legacyState === "malformed") {
        await writeFile(path.join(leaseDirectory, `process.${ownerRecord.leaseToken}.invalid.json`), "{")
      }

      assert.equal(await contender.acquire(workspacePath), undefined)
      await lease.release()
    })
  }
}

test("a torn Windows identity generation remains an incomplete takeover fence", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-process-win32-torn-generation-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspacePath = path.join(directory, "workspace")
  const owner = new WorkspaceProcessLeaseRegistry({
    directory, managerToken: "owner", pid: 101, hostname: "same-host", isPidAlive: () => false,
  })
  const contender = new WorkspaceProcessLeaseRegistry({
    directory, managerToken: "contender", pid: 202, hostname: "same-host", platform: "win32",
    isPidAlive: () => false, isLaunchTokenAlive: () => false, isProcessIdentityAlive: () => false,
  })
  const lease = await owner.acquire(workspacePath)
  assert.ok(lease)
  await lease.prepareLaunch()
  const [key] = await readdir(directory)
  const leaseDirectory = path.join(directory, key!)
  const ownerRecord = JSON.parse(await readFile(path.join(leaseDirectory, "owner", "owner.json"), "utf8"))
  const launchFile = (await readdir(leaseDirectory)).find((entry) => entry.startsWith(`launch.${ownerRecord.leaseToken}.`))
  assert.ok(launchFile)
  await writeFile(path.join(leaseDirectory, launchFile), JSON.stringify({
    version: 1,
    generation: "partial-generation",
    complete: false,
    identities: [{ pid: 303, parentPid: 1, groupId: 303, startTime: "wrapper-only" }],
  }))

  assert.equal(await contender.acquire(workspacePath), undefined)
  await lease.release()
})

test("one complete Windows launch cannot hide an incomplete sibling generation", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-process-win32-generations-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspacePath = path.join(directory, "workspace")
  const owner = new WorkspaceProcessLeaseRegistry({
    directory, managerToken: "owner", pid: 101, hostname: "same-host", isPidAlive: () => false,
  })
  const contender = new WorkspaceProcessLeaseRegistry({
    directory, managerToken: "contender", pid: 202, hostname: "same-host", platform: "win32",
    isPidAlive: () => false, isLaunchTokenAlive: () => false, isProcessIdentityAlive: () => false,
  })
  const first = await owner.acquire(workspacePath)
  const second = await owner.acquire(workspacePath)
  assert.ok(first && second)
  await first.prepareLaunch()
  await second.prepareLaunch()
  await first.setProcessIdentities([{ pid: 303, parentPid: 1, groupId: 303, startTime: "first" }])

  assert.equal(await contender.acquire(workspacePath), undefined)
  await second.setProcessIdentities([{ pid: 304, parentPid: 1, groupId: 304, startTime: "second" }])
  const replacement = await contender.acquire(workspacePath)
  assert.ok(replacement)
  await first.release()
  await second.release()
  await replacement.release()
})

for (const scenario of [
  { name: "a live direct Windows launch", persisted: [303], alive: [303], reclaim: false },
  { name: "a live Windows wrapper", persisted: [303, 304], alive: [303, 304], reclaim: false },
  { name: "a surviving Windows wrapper child", persisted: [303, 304], alive: [304], reclaim: false },
  { name: "a dead Windows wrapper tree", persisted: [303, 304], alive: [], reclaim: true },
] as const) {
  test(`${scenario.name} controls same-host lease recovery`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-process-win32-tree-"))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const workspacePath = path.join(directory, "workspace")
    const owner = new WorkspaceProcessLeaseRegistry({
      directory, managerToken: "owner", pid: 101, hostname: "same-host", isPidAlive: () => false,
    })
    const alive = new Set<number>(scenario.alive)
    const contender = new WorkspaceProcessLeaseRegistry({
      directory, managerToken: "contender", pid: 202, hostname: "same-host", platform: "win32",
      isPidAlive: () => false, isLaunchTokenAlive: () => undefined,
      isProcessIdentityAlive: (identity) => alive.has(identity.pid),
    })
    const lease = await owner.acquire(workspacePath)
    assert.ok(lease)
    await lease.prepareLaunch()
    await lease.setProcessIdentities(scenario.persisted.map((pid) => ({
      pid, parentPid: pid === 303 ? 1 : 303, groupId: pid, startTime: `windows-${pid}`,
    })))

    const replacement = await contender.acquire(workspacePath)
    assert.equal(Boolean(replacement), scenario.reclaim)
    await lease.release()
    await replacement?.release()
  })
}

test("a stale torn launch token does not permanently wedge a dead owner", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-process-torn-launch-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspacePath = path.join(directory, "workspace")
  const owner = new WorkspaceProcessLeaseRegistry({
    directory, managerToken: "owner", pid: 101, hostname: "same-host", heartbeatMs: 60_000, isPidAlive: () => false,
  })
  const contender = new WorkspaceProcessLeaseRegistry({
    directory, managerToken: "contender", pid: 202, hostname: "same-host", platform: "linux", staleMs: 20, isPidAlive: () => false,
  })
  const lease = await owner.acquire(workspacePath)
  assert.ok(lease)
  await lease.prepareLaunch()
  const [key] = await readdir(directory)
  const leaseDirectory = path.join(directory, key!)
  const ownerRecord = JSON.parse(await readFile(path.join(leaseDirectory, "owner", "owner.json"), "utf8"))
  const launchFile = (await readdir(leaseDirectory)).find((entry) => entry.startsWith(`launch.${ownerRecord.leaseToken}.`))
  assert.ok(launchFile)
  const launchPath = path.join(leaseDirectory, launchFile)
  await writeFile(launchPath, "{", "utf8")

  assert.equal(await contender.acquire(workspacePath), undefined)
  const old = new Date(Date.now() - 1_000)
  await Promise.all([
    utimes(launchPath, old, old),
    utimes(path.join(leaseDirectory, "owner", "heartbeat"), old, old),
  ])
  const replacement = await contender.acquire(workspacePath)
  assert.ok(replacement)
  await lease.release()
  await replacement.release()
})

test("foreign-host owners fail closed regardless of heartbeat age", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-process-foreign-owner-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspacePath = path.join(directory, "workspace")
  const owner = new WorkspaceProcessLeaseRegistry({ directory, hostname: "foreign-host", pid: 101, isPidAlive: () => false })
  const contender = new WorkspaceProcessLeaseRegistry({ directory, hostname: "local-host", pid: 202, isPidAlive: () => false })
  const lease = await owner.acquire(workspacePath)
  assert.ok(lease)
  assert.equal(await contender.acquire(workspacePath), undefined)
  await lease.release()
})

test("retirement CAS includes the observed heartbeat generation", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-process-heartbeat-cas-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspacePath = path.join(directory, "workspace")
  const owner = new WorkspaceProcessLeaseRegistry({
    directory, managerToken: "owner", pid: 101, hostname: "same-host", isPidAlive: () => false,
  })
  const lease = await owner.acquire(workspacePath)
  assert.ok(lease)
  await lease.prepareLaunch()
  await lease.setProcessIdentities([{ pid: 303, parentPid: 1, groupId: 303, startTime: "immutable-start" }])
  const [key] = await readdir(directory)
  const ownerDirectory = path.join(directory, key!, "owner")
  const contender = new WorkspaceProcessLeaseRegistry({
    directory, managerToken: "contender", pid: 202, hostname: "same-host", isPidAlive: () => false,
    isProcessIdentityAlive: () => {
      writeFileSync(path.join(ownerDirectory, "heartbeat"), "new-generation")
      return false
    },
  })

  assert.equal(await contender.acquire(workspacePath), undefined)
  assert.equal(JSON.parse(await readFile(path.join(ownerDirectory, "owner.json"), "utf8")).managerToken, "owner")
  await lease.release()
})

test("failed final retirement can be retried", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-process-lease-release-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const registry = new WorkspaceProcessLeaseRegistry({ directory, isPidAlive: () => true })
  const lease = await registry.acquire(path.join(directory, "workspace"))
  assert.ok(lease)
  const [key] = await readdir(directory)
  const leaseDirectory = path.join(directory, key!)
  const owner = JSON.parse(await readFile(path.join(leaseDirectory, "owner", "owner.json"), "utf8"))
  const tombstone = path.join(leaseDirectory, `retired.${owner.leaseToken}`)
  await mkdir(tombstone)
  await writeFile(path.join(tombstone, "blocker"), "occupied")

  await assert.rejects(lease.release(), /release can be retried/)
  await rm(tombstone, { recursive: true })
  const retry = await registry.acquire(path.join(directory, "workspace"))
  assert.ok(retry)
  await assert.doesNotReject(retry.release())
})
