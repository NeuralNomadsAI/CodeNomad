import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import Fastify from "fastify"
import { WorkspaceManager } from "../../workspaces/manager"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { invalidateWorktreeCache } from "../../workspaces/worktree-directory"
import { registerWorkspaceRoutes } from "./workspaces"

test("real Git history routes and bounded file previews use the requested owned worktree", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codenomad-files-"))
  const root = path.join(temp, "root"), linked = path.join(temp, "linked"), outside = path.join(temp, "outside")
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim()
  const id = path.basename(temp)
  const app = Fastify()
  const ownershipReads: string[] = []
  try {
    await mkdir(root); await mkdir(outside)
    git(root, "init", "-b", "main")
    git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.invalid")
    await writeFile(path.join(root, "notes.txt"), "root content")
    git(root, "add", "."); git(root, "commit", "-m", "Root commit")
    git(root, "worktree", "add", "-b", "feature", linked)
    await writeFile(path.join(linked, "notes.txt"), "linked content")
    git(linked, "add", "."); git(linked, "commit", "-m", "Linked commit")
    await writeFile(path.join(outside, "secret.txt"), "outside authority")
    await writeFile(path.join(linked, "image.png"), Buffer.from([137, 80, 78, 71, 0, 13, 10]))
    await writeFile(path.join(linked, "oversize.bin"), Buffer.alloc(5 * 1024 * 1024 + 1))
    const workspace = { id, path: root }
    // Exercise the actual manager fileBrowserRoot + previewFile boundary. Native
    // discovery is isolated to an explicit inventory, with no shared daemon.
    const manager = Object.assign(Object.create(WorkspaceManager.prototype), {
      get: (requested: string) => requested === id ? workspace : undefined,
      requireWorkspace: (requested: string) => { if (requested !== id) throw new Error("Workspace not found"); return workspace },
      resolveOwnedWorktree: async (_workspace: unknown, directory: string) => {
        ownershipReads.push(directory)
        return directory === root || directory === linked ? { directory } : null
      },
      getWorktrees: async () => ({ worktrees: [
        { slug: "root", directory: root, kind: "root" }, { slug: "linked", directory: linked, kind: "worktree" },
      ] }),
    }) as WorkspaceManager
    registerWorkspaceRoutes(app, { workspaceManager: manager, worktreeDeletionFence: new WorktreeDeletionFence() })
    const base = `/api/workspaces/${id}`
    const preview = (file: string, directory: string) => app.inject(`${base}/files/preview?${new URLSearchParams({ path: file, directory })}`)
    const rootFile = await preview("notes.txt", root), linkedFile = await preview("notes.txt", linked)
    assert.equal(rootFile.statusCode, 200); assert.equal(linkedFile.statusCode, 200)
    assert.equal(Buffer.from(rootFile.json().contents, "base64").toString(), "root content")
    assert.equal(Buffer.from(linkedFile.json().contents, "base64").toString(), "linked content")
    assert.equal((await preview("image.png", linked)).json().encoding, "base64")
    assert.equal((await preview("oversize.bin", linked)).statusCode, 400)
    assert.equal((await preview("secret.txt", outside)).statusCode, 400)
    assert.equal((await preview("../outside/secret.txt", root)).statusCode, 400)
    assert.ok(ownershipReads.includes(outside))
    const history = await app.inject(`${base}/worktrees/linked/git-history`)
    assert.equal(history.statusCode, 200)
    assert.equal(history.json().branch, "feature")
    assert.equal(history.json().commits[0].subject, "Linked commit")
    const commit = history.json().commits[0].id
    const diff = await app.inject(`${base}/worktrees/linked/git-history/${commit}?path=notes.txt`)
    assert.equal(diff.statusCode, 200)
    assert.equal(diff.json().before, "root content"); assert.equal(diff.json().after, "linked content")
    assert.equal((await app.inject(`${base}/worktrees/missing/git-history`)).statusCode, 404)
    assert.equal((await app.inject(`${base}/worktrees/root/git-history?head=--all`)).statusCode, 400)
    assert.equal((await app.inject(`${base}/worktrees/root/git-history/${commit}?path=not-in-commit`)).statusCode, 400)
    assert.equal(git(root, "branch", "--show-current"), "main")
  } finally { invalidateWorktreeCache(id); await app.close(); await rm(temp, { recursive: true, force: true }) }
})

test("file preview remains available for an explicitly opened directory without Git", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-directory-preview-"))
  try {
    await writeFile(path.join(root, "readme.md"), "# Directory only")
    const manager = Object.assign(Object.create(WorkspaceManager.prototype), {
      requireWorkspace: () => ({ path: root }),
      resolveOwnedWorktree: async (_workspace: unknown, directory: string) => directory === root ? { directory } : null,
    }) as WorkspaceManager
    const file = await manager.previewFile("fixture", "readme.md", root)
    assert.equal(Buffer.from(file.contents, "base64").toString(), "# Directory only")
    await assert.rejects(manager.previewFile("fixture", "readme.md", path.dirname(root)), /not owned/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
