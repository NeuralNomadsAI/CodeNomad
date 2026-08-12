import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { acquireGitRepositoryLock } from "./git-repository-lock"

test("repository lock supports repositories without commits", async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "codenomad-empty-git-lock-"))
  try {
    execFileSync("git", ["init"], { cwd: repository })
    const release = await acquireGitRepositoryLock(repository)
    await release()
  } finally {
    await rm(repository, { recursive: true, force: true })
  }
})

test("repository lock serializes holders and releases on abort", async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "codenomad-git-lock-"))
  try {
    execFileSync("git", ["init"], { cwd: repository })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repository })
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repository })
    execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: repository })
    const first = await acquireGitRepositoryLock(repository)
    let secondAcquired = false
    const second = acquireGitRepositoryLock(repository).then((release) => {
      secondAcquired = true
      return release
    })
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(secondAcquired, false)
    await first()
    const releaseSecond = await second
    assert.equal(secondAcquired, true)
    await releaseSecond()
  } finally {
    await rm(repository, { recursive: true, force: true })
  }
})
