import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import Fastify from "fastify"

import { createManagedWorktree } from "../../workspaces/git-worktrees"
import { registerWorktreeRoutes } from "./worktrees"

test("managed worktree deletion rejects workflow ownership and live workspaces", async (context) => {
  const temp = mkdtempSync(path.join(tmpdir(), "codenomad-worktree-route-"))
  const git = (...args: string[]) => spawnSync("git", args, { cwd: temp, encoding: "utf8" })
  if (git("--version").error) {
    context.skip("Git is unavailable")
    rmSync(temp, { recursive: true, force: true })
    return
  }
  try {
    assert.equal(git("init").status, 0)
    assert.equal(git("config", "user.email", "test@example.com").status, 0)
    assert.equal(git("config", "user.name", "CodeNomad Test").status, 0)
    writeFileSync(path.join(temp, "file.txt"), "initial")
    assert.equal(git("add", "file.txt").status, 0)
    assert.equal(git("commit", "-m", "initial").status, 0)
    const worktree = await createManagedWorktree({ repoRoot: temp, workspaceFolder: temp, slug: "review" })

    const app = Fastify({ logger: false })
    registerWorktreeRoutes(app, {
      workspaceManager: { get: () => ({ id: "workspace", path: temp }), list: () => [] } as never,
      sessionMetadataPersistence: {} as never,
      workflowManager: {
        list: async () => { throw new Error("capped list must not be used") },
        withWorktreeOwnershipLease: async (_source: unknown, _worktree: unknown, operation: (owned: boolean) => Promise<unknown>) => operation(true),
      } as never,
    })

    const response = await app.inject({ method: "DELETE", url: "/api/workspaces/workspace/worktrees/review" })

    assert.equal(response.statusCode, 409)
    assert.equal(existsSync(worktree.directory), true)
    await app.close()

    const workspaceApp = Fastify({ logger: false })
    registerWorktreeRoutes(workspaceApp, {
      workspaceManager: {
        get: (id: string) => id === "workspace"
          ? { id, path: temp }
          : id === "execution" ? { id, path: worktree.directory, status: "ready" } : undefined,
        list: () => [{ id: "execution", path: path.join(worktree.directory, ".") }],
      } as never,
      sessionMetadataPersistence: {} as never,
      workflowManager: {
        withWorktreeOwnershipLease: async (_source: unknown, _worktree: unknown, operation: (owned: boolean) => Promise<unknown>) => operation(false),
      } as never,
    })

    const activeWorkspace = await workspaceApp.inject({
      method: "DELETE",
      url: "/api/workspaces/workspace/worktrees/review",
    })
    assert.equal(activeWorkspace.statusCode, 409)
    assert.match(activeWorkspace.body, /active workspace/)
    assert.equal(existsSync(worktree.directory), true)
    await workspaceApp.close()

    const terminalWorkspaceApp = Fastify({ logger: false })
    registerWorktreeRoutes(terminalWorkspaceApp, {
      workspaceManager: {
        get: (id: string) => id === "workspace"
          ? { id, path: temp }
          : id === "stopped" ? { id, path: worktree.directory, status: "stopped" }
            : id === "error" ? { id, path: worktree.directory, status: "error" } : undefined,
        list: () => [
          { id: "stopped", path: worktree.directory, status: "stopped" },
          { id: "error", path: worktree.directory, status: "error" },
        ],
      } as never,
      sessionMetadataPersistence: {} as never,
      workflowManager: {
        withWorktreeOwnershipLease: async (_source: unknown, _worktree: unknown, operation: (owned: boolean) => Promise<unknown>) => operation(false),
      } as never,
    })

    const terminalWorkspaces = await terminalWorkspaceApp.inject({
      method: "DELETE",
      url: "/api/workspaces/workspace/worktrees/review",
    })
    assert.equal(terminalWorkspaces.statusCode, 204)
    assert.equal(existsSync(worktree.directory), false)
    await terminalWorkspaceApp.close()
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
