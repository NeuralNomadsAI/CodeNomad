import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  findWorktreeSlugForDirectory,
  mapOpenCodeWorkspacesToWorktreeSlugs,
  workspaceDirectoriesEqual,
} from "./opencode-workspace-matching.ts"

describe("mapOpenCodeWorkspacesToWorktreeSlugs", () => {
  it("matches POSIX worktree directories case-sensitively", () => {
    const result = mapOpenCodeWorkspacesToWorktreeSlugs(
      [
        { slug: "feature", directory: "/Users/dev/Repo/.codenomad/worktrees/Feature" },
        { slug: "feature-lower", directory: "/Users/dev/Repo/.codenomad/worktrees/feature" },
      ],
      [
        { id: "wrk_exact", directory: "/Users/dev/Repo/.codenomad/worktrees/Feature" },
      ],
    )

    assert.equal(result.get("feature"), "wrk_exact")
    assert.equal(result.has("feature-lower"), false)
  })

  it("matches Windows drive paths case-insensitively and normalizes slashes", () => {
    const result = mapOpenCodeWorkspacesToWorktreeSlugs(
      [
        { slug: "test2", directory: String.raw`C:\Users\Dev\Repo\.codenomad\worktrees\test2` },
      ],
      [
        { id: "wrk_test2", directory: "c:/users/dev/repo/.codenomad/worktrees/test2/" },
      ],
    )

    assert.equal(result.get("test2"), "wrk_test2")
  })

  it("matches Windows UNC paths case-insensitively and normalizes slashes", () => {
    const result = mapOpenCodeWorkspacesToWorktreeSlugs(
      [
        { slug: "unc", directory: String.raw`\\server\Share\Repo\.codenomad\worktrees\unc` },
      ],
      [
        { id: "wrk_unc", directory: "//SERVER/share/repo/.codenomad/worktrees/unc" },
      ],
    )

    assert.equal(result.get("unc"), "wrk_unc")
  })

  it("does not map the root worktree", () => {
    const result = mapOpenCodeWorkspacesToWorktreeSlugs(
      [
        { slug: "root", directory: "/repo" },
      ],
      [
        { id: "wrk_root", directory: "/repo" },
      ],
    )

    assert.equal(result.size, 0)
  })
})

describe("findWorktreeSlugForDirectory", () => {
  const worktrees = [
    { slug: "root", directory: String.raw`C:\Users\Dev\Repo` },
    { slug: "feature", directory: String.raw`C:\Users\Dev\Repo\.codenomad\worktrees\feature` },
  ]

  it("matches a native session directory to its worktree", () => {
    assert.equal(findWorktreeSlugForDirectory(worktrees, "c:/users/dev/repo/.codenomad/worktrees/feature/"), "feature")
  })

  it("returns null for an unknown native directory", () => {
    assert.equal(findWorktreeSlugForDirectory(worktrees, "C:/other"), null)
  })
})

describe("workspaceDirectoriesEqual", () => {
  it("normalizes Windows casing, slashes, and trailing separators", () => {
    assert.equal(workspaceDirectoriesEqual(String.raw`C:\Repo\feature`, "c:/repo/feature/"), true)
    assert.equal(workspaceDirectoriesEqual("/Repo/feature", "/repo/feature"), false)
  })
})
