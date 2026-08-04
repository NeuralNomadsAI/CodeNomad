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
      workspaceManager: {
        get: () => ({ id: "workspace", path: temp }),
        withWorkspacePathLease: async (_path: string, operation: (active: boolean) => Promise<unknown>) => operation(false),
      } as never,
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
        withWorkspacePathLease: async (_path: string, operation: (active: boolean) => Promise<unknown>) => operation(true),
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
        withWorkspacePathLease: async (_path: string, operation: (active: boolean) => Promise<unknown>) => operation(false),
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

test("managed worktree POST and DELETE exclude each other on the target path", async (context) => {
  const temp = mkdtempSync(path.join(tmpdir(), "codenomad-worktree-mutation-route-"))
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

    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    let firstEntered!: () => void
    const firstEntry = new Promise<void>((resolve) => { firstEntered = resolve })
    const tails = new Map<string, Promise<void>>()
    const leasePaths: string[] = []
    let activeOperations = 0
    let maxActiveOperations = 0
    let blockFirst = true
    const workspaceManager = {
      get: () => ({ id: "workspace", path: temp }),
      withWorkspacePathLease: async (target: string, operation: (active: boolean) => Promise<unknown>) => {
        const key = process.platform === "win32" ? path.resolve(target).toLowerCase() : path.resolve(target)
        leasePaths.push(key)
        const previous = tails.get(key) ?? Promise.resolve()
        let release!: () => void
        const current = new Promise<void>((resolve) => { release = resolve })
        tails.set(key, current)
        await previous
        activeOperations += 1
        maxActiveOperations = Math.max(maxActiveOperations, activeOperations)
        try {
          if (blockFirst) {
            blockFirst = false
            firstEntered()
            await firstBlocked
          }
          return await operation(false)
        } finally {
          activeOperations -= 1
          release()
          if (tails.get(key) === current) tails.delete(key)
        }
      },
    }
    const app = Fastify({ logger: false })
    registerWorktreeRoutes(app, {
      workspaceManager: workspaceManager as never,
      sessionMetadataPersistence: {} as never,
      workflowManager: {
        withWorktreeOwnershipLease: async (_source: unknown, _worktree: unknown, operation: (owned: boolean) => Promise<unknown>) => operation(false),
      } as never,
    })

    const deletion = app.inject({ method: "DELETE", url: "/api/workspaces/workspace/worktrees/review" })
    await firstEntry
    const creation = app.inject({
      method: "POST",
      url: "/api/workspaces/workspace/worktrees",
      payload: { slug: "review" },
    })
    while (leasePaths.length < 2) await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(maxActiveOperations, 1)
    assert.equal(leasePaths[0], leasePaths[1])

    releaseFirst()
    const [deleted, created] = await Promise.all([deletion, creation])
    assert.equal(deleted.statusCode, 204)
    assert.equal(created.statusCode, 201)
    assert.equal(maxActiveOperations, 1)
    assert.equal(existsSync(worktree.directory), true)
    await app.close()
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test("stale managed worktree DELETE does not remove a replacement", async (context) => {
  const temp = mkdtempSync(path.join(tmpdir(), "codenomad-stale-worktree-delete-"))
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
    const original = await createManagedWorktree({ repoRoot: temp, workspaceFolder: temp, slug: "review" })

    let releaseStale!: () => void
    let staleEntered!: () => void
    const staleBlocked = new Promise<void>((resolve) => { releaseStale = resolve })
    const staleEntry = new Promise<void>((resolve) => { staleEntered = resolve })
    let ownershipCalls = 0
    const app = Fastify({ logger: false })
    registerWorktreeRoutes(app, {
      workspaceManager: {
        get: () => ({ id: "workspace", path: temp }),
        withWorkspacePathLease: async (_path: string, operation: (active: boolean) => Promise<unknown>) => operation(false),
      } as never,
      sessionMetadataPersistence: {} as never,
      workflowManager: {
        withWorktreeOwnershipLease: async (_source: unknown, _worktree: unknown, operation: (owned: boolean) => Promise<unknown>) => {
          ownershipCalls += 1
          if (ownershipCalls === 1) {
            staleEntered()
            await staleBlocked
          }
          return operation(false)
        },
      } as never,
    })

    const staleDeletion = app.inject({ method: "DELETE", url: "/api/workspaces/workspace/worktrees/review" })
    await staleEntry
    const currentDeletion = await app.inject({ method: "DELETE", url: "/api/workspaces/workspace/worktrees/review" })
    assert.equal(currentDeletion.statusCode, 204)
    assert.equal(existsSync(original.directory), false)

    const replacement = await app.inject({
      method: "POST",
      url: "/api/workspaces/workspace/worktrees",
      payload: { slug: "review" },
    })
    assert.equal(replacement.statusCode, 201)
    assert.equal(existsSync(original.directory), true)

    releaseStale()
    const staleResponse = await staleDeletion
    assert.equal(staleResponse.statusCode, 409)
    assert.match(staleResponse.body, /changed while deletion was pending/)
    assert.equal(existsSync(original.directory), true)
    await app.close()
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
