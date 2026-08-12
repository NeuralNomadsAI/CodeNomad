import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { listWorktrees } from "../git-worktrees"

describe("listWorktrees", () => {
  it("uses the selected workspace folder for the root worktree directory", async () => {
    const temp = mkdtempSync(path.join(tmpdir(), "codenomad-git-worktrees-"))
    const repoRoot = path.join(temp, "repo")
    const workspaceFolder = path.join(repoRoot, "proj-1")
    const linkedDirectory = path.join(temp, "feature-worktree")

    try {
      mkdirSync(workspaceFolder, { recursive: true })
      execFileSync("git", ["init", "-b", "main", repoRoot], { stdio: "ignore" })
      execFileSync("git", ["-C", repoRoot, "-c", "user.name=CodeNomad", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init"], { stdio: "ignore" })
      execFileSync("git", ["-C", repoRoot, "worktree", "add", "-b", "feature", linkedDirectory], { stdio: "ignore" })

      const worktrees = await listWorktrees({ repoRoot, workspaceFolder })

      assert.equal(worktrees[0]?.slug, "root")
      assert.equal(worktrees[0]?.directory, workspaceFolder)
      assert.equal(worktrees[0]?.kind, "root")
      assert.equal(worktrees[0]?.branch, "main")
      assert.equal(path.resolve(worktrees[0]?.registeredDirectory ?? ""), path.resolve(repoRoot))
      assert.notEqual(worktrees[0]?.directory, repoRoot)
      const linked = worktrees.find(({ slug }) => slug === "feature")
      assert.equal(path.resolve(linked?.directory ?? ""), path.resolve(linkedDirectory, "proj-1"))
      assert.equal(path.resolve(linked?.registeredDirectory ?? ""), path.resolve(linkedDirectory))
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })
})
