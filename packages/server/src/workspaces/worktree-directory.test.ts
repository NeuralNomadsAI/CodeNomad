import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { isPathWithinWorktree, resolveOwnedWorktreePath } from "./worktree-directory"

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
  assert.equal((await resolveOwnedWorktreePath({ workspaceId, workspacePath: root, directory: root }))?.slug, "root")
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
    workspaceId,
    workspacePath: root,
    directory: path.join(alias, "nested"),
  })

  assert.equal(resolved?.slug, "doomed")
  assert.equal(resolved?.directory, await realpath(path.join(worktree, "nested")))
  assert.equal((await resolveOwnedWorktreePath({
    workspaceId,
    workspacePath: root,
    directory: path.join(worktree, "missing", "nested"),
  }))?.slug, "doomed")
  assert.equal(await resolveOwnedWorktreePath({ workspaceId, workspacePath: root, directory: path.join(dangling, "nested") }), null)
  assert.equal(isPathWithinWorktree("\\\\wsl.localhost\\Ubuntu\\repo\\Foo", "\\\\wsl.localhost\\Ubuntu\\repo\\foo\\nested"), false)
  assert.equal(isPathWithinWorktree("\\\\wsl.localhost\\Ubuntu\\repo\\Foo", "\\\\wsl.localhost\\Ubuntu\\repo\\Foo\\nested"), true)
  assert.equal(isPathWithinWorktree("\\\\WSL.LOCALHOST\\ubuntu\\repo\\Foo", "\\\\wsl.localhost\\Ubuntu\\repo\\Foo\\nested"), true)
})
