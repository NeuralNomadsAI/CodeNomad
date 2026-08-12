import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import { isManagedWorktree } from "./git-worktrees"

test("managed worktrees require a canonical direct child with Git metadata", async () => {
  const temp = mkdtempSync(path.join(tmpdir(), "codenomad-managed-worktree-"))
  const repoRoot = path.join(temp, "repo")
  const managed = path.join(repoRoot, ".codenomad", "worktrees", "review")
  const metadata = path.join(repoRoot, ".git", "worktrees", "review")
  const external = path.join(repoRoot, "..", "external")
  try {
    mkdirSync(managed, { recursive: true })
    mkdirSync(metadata, { recursive: true })
    mkdirSync(external, { recursive: true })
    writeFileSync(path.join(managed, ".git"), `gitdir: ${metadata}\n`)

    assert.equal(await isManagedWorktree({
      repoRoot,
      worktree: { slug: "review", directory: managed, kind: "worktree" },
    }), true)
    assert.equal(await isManagedWorktree({
      repoRoot,
      worktree: { slug: "review", directory: external, kind: "worktree" },
    }), false)
    rmSync(path.join(managed, ".git"))
    assert.equal(await isManagedWorktree({
      repoRoot,
      worktree: { slug: "review", directory: managed, kind: "worktree" },
    }), false)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test("managed worktree root cannot redirect outside the repository", async () => {
  const temp = mkdtempSync(path.join(tmpdir(), "codenomad-managed-root-"))
  const repoRoot = path.join(temp, "repo")
  const externalRoot = path.join(temp, "external-worktrees")
  const directory = path.join(externalRoot, "review")
  const metadata = path.join(repoRoot, ".git", "worktrees", "review")
  try {
    mkdirSync(path.join(repoRoot, ".codenomad"), { recursive: true })
    mkdirSync(directory, { recursive: true })
    mkdirSync(metadata, { recursive: true })
    writeFileSync(path.join(directory, ".git"), `gitdir: ${metadata}\n`)
    symlinkSync(externalRoot, path.join(repoRoot, ".codenomad", "worktrees"), "junction")

    assert.equal(await isManagedWorktree({
      repoRoot,
      worktree: { slug: "review", directory, kind: "worktree" },
    }), false)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
