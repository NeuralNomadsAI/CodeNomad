import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { readWorktreeMap, writeWorktreeMap } from "./worktree-map"

test("malformed worktree maps fail without being replaced", async () => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-worktree-map-"))
  try {
    execFileSync("git", ["init"], { cwd: repository })
    const mapPath = path.join(repository, ".codenomad", "worktreeMap.json")
    await fs.mkdir(path.dirname(mapPath), { recursive: true })
    await fs.writeFile(mapPath, "{malformed", "utf8")

    await assert.rejects(readWorktreeMap(repository))
    assert.equal(await fs.readFile(mapPath, "utf8"), "{malformed")
  } finally {
    await fs.rm(repository, { recursive: true, force: true })
  }
})

test("linked worktrees share one worktree map", async () => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-linked-map-"))
  const linked = path.join(path.dirname(repository), `${path.basename(repository)}-linked`)
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: repository })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repository })
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repository })
    execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: repository })
    execFileSync("git", ["worktree", "add", "-b", "feature", linked], { cwd: repository })

    const map = { version: 1 as const, defaultWorktreeSlug: "root", parentSessionWorktreeSlug: { session: "feature" } }
    await writeWorktreeMap(repository, map)
    assert.deepEqual(await readWorktreeMap(linked), map)
  } finally {
    await fs.rm(linked, { recursive: true, force: true })
    await fs.rm(repository, { recursive: true, force: true })
  }
})
