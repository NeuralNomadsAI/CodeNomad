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

test("creation for an expected tip refuses a missing or moved branch before any checkout exists", async t => {
  const root = await mkdtemp(path.join(process.platform === "win32" ? path.join(tmpdir(), "opencode") : tmpdir(), "worktree-expected-tip-"))
  const repo = path.join(root, "main")
  const git = (directory: string, ...args: string[]) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  try {
    git(root, "init", "--initial-branch=main", repo)
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "one")
    const first = git(repo, "rev-parse", "HEAD")
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "two")
    git(repo, "branch", "issue-12", first)
    let nativeCreates = 0
    const client = {
      location: { get: async () => ({ directory: repo, project: { id: "fixture", directory: repo, canonical: repo } }) },
      worktree: { refresh: async () => {}, list: async () => [{ directory: repo }], create: async () => { nativeCreates++; throw new Error("native creation reached") } },
    } as unknown as OpenCodeClient
    const context = { client, workspacePath: repo, location: { directory: repo }, toHost: async (directory: string) => directory }
    await assert.rejects(createNativeWorktree(context, "issue-13", "root", first), /Branch changed/)
    assert.equal(git(repo, "branch", "--list", "issue-13"), "", "a missing branch is never created from HEAD")
    await assert.rejects(createNativeWorktree(context, "issue-12", "root", git(repo, "rev-parse", "HEAD")), /Branch changed/)
    assert.equal(nativeCreates, 0)
    await assert.rejects(createNativeWorktree(context, "issue-12", "root", first), /native creation reached/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test("creation for an expected tip never lets Git guess a deleted branch from a remote-tracking one", async () => {
  const root = await mkdtemp(path.join(process.platform === "win32" ? path.join(tmpdir(), "opencode") : tmpdir(), "worktree-no-guess-"))
  const repo = path.join(root, "main"), child = path.join(repo, ".codenomad", "worktrees", "issue-12")
  const git = (directory: string, ...args: string[]) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  try {
    git(root, "init", "--initial-branch=main", repo)
    await mkdir(path.dirname(child), { recursive: true })
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "one")
    const tip = git(repo, "rev-parse", "HEAD")
    git(repo, "branch", "issue-12", tip)
    git(repo, "remote", "add", "origin", "https://example.com/o/r.git")
    git(repo, "update-ref", "refs/remotes/origin/issue-12", tip)
    let created = false
    const client = {
      location: { get: async () => ({ directory: repo, project: { id: "fixture", directory: repo, canonical: repo } }) },
      worktree: { refresh: async () => {}, list: async () => [{ directory: repo }, ...(created ? [{ directory: child }] : [])],
        // The branch disappears after the precheck.
        create: async () => { git(repo, "branch", "-D", "issue-12"); git(repo, "worktree", "add", "--detach", "-q", child, tip); created = true; return { directory: child } },
        remove: async () => { git(repo, "worktree", "remove", "--force", child); created = false } },
    } as unknown as OpenCodeClient
    await assert.rejects(createNativeWorktree({ client, workspacePath: repo, location: { directory: repo }, toHost: async (directory: string) => directory },
      "issue-12", "root", tip), /invalid reference|Branch changed/)
    assert.equal(git(repo, "branch", "--list", "issue-12"), "", "no branch was guessed back")
    assert.equal(created, false, "the checkout is removed")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test("creation for an expected tip accepts the branch when a tag has the same name", async () => {
  const root = await mkdtemp(path.join(process.platform === "win32" ? path.join(tmpdir(), "opencode") : tmpdir(), "worktree-tag-"))
  const repo = path.join(root, "main"), child = path.join(repo, ".codenomad", "worktrees", "issue-7")
  const git = (directory: string, ...args: string[]) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  try {
    git(root, "init", "--initial-branch=main", repo)
    await mkdir(path.dirname(child), { recursive: true })
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "one")
    const tip = git(repo, "rev-parse", "HEAD")
    git(repo, "branch", "issue-7", tip)
    git(repo, "tag", "issue-7", tip)
    let created = false
    const client = {
      location: { get: async () => ({ directory: repo, project: { id: "fixture", directory: repo, canonical: repo } }) },
      worktree: { refresh: async () => {}, list: async () => [{ directory: repo }, ...(created ? [{ directory: child }] : [])],
        create: async () => { git(repo, "worktree", "add", "--detach", "-q", child, tip); created = true; return { directory: child } },
        remove: async () => { git(repo, "worktree", "remove", "--force", child); created = false } },
    } as unknown as OpenCodeClient
    const result = await createNativeWorktree({ client, workspacePath: repo, location: { directory: repo }, toHost: async (directory: string) => directory },
      "issue-7", "root", tip)
    assert.equal(result.branch?.replace(/^heads\//, ""), "issue-7")
    assert.equal(git(child, "symbolic-ref", "HEAD"), "refs/heads/issue-7")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("creation retries an invalidated result inventory without repeating the creation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "worktree-create-config-race-"))
  const repo = path.join(root, "main"), child = path.join(repo, ".codenomad", "worktrees", "new-branch")
  const git = (directory: string, ...args: string[]) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  try {
    git(root, "init", "--initial-branch=main", repo)
    await mkdir(path.dirname(child), { recursive: true })
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "one")
    git(repo, "config", "extensions.worktreeConfig", "true")
    let creations = 0, resultReads = 0, changed = false
    const client = {
      location: { get: async () => ({ directory: repo, project: { id: "fixture", directory: repo, canonical: repo } }) },
      worktree: {
        refresh: async () => {},
        list: async () => {
          if (!creations) return [{ directory: repo }]
          resultReads++
          return [{ directory: repo }, { directory: child }]
        },
        create: async () => {
          assert.equal(++creations, 1)
          git(repo, "worktree", "add", "--detach", "-q", child, "HEAD")
          return { directory: child }
        },
      },
    } as unknown as OpenCodeClient
    const result = await createNativeWorktree({
      client, workspacePath: repo, location: { directory: repo },
      toHost: async directory => {
        if (directory === child && resultReads === 1 && !changed) {
          assert.equal(git(child, "symbolic-ref", "HEAD"), "refs/heads/new-branch")
          git(repo, "config", "user.name", "Changed during result scan")
          changed = true
        }
        return directory
      },
    }, "new-branch")
    assert.equal(changed, true)
    assert.equal(creations, 1)
    assert.equal(resultReads, 2)
    assert.equal(result.registeredDirectory, await realpath(child))
    assert.equal(result.branch, "new-branch")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
