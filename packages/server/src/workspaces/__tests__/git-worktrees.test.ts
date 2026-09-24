import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { fixtureCatalogue } from "./native-worktree-fixture"

describe("listWorktrees", () => {
  it("uses the selected workspace folder for the root worktree directory", async () => {
    const temp = mkdtempSync(path.join(tmpdir(), "codenomad-git-worktrees-"))
    const repoRoot = path.join(temp, "repo")
    const workspaceFolder = path.join(repoRoot, "proj-1")

    try {
      execFileSync("git", ["init", "--initial-branch=main", repoRoot])
      mkdirSync(workspaceFolder, { recursive: true })
      writeFileSync(path.join(repoRoot, "README.md"), "test\n")
      execFileSync("git", ["-C", repoRoot, "add", "README.md"])
      execFileSync("git", ["-C", repoRoot, "-c", "user.name=CodeNomad Test", "-c", "user.email=test@codenomad.local", "commit", "-m", "test"])

      const { worktrees } = await fixtureCatalogue(workspaceFolder)

      assert.equal(worktrees[0]?.slug, "root")
      assert.equal(worktrees[0]?.directory, workspaceFolder)
      assert.equal(worktrees[0]?.kind, "root")
      assert.equal(worktrees[0]?.branch, "main")
      assert.notEqual(worktrees[0]?.directory, repoRoot)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it("batches named and detached annotations while retaining native membership and physical repository ownership", async () => {
    const temp = mkdtempSync(path.join(tmpdir(), "codenomad-worktree-annotations-"))
    const repo = path.join(temp, "main repo")
    const named = path.join(temp, "named checkout")
    const detached = path.join(temp, "detached checkout")
    const gitOnly = path.join(temp, "not in native inventory")
    const foreign = path.join(temp, "independent clone")
    const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim()
    try {
      git("init", "--initial-branch=main", repo)
      git("-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial")
      const head = git("-C", repo, "rev-parse", "HEAD")
      git("-C", repo, "worktree", "add", "-b", "feature/named", named)
      git("-C", repo, "worktree", "add", "--detach", detached)
      git("-C", repo, "worktree", "add", "--detach", gitOnly)
      git("clone", "--local", repo, foreign)
      const directories = [repo, named, detached, foreign]
      const catalogue = await fixtureCatalogue(repo, directories)
      assert.equal(catalogue.worktrees.length, 3)
      const entry = catalogue.worktrees.find(item => item.directory === realpathSync(named))!
      assert.equal(entry.branch, "feature/named")
      assert.equal(entry.head, head)
      assert.equal(entry.removable, true)
      const detachedEntry = catalogue.worktrees.find(item => item.directory === realpathSync(detached))!
      assert.equal(detachedEntry.branch, undefined)
      assert.equal(detachedEntry.head, head)
      assert.match(detachedEntry.label!, /detached checkout @ /)
      assert.equal(catalogue.worktrees[0].removable, false)

      const pointer = readFileSync(path.join(named, ".git"), "utf8")
      try {
        // A registered path can be replaced. Its current Git identity must still
        // belong to this repository; a stale registration alone is insufficient.
        rmSync(path.join(named, ".git"))
        writeFileSync(path.join(named, ".git"), `gitdir: ${path.join(foreign, ".git")}\n`)
        const replaced = await fixtureCatalogue(repo, directories)
        assert.equal(replaced.worktrees.some(item => item.directory === realpathSync(named)), false)
        writeFileSync(path.join(named, ".git"), readFileSync(path.join(detached, ".git")))
        await assert.rejects(fixtureCatalogue(repo, directories), /not a checkout root/)
      } finally {
        rmSync(path.join(named, ".git"), { force: true })
        writeFileSync(path.join(named, ".git"), pointer)
      }
    } finally { rmSync(temp, { recursive: true, force: true }) }
  })
})
