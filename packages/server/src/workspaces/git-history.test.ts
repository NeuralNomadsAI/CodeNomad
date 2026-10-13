import assert from "node:assert/strict"
import { test } from "node:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { getGitHistory, getGitCommit, getGitCommitDiff } from "./git-history"

test("history reads real root, renamed, deleted, binary and merge files without changing HEAD", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-history-"))
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim()
  const commit = (message: string) => { git("add", "."); git("commit", "-m", message); return git("rev-parse", "HEAD") }
  try {
    git("init", "-b", "main")
    git("config", "user.name", "History Fixture")
    git("config", "user.email", "fixture@example.invalid")
    git("config", "core.autocrlf", "false")
    assert.deepEqual((await getGitHistory(root)).commits, [])
    await writeFile(path.join(root, "before name.txt"), "before\n")
    const first = commit("Initial history")
    assert.equal((await getGitHistory(root)).branch, "main")
    assert.deepEqual(await getGitCommitDiff(root, first, "before name.txt"), { path: "before name.txt", before: "", after: "before\n", isBinary: false })
    git("mv", "before name.txt", "after name.txt")
    const renamed = commit("Rename file")
    assert.deepEqual((await getGitCommit(root, renamed)).files, [{ path: "after name.txt", originalPath: "before name.txt", status: "R" }])
    assert.equal((await getGitCommitDiff(root, renamed, "after name.txt")).before, "before\n")
    git("rm", "after name.txt")
    await writeFile(path.join(root, "binary.dat"), Buffer.from([0, 1, 2]))
    const deleted = commit("Delete text and add binary")
    assert.equal((await getGitCommitDiff(root, deleted, "after name.txt")).after, "")
    assert.equal((await getGitCommitDiff(root, deleted, "binary.dat")).isBinary, true)
    await assert.rejects(getGitCommitDiff(root, deleted, "../outside"), /does not belong/)
    await assert.rejects(getGitCommit(root, "--output=escape"), /Invalid commit/)
    const blob = git("rev-parse", `${deleted}:binary.dat`)
    await assert.rejects(getGitCommit(root, blob), /not a commit/)
    git("checkout", "-b", "side")
    await writeFile(path.join(root, "side.txt"), "side\n")
    commit("Side branch")
    git("checkout", "main")
    git("merge", "--no-ff", "side", "-m", "Merge side")
    const head = git("rev-parse", "HEAD")
    const history = await getGitHistory(root)
    assert.equal(history.commits[0]?.id, head)
    assert.equal(history.commits[0]?.parents.length, 2)
    assert.equal((await getGitCommit(root, head)).parent, deleted)
    assert.equal((await getGitCommitDiff(root, head, "side.txt")).after, "side\n")
    assert.equal(git("rev-parse", "HEAD"), head)
    assert.equal(git("status", "--porcelain"), "")
    git("update-index", "--add", "--cacheinfo", `160000,${first},nested-repository`)
    git("commit", "-m", "Add submodule reference")
    const submodule = await getGitCommitDiff(root, git("rev-parse", "HEAD"), "nested-repository")
    assert.equal(submodule.after, `Subproject commit ${first}\n`)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("history pages retain their original HEAD when a new commit arrives", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-history-pages-"))
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim()
  try {
    git("init", "-b", "main")
    git("config", "user.name", "History Fixture")
    git("config", "user.email", "fixture@example.invalid")
    for (let i = 0; i < 52; i++) git("commit", "--allow-empty", "-m", `Commit ${i}`)
    const first = await getGitHistory(root)
    assert.equal(first.commits.length, 50)
    assert.equal(first.hasMore, true)
    git("commit", "--allow-empty", "-m", "New head")
    const second = await getGitHistory(root, 50, first.head!)
    assert.equal(second.commits.length, 2)
    assert.equal(second.commits[1]?.subject, "Commit 0")
    assert.equal(second.hasMore, false)
    assert.equal(new Set([...first.commits, ...second.commits].map(commit => commit.id)).size, 52)
    await assert.rejects(getGitHistory(root, -1), /Invalid history/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
