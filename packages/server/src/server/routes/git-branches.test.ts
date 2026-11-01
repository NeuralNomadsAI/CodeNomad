import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import type { WorkspaceManager } from "../../workspaces/manager"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { registerWorkspaceRoutes } from "./workspaces"

test("branch source reads fence the exact authorized directory, including WSL host translation and deletion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-branch-route-")), app = Fastify()
  const workspace = { id: "fixture", path: root }, service = "/owned/service/root", fence = new WorktreeDeletionFence()
  let owned = true, replaced = false
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true })
  try {
    git("init", "--initial-branch=main")
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Initial")
    git("branch", "idle")
    const manager = {
      get: (id: string) => id === workspace.id ? workspace : undefined,
      getServiceDirectoryForPath: async (_id: string, directory: string) => owned && directory === service ? service : undefined,
      getHostPathForServicePath: async (_id: string, directory: string) => directory === service ? root : undefined,
      getWorktreeIdentityForPath: async () => replaced ? "replacement" : root,
    } as unknown as WorkspaceManager
    registerWorkspaceRoutes(app, { workspaceManager: manager, worktreeDeletionFence: fence })
    const url = `/api/workspaces/fixture/git-branches?${new URLSearchParams({ directory: service })}`
    const result = await app.inject(url)
    assert.equal(result.statusCode, 200); assert.deepEqual(result.json().branches, ["refs/heads/idle", "refs/heads/main"])
    assert.equal((await app.inject("/api/workspaces/fixture/git-branches?directory=/foreign")).statusCode, 403)
    assert.equal((await app.inject("/api/workspaces/fixture/git-branches")).statusCode, 400)
    assert.equal((await app.inject(url.replace("/fixture/", "/missing/"))).statusCode, 404)
    await fence.run(root, [root], async () => { assert.equal((await app.inject(url)).statusCode, 409) })
    const original = manager.getWorktreeIdentityForPath
    let reads = 0
    manager.getWorktreeIdentityForPath = async (...args) => { if (++reads === 2) replaced = true; return original(...args) }
    assert.equal((await app.inject(url)).statusCode, 400, "a changed checkout cannot publish local refs")
    owned = false
    assert.equal((await app.inject(url)).statusCode, 403)
  } finally { await app.close(); await rm(root, { recursive: true, force: true }) }
})
