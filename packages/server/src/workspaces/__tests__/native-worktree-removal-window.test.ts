import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import type { OpenCodeClient } from "@opencode/client"
import { listNativeWorktrees } from "../native-worktrees"

test("a registered worktree whose Git layout is being removed is omitted without failing the inventory", async t => {
  const parent = process.platform === "win32" ? path.join(tmpdir(), "opencode") : tmpdir()
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, "worktree-removal-window-"))
  const repo = path.join(root, "main")
  const healthy = path.join(root, "healthy")
  const removing = path.join(root, "removing")
  const orphaned = path.join(root, "orphaned")
  const git = (directory: string, ...args: string[]) => execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim()
  try {
    git(root, "init", "--initial-branch=main", repo)
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial")
    for (const directory of [healthy, removing, orphaned]) git(repo, "worktree", "add", "--detach", directory)
    // Native registration still lists every entry, as during a removal.
    const registered = git(repo, "worktree", "list", "--porcelain", "-z").split("\0")
      .filter(field => field.startsWith("worktree ")).map(field => ({ directory: field.slice(9) }))
    assert.equal(registered.length, 4)
    // `git worktree remove` deletes `.git` first and the rest of the folder later.
    await rm(path.join(removing, ".git"), { force: true })
    // A removal can also delete the administrative directory between Git's
    // annotation snapshot and the entry's inspection, leaving the `.git` pointer.
    const admin = git(orphaned, "rev-parse", "--absolute-git-dir")
    const orphanedHost = await realpath(orphaned)
    let raced = false

    const client = {
      location: { get: async ({ location }: { location: { directory: string } }) => {
        const directory = git(location.directory, "rev-parse", "--show-toplevel")
        const common = git(directory, "rev-parse", "--path-format=absolute", "--git-common-dir")
        return { directory: location.directory, project: { id: "fixture", directory, canonical: path.dirname(common) } }
      } },
      worktree: {
        refresh: async () => {},
        list: async () => registered,
      },
    } as unknown as OpenCodeClient
    const inventory = await listNativeWorktrees({ client, workspacePath: repo, location: { directory: repo },
      toHost: async directory => {
        // Inspection translates each entry after the annotation snapshot was read.
        if (!raced && await realpath(directory).catch(() => undefined) === orphanedHost) {
          raced = true
          await rm(admin, { recursive: true, force: true })
        }
        return directory
      } }, { refresh: false })
    assert.equal(raced, true, "the administrative directory disappeared during inspection")

    const listed = await Promise.all(inventory.worktrees.map(entry => realpath(entry.registeredDirectory ?? entry.directory)))
    assert.deepEqual(new Set(listed), new Set([await realpath(repo), await realpath(healthy)]))
    assert.equal(inventory.worktrees.find(entry => entry.kind === "root")?.directory, repo)
  } finally {
    await rm(root, { recursive: true, force: true })
    t.diagnostic(`Owned fixture removed: ${root}`)
  }
})
