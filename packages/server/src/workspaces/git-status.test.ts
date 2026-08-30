import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import { getWorktreeGitStatus, invalidateWorktreeGitStatus } from "./git-status"

describe("worktree git status singleflight", () => {
  it("coalesces concurrent requests and runs again after settlement", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codenomad-git-status-"))
    let calls = 0
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const run = async () => {
      calls += 1
      await blocked
      return { ok: true as const, stdout: "" }
    }

    try {
      const first = getWorktreeGitStatus({ workspaceFolder: directory }, run)
      const second = getWorktreeGitStatus({ workspaceFolder: path.join(directory, ".") }, run)
      const deadline = Date.now() + 1_000
      while (calls === 0 && Date.now() < deadline) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      assert.equal(calls, 5)
      release()
      assert.deepEqual(await Promise.all([first, second]), [[], []])
      assert.equal(calls, 5)

      await getWorktreeGitStatus({ workspaceFolder: directory }, run)
      assert.equal(calls, 10)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("starts a new generation after a successful mutation while an older read is blocked", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codenomad-git-status-"))
    let calls = 0
    let releaseOld!: () => void
    const oldBlocked = new Promise<void>((resolve) => { releaseOld = resolve })
    const run = async () => {
      calls += 1
      if (calls <= 5) await oldBlocked
      return { ok: true as const, stdout: "" }
    }

    try {
      const oldRead = getWorktreeGitStatus({ workspaceFolder: directory }, run)
      while (calls < 5) await new Promise<void>((resolve) => setImmediate(resolve))
      await invalidateWorktreeGitStatus(path.join(directory, "."))
      const newRead = getWorktreeGitStatus({ workspaceFolder: directory }, run)
      assert.deepEqual(await newRead, [])
      assert.equal(calls, 10)
      releaseOld()
      assert.deepEqual(await oldRead, [])

      await getWorktreeGitStatus({ workspaceFolder: directory }, run)
      assert.equal(calls, 15)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("cleans up a rejected flight so the next read can retry", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codenomad-git-status-"))
    let fail = true
    let calls = 0
    const run = async () => {
      calls += 1
      return fail
        ? { ok: false as const, error: new Error("status failed") }
        : { ok: true as const, stdout: "" }
    }

    try {
      await assert.rejects(getWorktreeGitStatus({ workspaceFolder: directory }, run), /status failed/)
      fail = false
      assert.deepEqual(await getWorktreeGitStatus({ workspaceFolder: directory }, run), [])
      assert.equal(calls, 10)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
