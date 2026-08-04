import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
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
  await lease.setProcessIdentity({ pid: 303, parentPid: 1, groupId: 303, startTime: "immutable-start" })

  assert.equal(await contender.acquire(workspacePath), undefined)
  processAlive = false
  const replacement = await contender.acquire(workspacePath)
  assert.ok(replacement)
  await lease.release()
  await replacement.release()
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
    directory, managerToken: "replacement", pid: 202, hostname: "same-host", heartbeatMs: 10, staleMs: 20,
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
    isLaunchTokenAlive: () => launchAlive,
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
  await lease.setProcessIdentity({ pid: 303, parentPid: 1, groupId: 303, startTime: "immutable-start" })
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

  await assert.rejects(lease.release(), /release can be retried/)
  await rm(tombstone, { recursive: true })
  const retry = await registry.acquire(path.join(directory, "workspace"))
  assert.ok(retry)
  await assert.doesNotReject(retry.release())
})
