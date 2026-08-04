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
  try {
    await Promise.all(Array.from({ length: 24 }, () => withFilesystemLock(lockPath, async () => {
      active++
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
    })))
    assert.equal(maximum, 1)
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})
