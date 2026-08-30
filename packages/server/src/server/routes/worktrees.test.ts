import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import type { OpenCodeClient, SessionInfo } from "@opencode-ai/client"
import Fastify from "fastify"
import type { WorkspaceDescriptor } from "../../api-types"
import type { WorkspaceManager } from "../../workspaces/manager"
import { registerWorktreeRoutes } from "./worktrees"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"

describe("worktree routes", () => {
it("reserves the physical worktree and rejects a same-HEAD replacement before deletion", async () => {
  const temp = mkdtempSync(path.join(tmpdir(), "codenomad-worktree-route-"))
  const repo = path.join(temp, "repo")
  const linked = path.join(temp, "feature-worktree")
  const workspacePath = path.join(repo, "apps", "web")
  const linkedWorkspacePath = path.join(linked, "apps", "web")
  const app = Fastify({ logger: false })

  try {
    mkdirSync(repo, { recursive: true })
    execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" })
    mkdirSync(workspacePath, { recursive: true })
    writeFileSync(path.join(workspacePath, "README.md"), "nested workspace\n")
    execFileSync("git", ["-C", repo, "add", "."], { stdio: "ignore" })
    execFileSync("git", ["-C", repo, "-c", "user.name=CodeNomad", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init"], { stdio: "ignore" })
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "feature", linked], { stdio: "ignore" })

    const current: SessionInfo = {
      id: "session",
      projectID: "project",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
      location: { directory: path.join(linked, "..cache", "session"), workspaceID: "native-feature" },
    }
    let lists = 0
    const client = {
      project: { list: async () => [{ id: "project" }] },
      location: {
        get: async ({ location }: { location?: { directory?: string } }) => ({
          directory: location?.directory ?? workspacePath,
          workspaceID: path.resolve(location?.directory ?? workspacePath) === path.resolve(linkedWorkspacePath) ? "native-feature" : undefined,
          project: { id: "project", directory: workspacePath, canonical: workspacePath },
        }),
      },
      session: {
        list: async () => {
          if (++lists === 3) {
            execFileSync("git", ["-C", repo, "worktree", "remove", "--force", linked], { stdio: "ignore" })
            execFileSync("git", ["-C", repo, "worktree", "add", linked, "feature"], { stdio: "ignore" })
            writeFileSync(path.join(linked, "replacement.txt"), "must survive\n")
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
        path: workspacePath,
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
      getServiceLocation: () => ({ directory: workspacePath }),
      getServiceDirectoryForPath: async (_id: string, directory: string) => {
        assert.notEqual(path.resolve(directory), path.resolve(linked), "OpenCode must receive the mirrored workspace path")
        return directory
      },
      getWorktreeIdentityForPath: async (_id: string, directory: string) => (
        path.resolve(directory).startsWith(path.resolve(linked)) ? "workspace:feature" : "workspace:root"
      ),
    } as unknown as WorkspaceManager
    registerWorktreeRoutes(app, { workspaceManager: manager, worktreeDeletionFence: new WorktreeDeletionFence() })

    const response = await app.inject({ method: "DELETE", url: "/api/workspaces/workspace/worktrees/feature" })

    assert.equal(response.statusCode, 409)
    assert.equal(path.resolve(reserved), path.resolve(linked))
    assert.equal(released, true)
    assert.equal(path.resolve(current.location.directory), path.resolve(workspacePath))
    assert.equal(execFileSync("git", ["-C", linked, "status", "--short"], { encoding: "utf8" }).trim(), "?? replacement.txt")
    const inventory = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" })
    assert.ok(inventory.replace(/\\/g, "/").includes(linked.replace(/\\/g, "/")))
  } finally {
    await app.close()
    rmSync(temp, { recursive: true, force: true })
  }
})

it("fails a direct delete call closed when session evacuation fails", async () => {
    const temp = mkdtempSync(path.join(tmpdir(), "codenomad-delete-worktree-"))
    const target = path.join(temp, "doomed")
    const app = Fastify({ logger: false })
    try {
      execFileSync("git", ["init", "--initial-branch=main", temp])
      writeFileSync(path.join(temp, "README.md"), "test\n")
      execFileSync("git", ["-C", temp, "add", "README.md"])
      execFileSync("git", ["-C", temp, "-c", "user.name=CodeNomad Test", "-c", "user.email=test@codenomad.local", "commit", "-m", "test"])
      execFileSync("git", ["-C", temp, "worktree", "add", "-b", "doomed", target])

      const workspace = { id: "workspace", path: temp, status: "ready" } as WorkspaceDescriptor
      const nativeSession = { id: "unloaded", projectID: "project", location: { directory: target }, cost: 0, tokens: {}, time: { created: 1, updated: 1 } } as SessionInfo
      const client = {
        project: { list: async () => [{ id: "project" }] },
        location: {
          get: async ({ location }: { location?: { directory?: string } }) => ({
            directory: location?.directory ?? temp,
            project: { id: "project", canonical: temp, directory: temp },
          }),
        },
        session: {
          list: async () => ({ data: [nativeSession], cursor: {} }),
          active: async () => ({}),
          move: async (input: { directory: string }) => {
            if (input.directory === temp) throw new Error("native move failed")
          },
          get: async () => nativeSession,
        },
      } as unknown as OpenCodeClient
      const manager = {
        get: () => workspace,
        getSharedServiceClient: async () => client,
        getServiceLocation: () => ({ directory: temp }),
        getServiceDirectoryForPath: async (_id: string, directory: string) => directory,
        reserveWorktreeDeletion: async () => () => undefined,
        getWorktreeIdentityForPath: async () => "workspace:doomed",
      } as unknown as WorkspaceManager
      registerWorktreeRoutes(app, { workspaceManager: manager, worktreeDeletionFence: new WorktreeDeletionFence() })

      const response = await app.inject({ method: "DELETE", url: "/api/workspaces/workspace/worktrees/doomed" })

      assert.equal(response.statusCode, 502)
      assert.match(response.json().error, /native move failed/)
      assert.match(execFileSync("git", ["-C", temp, "worktree", "list", "--porcelain"], { encoding: "utf8" }), /doomed/)
    } finally {
      await app.close()
      rmSync(temp, { recursive: true, force: true })
    }
})
})
