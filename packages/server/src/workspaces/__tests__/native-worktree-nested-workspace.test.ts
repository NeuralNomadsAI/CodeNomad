import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import type { OpenCodeClient } from "@opencode/client"
import { listNativeWorktrees } from "../native-worktrees"

test("a nested workspace lists only the sibling checkouts that contain its folder", async t => {
  const parent = process.platform === "win32" ? path.join(tmpdir(), "opencode") : tmpdir()
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, "worktree-nested-workspace-"))
  const repo = path.join(root, "main")
  const sibling = path.join(root, "sibling")
  const git = (directory: string, ...args: string[]) => execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim()
  try {
    git(root, "init", "--initial-branch=main", repo)
    await mkdir(path.join(repo, "packages", "app"), { recursive: true })
    await writeFile(path.join(repo, "packages", "app", "base.txt"), "base")
    await writeFile(path.join(repo, ".gitignore"), ".tmp/\n")
    git(repo, "add", ".")
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial")
    git(repo, "worktree", "add", "--detach", sibling)
    // An ignored folder of the main checkout, opened as its own project, exists in no sibling.
    const ignored = path.join(repo, ".tmp", "project")
    await mkdir(ignored, { recursive: true })
    const registered = git(repo, "worktree", "list", "--porcelain", "-z").split("\0")
      .filter(field => field.startsWith("worktree ")).map(field => ({ directory: field.slice(9) }))
    const client = {
      location: { get: async ({ location }: { location: { directory: string } }) => {
        const directory = git(location.directory, "rev-parse", "--show-toplevel")
        const common = git(directory, "rev-parse", "--path-format=absolute", "--git-common-dir")
        return { directory: location.directory, project: { id: "fixture", directory, canonical: path.dirname(common) } }
      } },
      worktree: { refresh: async () => {}, list: async () => registered },
    } as unknown as OpenCodeClient
    const list = (workspacePath: string) => listNativeWorktrees({ client, workspacePath, location: { directory: workspacePath },
      toHost: async directory => directory }, { refresh: false })

    const ignoredInventory = await list(ignored)
    assert.deepEqual(ignoredInventory.worktrees.map(entry => entry.directory), [ignored],
      "a sibling checkout without the opened folder is no location of this workspace")

    const tracked = path.join(repo, "packages", "app")
    const trackedInventory = await list(tracked)
    assert.deepEqual(new Set(trackedInventory.worktrees.map(entry => entry.directory)),
      new Set([tracked, path.join(await realpath(sibling), "packages", "app")]), "a tracked nested folder keeps its sibling checkout")
  } finally {
    await rm(root, { recursive: true, force: true })
    t.diagnostic(`Owned fixture removed: ${root}`)
  }
})
