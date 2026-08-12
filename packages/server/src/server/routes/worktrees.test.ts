import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import type { OpenCodeClient, SessionInfo } from "@opencode-ai/client"
import Fastify from "fastify"
import type { WorkspaceDescriptor } from "../../api-types"
import type { WorkspaceManager } from "../../workspaces/manager"
import { registerWorktreeRoutes } from "./worktrees"

describe("worktree routes", () => {
  it("resolves a session move target from the exact Git slug and ignores client paths", async () => {
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
        id: "root-session",
        projectID: "project",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 },
        location: { directory: repo },
      }
      const locationCalls: string[] = []
      const moveCalls: Array<{ sessionID: string; directory: string; workspaceID?: string }> = []
      const client = {
        location: {
          get: async ({ location }: { location?: { directory?: string } }) => {
            const directory = location?.directory ?? repo
            locationCalls.push(directory)
            return {
              directory,
              workspaceID: path.resolve(directory) === path.resolve(linked) ? "native-feature" : undefined,
              project: { id: "project", directory: repo, canonical: repo },
            }
          },
        },
        session: {
          list: async () => ({ data: [structuredClone(current)], cursor: {} }),
          active: async () => ({}),
          move: async (input: { sessionID: string; directory: string; workspaceID?: string }) => {
            moveCalls.push(input)
            current.location = { directory: input.directory, workspaceID: input.workspaceID }
          },
          get: async () => structuredClone(current),
        },
      } as unknown as OpenCodeClient
      const workspace: WorkspaceDescriptor = {
        id: "workspace",
        path: repo,
        status: "ready",
        proxyPath: "/workspaces/workspace/instance",
        binaryId: "opencode",
        binaryLabel: "opencode",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }
      const manager = {
        get: (id: string) => id === workspace.id ? workspace : undefined,
        reserveWorktreeDeletion: async () => () => {},
        getSharedServiceClient: async () => client,
      } as unknown as WorkspaceManager
      registerWorktreeRoutes(app, { workspaceManager: manager })

      const response = await app.inject({
        method: "POST",
        url: "/api/workspaces/workspace/sessions/root-session/worktree",
        payload: { worktreeSlug: "feature", directory: "C:/evil", workspaceID: "evil" },
      })

      assert.equal(response.statusCode, 200)
      assert.equal(path.resolve(locationCalls[1] ?? ""), path.resolve(linked))
      assert.equal(path.resolve(moveCalls[0]?.directory ?? ""), path.resolve(linked))
      assert.equal(moveCalls[0]?.workspaceID, "native-feature")
    } finally {
      await app.close()
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it("refuses to remove a worktree open as another workspace", async () => {
    const temp = mkdtempSync(path.join(tmpdir(), "codenomad-worktree-route-"))
    const repo = path.join(temp, "repo")
    const linked = path.join(temp, "feature-worktree")
    const app = Fastify({ logger: false })

    try {
      mkdirSync(repo, { recursive: true })
      execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" })
      execFileSync("git", ["-C", repo, "-c", "user.name=CodeNomad", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init"], { stdio: "ignore" })
      execFileSync("git", ["-C", repo, "worktree", "add", "-b", "feature", linked], { stdio: "ignore" })

      const workspaceFolder = path.join(repo, "apps", "web")
      const linkedWorkspaceFolder = path.join(linked, "apps", "web")
      mkdirSync(workspaceFolder, { recursive: true })
      mkdirSync(linkedWorkspaceFolder, { recursive: true })
      const workspace = workspaceDescriptor("workspace", workspaceFolder)
      const linkedWorkspace = workspaceDescriptor("linked-workspace", linkedWorkspaceFolder)
      const manager = {
        get: (id: string) => id === workspace.id ? workspace : undefined,
        list: () => [workspace, linkedWorkspace],
        reserveWorktreeDeletion: async () => {
          throw new Error("Worktree is open as another workspace")
        },
        getSharedServiceClient: async () => {
          throw new Error("OpenCode client must not be requested")
        },
      } as unknown as WorkspaceManager
      registerWorktreeRoutes(app, { workspaceManager: manager })

      const response = await app.inject({
        method: "DELETE",
        url: "/api/workspaces/workspace/worktrees/feature",
      })

      assert.equal(response.statusCode, 409)
      assert.deepEqual(response.json(), { error: "Worktree is open as another workspace" })
    } finally {
      await app.close()
      rmSync(temp, { recursive: true, force: true })
    }
  })
})

function workspaceDescriptor(id: string, directory: string): WorkspaceDescriptor {
  return {
    id,
    path: directory,
    status: "ready",
    proxyPath: `/workspaces/${id}/instance`,
    binaryId: "opencode",
    binaryLabel: "opencode",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}
