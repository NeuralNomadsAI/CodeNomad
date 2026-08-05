import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { it } from "node:test"
import { withFilesystemLock } from "./filesystem-lock"

it("never overlaps replacement locks while concurrent callers reclaim a stale owner", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-stale-lock-race-"))
  const lockPath = path.join(directory, "shared.lock")
  await fs.mkdir(lockPath)
  await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
    token: "stale-owner",
    pid: 2_147_483_647,
  }), "utf8")

  let active = 0
  let maximum = 0
  let releaseFirst!: () => void
  let firstEntered!: () => void
  const firstReady = new Promise<void>((resolve) => { firstEntered = resolve })
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
  const operation = async () => {
    active++
    maximum = Math.max(maximum, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active--
  }
  try {
    const first = withFilesystemLock(lockPath, async () => {
      active++
      maximum = Math.max(maximum, active)
      firstEntered()
      await firstBlocked
      active--
    }, { waitMs: 10, staleMs: 20, pollMs: 1 })
    await firstReady
    const contenders = Array.from({ length: 7 }, () => withFilesystemLock(lockPath, operation, {
      waitMs: 5_000, staleMs: 20, pollMs: 1,
    }))
    releaseFirst()
    await Promise.all([first, ...contenders])
    assert.equal(maximum, 1)
  } finally {
    releaseFirst?.()
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

it("fences a replaced writer and never releases its successor", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-lock-fence-"))
  const lockPath = path.join(directory, "shared.lock")
  let continueWriter!: () => void
  let writerReady!: () => void
  const ready = new Promise<void>((resolve) => { writerReady = resolve })
  const blocked = new Promise<void>((resolve) => { continueWriter = resolve })
  let committed = false
  try {
    const writer = withFilesystemLock(lockPath, async (assertOwned) => {
      writerReady()
      await blocked
      await assertOwned()
      committed = true
    })
    await ready
    await fs.rename(lockPath, `${lockPath}.expired`)
    await fs.mkdir(lockPath)
    await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ token: "successor", pid: process.pid }), "utf8")
    await fs.writeFile(path.join(lockPath, "heartbeat"), "successor", "utf8")
    continueWriter()

    await assert.rejects(writer, /ownership was lost/)
    assert.equal(committed, false)
    assert.equal(JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")).token, "successor")
  } finally {
    continueWriter?.()
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

it("recovers an abandoned reclaim claim", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-lock-claim-"))
  const lockPath = path.join(directory, "shared.lock")
  const observed = { token: "stale-owner", serialized: JSON.stringify({ token: "stale-owner", pid: 2_147_483_647 }) }
  try {
    await fs.mkdir(lockPath)
    await fs.writeFile(path.join(lockPath, "owner.json"), observed.serialized, "utf8")
    await fs.writeFile(path.join(lockPath, "heartbeat"), "stale", "utf8")
    await fs.writeFile(path.join(lockPath, ".reclaim"), JSON.stringify({
      token: "abandoned", owner: observed, createdAt: Date.now() - 1_000,
    }), "utf8")

    let acquired = false
    await withFilesystemLock(lockPath, async () => { acquired = true }, { waitMs: 20, staleMs: 20, pollMs: 1 })
    assert.equal(acquired, true)
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

it("publishes complete owner metadata and never reclaims a suspended same-machine owner", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-live-lock-owner-"))
  const lockPath = path.join(directory, "shared.lock")
  try {
    await fs.mkdir(lockPath)
    await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
      token: "live-owner", pid: process.pid, hostname: os.hostname(),
    }), "utf8")
    await fs.writeFile(path.join(lockPath, "heartbeat"), "suspended", "utf8")
    const old = new Date(Date.now() - 60_000)
    await fs.utimes(path.join(lockPath, "heartbeat"), old, old)

    await assert.rejects(withFilesystemLock(lockPath, async () => undefined, {
      waitMs: 10, staleMs: 10, pollMs: 1,
    }), /Timed out waiting/)
    assert.equal(JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")).token, "live-owner")

    await fs.rm(lockPath, { recursive: true })
    await withFilesystemLock(lockPath, async () => {
      const owner = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"))
      assert.equal(typeof owner.token, "string")
      assert.equal(owner.pid, process.pid)
      assert.equal(typeof await fs.readFile(path.join(lockPath, "heartbeat"), "utf8"), "string")
    })
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

it("fails closed for an unverifiable foreign-host lock owner", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-foreign-lock-owner-"))
  const lockPath = path.join(directory, "shared.lock")
  try {
    await fs.mkdir(lockPath)
    await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
      token: "foreign-owner", pid: 2_147_483_647, hostname: "another-host",
    }), "utf8")
    await fs.writeFile(path.join(lockPath, "heartbeat"), "stale", "utf8")
    await assert.rejects(withFilesystemLock(lockPath, async () => undefined, {
      waitMs: 5, staleMs: 5, pollMs: 1,
    }), /Timed out waiting/)
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})
