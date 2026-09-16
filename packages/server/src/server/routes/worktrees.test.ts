import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import Fastify from "fastify"
import type { OpenCodeClient, SessionInfo } from "@opencode/client"
import type { WorkspaceDescriptor } from "../../api-types"
import type { WorkspaceManager } from "../../workspaces/manager"
import { registerWorktreeRoutes } from "./worktrees"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"

describe("worktree routes", () => {
  it("uses exact project paths despite a nested project sharing the root worktree identity", async () => {
    const temp = mkdtempSync(path.join(tmpdir(), "codenomad-nested-project-"))
    const target = path.join(temp, "doomed")
    const nested = path.join(temp, "nested")
    const app = Fastify({ logger: false })
    try {
      execFileSync("git", ["init", "--initial-branch=main", temp])
      writeFileSync(path.join(temp, "README.md"), "test\n")
      execFileSync("git", ["-C", temp, "add", "README.md"])
      execFileSync("git", ["-C", temp, "-c", "user.name=CodeNomad Test", "-c", "user.email=test@codenomad.local", "commit", "-m", "test"])
      execFileSync("git", ["-C", temp, "worktree", "add", "-b", "doomed", target])
      mkdirSync(nested)
      const projects: string[] = []
      const exactPaths: string[] = []
      const client = {
        location: { get: async () => ({ directory: temp }) },
        project: { list: async () => [
          { id: "nested", canonical: nested, sandboxes: [] },
          { id: "project", canonical: realpathSync(temp), sandboxes: [target] },
        ] },
        session: {
          list: async ({ project }: { project: string }) => {
            projects.push(project)
            return { data: project === "project" ? [{ id: "active", location: { directory: target } }] : [], cursor: {} }
          },
          active: async () => ({ active: { type: "running" } }),
          move: async () => { assert.fail("Active sessions must not move") },
        },
      } as unknown as OpenCodeClient
      const manager = {
        get: () => ({ id: "workspace", path: temp, status: "ready" }),
        getSharedServiceClient: async () => client,
        getServiceDirectory: () => temp,
        getServiceDirectoryForPath: async (_id: string, directory: string) => {
          exactPaths.push(directory)
          return realpathSync(directory)
        },
        getWorktreeIdentityForPath: async (_id: string, directory: string) => path.resolve(directory) === path.resolve(target) ? "workspace:doomed" : "workspace:root",
      } as unknown as WorkspaceManager
      registerWorktreeRoutes(app, { workspaceManager: manager, worktreeDeletionFence: new WorktreeDeletionFence() })
      const response = await app.inject({ method: "DELETE", url: "/api/workspaces/workspace/worktrees/doomed" })
      assert.equal(response.statusCode, 400)
      assert.match(response.json().error, /Active sessions block worktree deletion: active/)
      assert.deepEqual(projects, ["project"])
      assert.ok(exactPaths.includes(nested), "Project candidates must use the exact-path resolver")
      assert.match(execFileSync("git", ["-C", temp, "worktree", "list", "--porcelain"], { encoding: "utf8" }), /doomed/)
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
        location: { get: async ({ location }: { location: { directory: string } }) => location },
        project: {
          list: async () => [{ id: "project", canonical: temp, sandboxes: [target], time: { created: 1, updated: 1 } }],
        },
        session: {
          list: async () => ({ data: [nativeSession], cursor: {} }),
          active: async () => ({}),
          move: async (input: { directory: string }) => {
            if (input.directory === temp) throw new Error("native move failed")
          },
        },
      } as unknown as OpenCodeClient
      const manager = {
        get: () => workspace,
        getSharedServiceClient: async () => client,
        getServiceDirectory: () => temp,
        getServiceDirectoryForPath: async (_id: string, directory: string) => directory,
        getWorktreeIdentityForPath: async () => "workspace:doomed",
      } as unknown as WorkspaceManager
      registerWorktreeRoutes(app, { workspaceManager: manager, worktreeDeletionFence: new WorktreeDeletionFence() })

      const response = await app.inject({ method: "DELETE", url: "/api/workspaces/workspace/worktrees/doomed" })

      assert.equal(response.statusCode, 400)
      assert.match(response.json().error, /native move failed/)
      assert.match(execFileSync("git", ["-C", temp, "worktree", "list", "--porcelain"], { encoding: "utf8" }), /doomed/)
    } finally {
      await app.close()
      rmSync(temp, { recursive: true, force: true })
    }
  })
})
