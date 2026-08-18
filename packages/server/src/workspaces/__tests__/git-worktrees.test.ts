import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { listWorktrees } from "../git-worktrees"

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

      const worktrees = await listWorktrees({ repoRoot, workspaceFolder })

      assert.equal(worktrees[0]?.slug, "root")
      assert.equal(worktrees[0]?.directory, workspaceFolder)
      assert.equal(worktrees[0]?.kind, "root")
      assert.equal(worktrees[0]?.branch, "main")
      assert.notEqual(worktrees[0]?.directory, repoRoot)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })
})
