import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { invalidateWorktreeCache, isPathWithinWorktree, resolveOwnedWorktreePath } from "./worktree-directory"
import { fixtureCatalogue } from "./__tests__/native-worktree-fixture"

test("concurrent ownership misses share a refresh and cache negative results until invalidation", async (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), "codenomad-inventory-misses-"))
  t.after(() => { invalidateWorktreeCache(temp); rmSync(temp, { recursive: true, force: true }) })
  const root = path.join(temp, "repo")
  const foreign = path.join(temp, "foreign")
  mkdirSync(root)
  mkdirSync(foreign)
  let loads = 0
  const loadWorktrees = async () => {
    loads++
    await new Promise(resolve => setTimeout(resolve, 30))
    return [{ slug: "root", directory: root, kind: "root" as const }]
  }
  const params = { workspaceId: temp, workspacePath: root, loadWorktrees }
  await resolveOwnedWorktreePath({ ...params, directory: root })
  const results = await Promise.all(Array.from({ length: 40 }, () => resolveOwnedWorktreePath({ ...params, directory: foreign })))
  assert.ok(results.every(result => result === null))
  assert.equal(loads, 2)
  await resolveOwnedWorktreePath({ ...params, directory: foreign })
  assert.equal(loads, 2)
  invalidateWorktreeCache(temp)
  await resolveOwnedWorktreePath({ ...params, directory: foreign })
  assert.ok(loads > 2)
})

test("resolves nested and junction paths to their canonical owning worktree", async (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), "codenomad-worktree-path-"))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const root = path.join(temp, "repo")
  const worktree = path.join(root, ".codenomad", "worktrees", "doomed")
  const alias = path.join(temp, "alias")
  mkdirSync(root)
  execFileSync("git", ["init", "--initial-branch=main", root])
  writeFileSync(path.join(root, "README.md"), "test\n")
  execFileSync("git", ["-C", root, "add", "README.md"])
  execFileSync("git", ["-C", root, "-c", "user.name=CodeNomad Test", "-c", "user.email=test@codenomad.local", "commit", "-m", "test"])
  const workspaceId = `workspace-${Date.now()}`
  const loadWorktrees = async () => (await fixtureCatalogue(root)).worktrees
  assert.equal((await resolveOwnedWorktreePath({ workspaceId, workspacePath: root, directory: root, loadWorktrees }))?.slug, "root")
  mkdirSync(path.dirname(worktree), { recursive: true })
  execFileSync("git", ["-C", root, "worktree", "add", "-b", "doomed", worktree])
  mkdirSync(path.join(worktree, "nested"))
  symlinkSync(worktree, alias, "junction")
  const external = path.join(temp, "external")
  const dangling = path.join(worktree, "dangling")
  mkdirSync(external)
  symlinkSync(external, dangling, "junction")
  rmSync(external, { recursive: true })

  const resolved = await resolveOwnedWorktreePath({
    loadWorktrees,
    workspaceId,
    workspacePath: root,
    directory: path.join(alias, "nested"),
  })

  const expectedSlug = (await loadWorktrees()).find(entry => entry.branch === "doomed")!.slug
  assert.equal(resolved?.slug, expectedSlug)
  assert.equal(resolved?.directory, await realpath(path.join(worktree, "nested")))
  assert.equal(resolved?.worktreeDirectory, await realpath(worktree))
  assert.equal((await resolveOwnedWorktreePath({
    loadWorktrees,
    workspaceId,
    workspacePath: root,
    directory: path.join(worktree, "missing", "nested"),
  }))?.slug, expectedSlug)
  assert.equal(await resolveOwnedWorktreePath({ workspaceId, workspacePath: root, directory: path.join(dangling, "nested"), loadWorktrees }), null)
  assert.equal(isPathWithinWorktree("\\\\wsl.localhost\\Ubuntu\\repo\\Foo", "\\\\wsl.localhost\\Ubuntu\\repo\\foo\\nested"), false)
  assert.equal(isPathWithinWorktree("\\\\wsl.localhost\\Ubuntu\\repo\\Foo", "\\\\wsl.localhost\\Ubuntu\\repo\\Foo\\nested"), true)
  assert.equal(isPathWithinWorktree("\\\\WSL.LOCALHOST\\ubuntu\\repo\\Foo", "\\\\wsl.localhost\\Ubuntu\\repo\\Foo\\nested"), true)
})
