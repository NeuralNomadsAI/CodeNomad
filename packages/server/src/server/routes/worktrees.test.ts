import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { it } from "node:test"
import type { OpenCodeClient, SessionInfo } from "@opencode-ai/client"
import Fastify from "fastify"
import type { WorkspaceManager } from "../../workspaces/manager"
import { registerWorktreeRoutes } from "./worktrees"

it("reserves the physical worktree and rejects a HEAD change immediately before deletion", async () => {
  const temp = mkdtempSync(path.join(tmpdir(), "codenomad-worktree-route-"))
  const repo = path.join(temp, "repo")
  const linked = path.join(temp, "feature-worktree")
  const app = Fastify({ logger: false })

  try {
    mkdirSync(repo, { recursive: true })
    execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" })
    execFileSync("git", ["-C", repo, "-c", "user.name=CodeNomad", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init"], { stdio: "ignore" })
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "feature", linked], { stdio: "ignore" })

    const current: SessionInfo = {
      id: "session",
      projectID: "project",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
      location: { directory: linked, workspaceID: "native-feature" },
    }
    let lists = 0
    const client = {
      location: {
        get: async ({ location }: { location?: { directory?: string } }) => ({
          directory: location?.directory ?? repo,
          workspaceID: path.resolve(location?.directory ?? repo) === path.resolve(linked) ? "native-feature" : undefined,
          project: { id: "project", directory: repo, canonical: repo },
        }),
      },
      session: {
        list: async () => {
          if (++lists === 3) {
            execFileSync("git", ["-C", linked, "-c", "user.name=CodeNomad", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "replace head"], { stdio: "ignore" })
          }
          return { data: [structuredClone(current)], cursor: {} }
        },
        active: async () => ({}),
        move: async ({ directory, workspaceID }: { directory: string; workspaceID?: string }) => {
          current.location = { directory, workspaceID }
        },
        get: async () => structuredClone(current),
      },
    } as unknown as OpenCodeClient
    let reserved = ""
    let released = false
    const manager = {
      get: () => ({
        id: "workspace",
        path: repo,
        status: "ready",
        proxyPath: "/workspaces/workspace/instance",
        binaryId: "opencode",
        binaryLabel: "opencode",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      reserveWorktreeDeletion: async (directory: string) => {
        reserved = directory
        return () => { released = true }
      },
      getSharedServiceClient: async () => client,
    } as unknown as WorkspaceManager
    registerWorktreeRoutes(app, { workspaceManager: manager })

    const response = await app.inject({ method: "DELETE", url: "/api/workspaces/workspace/worktrees/feature" })

    assert.equal(response.statusCode, 409)
    assert.equal(path.resolve(reserved), path.resolve(linked))
    assert.equal(released, true)
    assert.equal(path.resolve(current.location.directory), path.resolve(repo))
    const inventory = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" })
    assert.ok(inventory.replace(/\\/g, "/").includes(linked.replace(/\\/g, "/")))
  } finally {
    await app.close()
    rmSync(temp, { recursive: true, force: true })
  }
})
