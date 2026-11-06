import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import type { OpenCodeClient } from "@opencode/client"
import type { WorktreeListResponse } from "../../api-types"
import type { WorkspaceManager } from "../../workspaces/manager"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { historyDirectories, ownedHistorySessions } from "./session-history-scope"
import { registerWorktreeRoutes } from "./worktrees"

test("root-only inventories remain available to ordinary history and worktree routes", async () => {
  const inventory: WorktreeListResponse = { isGitRepo: false, worktrees: [
    { slug: "root", directory: "/repo", serviceDirectory: "/repo", kind: "root" },
  ] }
  const manager = {
    get: () => ({ id: "workspace" }),
    getWorktrees: async () => inventory,
    ownsLocation: async (_id: string, location: { directory: string }, _client?: unknown, options: { strict?: boolean } = {}) => {
      assert.notEqual(options.strict, true, "ordinary history never requests strict preference authority")
      return location.directory === "/repo" || location.directory.startsWith("/repo/")
    },
  }
  assert.deepEqual(await historyDirectories(manager, "workspace", "/repo"), ["/repo"])
  const sessions = [{ sessionID: "owned", directory: "/repo/nested" }, { sessionID: "foreign", directory: "/elsewhere" }]
  assert.deepEqual(await ownedHistorySessions(manager, "workspace", {} as OpenCodeClient, sessions), [sessions[0]])
  const app = Fastify()
  registerWorktreeRoutes(app, { workspaceManager: manager as unknown as WorkspaceManager, worktreeDeletionFence: new WorktreeDeletionFence() })
  try {
    const response = await app.inject({ method: "GET", url: "/api/workspaces/workspace/worktrees" })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), inventory)
  } finally { await app.close() }
})
