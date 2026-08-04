import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
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
