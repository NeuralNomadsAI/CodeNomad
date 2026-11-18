import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import type { OpenCodeClient } from "@opencode/client"
import { createNativeWorktree, listNativeWorktrees, NestedFolderUnavailableError } from "../native-worktrees"

test("sibling checkouts without the opened nested folder keep ownership but are flagged, and creation refuses them", async t => {
  const parent = process.platform === "win32" ? path.join(tmpdir(), "opencode") : tmpdir()
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, "worktree-nested-workspace-"))
  const repo = path.join(root, "main")
  const sibling = path.join(root, "sibling")
  const holder = path.join(root, "holder")
  const blocked = path.join(root, "blocked")
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
    for (const directory of [sibling, holder, blocked]) git(repo, "worktree", "add", "--detach", directory)
    // An ignored folder of the main checkout, opened as its own project: absent from
    // `sibling`, present in `holder`, and a regular file in `blocked`.
    const ignored = path.join(repo, ".tmp", "project")
    await mkdir(ignored, { recursive: true })
    await mkdir(path.join(holder, ".tmp", "project"), { recursive: true })
    await mkdir(path.join(blocked, ".tmp"), { recursive: true })
    await writeFile(path.join(blocked, ".tmp", "project"), "not a folder")
    const registered = git(repo, "worktree", "list", "--porcelain", "-z").split("\0")
      .filter(field => field.startsWith("worktree ")).map(field => ({ directory: field.slice(9) }))
    let nativeCreates = 0
    const client = {
      location: { get: async ({ location }: { location: { directory: string } }) => {
        const directory = git(location.directory, "rev-parse", "--show-toplevel")
        const common = git(directory, "rev-parse", "--path-format=absolute", "--git-common-dir")
        return { directory: location.directory, project: { id: "fixture", directory, canonical: path.dirname(common) } }
      } },
      worktree: {
        refresh: async () => {},
        list: async () => registered,
        create: async () => {
          nativeCreates++
          throw new Error("native creation reached")
        },
      },
    } as unknown as OpenCodeClient
    const context = (workspacePath: string) => ({ client, workspacePath, location: { directory: workspacePath },
      toHost: async (directory: string) => directory })
    const missing = async (workspacePath: string) => Object.fromEntries((await listNativeWorktrees(context(workspacePath), { refresh: false }))
      .worktrees.map(entry => [entry.directory, Boolean(entry.nestedFolderMissing)]))

    const mirror = async (checkout: string) => path.join(await realpath(checkout), ".tmp", "project")
    assert.deepEqual(await missing(ignored), {
      [ignored]: false,
      [await mirror(sibling)]: true,
      [await mirror(holder)]: false,
      [await mirror(blocked)]: true,
    }, "every registered checkout keeps its ownership; only those holding the folder are usable locations")

    const tracked = path.join(repo, "packages", "app")
    assert.ok(Object.values(await missing(tracked)).every(flag => !flag), "a tracked nested folder exists in every sibling")

    await assert.rejects(createNativeWorktree(context(ignored), "from-ignored"), NestedFolderUnavailableError)
    assert.equal(nativeCreates, 0, "an untracked opened folder is refused before any checkout is created")
    assert.equal(git(repo, "branch", "--list", "from-ignored"), "", "the refused creation leaves no branch")
    await assert.rejects(createNativeWorktree(context(tracked), "from-tracked"), /native creation reached/)
    assert.equal(nativeCreates, 1, "a tracked nested folder proceeds to native creation")
  } finally {
    await rm(root, { recursive: true, force: true })
    t.diagnostic(`Owned fixture removed: ${root}`)
  }
})
