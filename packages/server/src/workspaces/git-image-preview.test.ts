import assert from "node:assert/strict"
import { test } from "node:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { getWorktreeGitDiff } from "./git-status"
import { getGitCommitDiff } from "./git-history"
import { runGitProcess } from "./git-process"

test("image previews retain exact HEAD/index/worktree and historical bytes with bounded reads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-image-preview-"))
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim()
  const initial = Buffer.from([137, 80, 78, 71, 0, 13, 10, 255, 128])
  const indexed = Buffer.from([...initial, 1])
  const working = Buffer.from([...indexed, 2])
  const diff = (scope: "staged" | "unstaged", file = "image.png") => getWorktreeGitDiff({ workspaceFolder: root, path: file, scope })
  try {
    git("init", "-b", "main")
    git("config", "user.name", "Image Fixture")
    git("config", "user.email", "fixture@example.invalid")
    git("config", "core.autocrlf", "false")
    await writeFile(path.join(root, "image.png"), initial)
    assert.deepEqual((await diff("unstaged")).image, { mime: "image/png", before: null, after: initial.toString("base64") })
    git("add", ".")
    git("commit", "-m", "Initial image")
    const first = git("rev-parse", "HEAD")
    assert.deepEqual((await getGitCommitDiff(root, first, "image.png")).image, { mime: "image/png", before: null, after: initial.toString("base64") })
    await writeFile(path.join(root, "image.png"), indexed)
    git("add", ".")
    await writeFile(path.join(root, "image.png"), working)
    assert.deepEqual((await diff("staged")).image, { mime: "image/png", before: initial.toString("base64"), after: indexed.toString("base64") })
    assert.deepEqual((await diff("unstaged")).image, { mime: "image/png", before: indexed.toString("base64"), after: working.toString("base64") })
    git("commit", "-m", "Indexed image only")
    const second = git("rev-parse", "HEAD")
    assert.deepEqual((await getGitCommitDiff(root, second, "image.png")).image, { mime: "image/png", before: initial.toString("base64"), after: indexed.toString("base64") })
    await assert.rejects(getGitCommitDiff(root, second, "outside.png"), /does not belong/)
    git("add", ".")
    git("commit", "-m", "Working image")
    git("mv", "image.png", "renamed.png")
    git("commit", "-m", "Rename image")
    const renamed = await getGitCommitDiff(root, git("rev-parse", "HEAD"), "renamed.png")
    assert.equal(renamed.image?.before, working.toString("base64"))
    assert.equal(renamed.image?.after, working.toString("base64"))
    git("rm", "renamed.png")
    assert.equal((await diff("staged", "renamed.png")).image?.after, null)
    git("commit", "-m", "Delete image")
    assert.equal((await getGitCommitDiff(root, git("rev-parse", "HEAD"), "renamed.png")).image?.after, null)
    await writeFile(path.join(root, "large.png"), Buffer.alloc(6 * 1024 * 1024))
    await assert.rejects(diff("unstaged", "large.png"), /too large/)
    git("add", "large.png")
    await assert.rejects(runGitProcess(root, ["cat-file", "blob", ":large.png"], { encoding: "base64", maxBuffer: 1024 }), /maxBuffer/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
