import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { serverApi } from "../lib/api-client.ts"
import { sdkManager } from "../lib/sdk-manager.ts"
import type { Session } from "../types/session.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { clearOpenCodeWorkspaceCache } from "./opencode-workspaces.ts"
import { requireSessionWorkspacePayload } from "./session-worktree-binding.ts"
import { sessions, setSessions } from "./session-state.ts"
import { reloadWorktrees } from "./worktrees.ts"

function session(instanceId: string, id: string, parentId: string | null, metadata?: Record<string, unknown>): Session {
  return {
    id,
    instanceId,
    parentId,
    title: id,
    agent: "build",
    model: { providerId: "provider", modelId: "model" },
    status: "idle",
    retry: null,
    idleSince: null,
    generationRecovery: null,
    runtimeStatusKnown: true,
    version: "1",
    time: { created: 1, updated: 1 },
    directory: "/repo",
    metadata,
  }
}

async function setup(instanceId: string, warp: (parameters: Record<string, unknown>) => Promise<unknown>) {
  const client = {
    experimental: {
      workspace: {
        async syncList() { return { data: [] } },
        async list() { return { data: [{ id: "workspace-feature", directory: "/repo-feature" }] } },
        async warp(parameters: Record<string, unknown>) { return warp(parameters) },
      },
    },
  } as any
  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  addInstance({ id: instanceId, folder: "/repo", port: 0, pid: 0, proxyPath: "", status: "ready", client })

  const originalFetchWorktrees = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => ({
    isGitRepo: true,
    worktrees: [
      { slug: "root", directory: "/repo", kind: "root" },
      { slug: "feature", directory: "/repo-feature", kind: "worktree" },
    ],
  })
  await reloadWorktrees(instanceId)
  serverApi.fetchWorktrees = originalFetchWorktrees

  return () => {
    setSessions((previous) => {
      const next = new Map(previous)
      next.delete(instanceId)
      return next
    })
    clearOpenCodeWorkspaceCache(instanceId)
    removeInstance(instanceId, { authoritative: false })
    sdkManager.destroyClientsForInstance(instanceId)
  }
}

describe("session worktree binding", () => {
  it("warps a legacy session family before returning its workspace", async () => {
    const instanceId = "legacy-worktree-warp"
    const calls: Array<Record<string, unknown>> = []
    const cleanup = await setup(instanceId, async (parameters) => {
      calls.push(parameters)
      return { data: true }
    })
    const originalSetWorktreeSlug = serverApi.setSessionWorktreeSlug
    const metadataWrites: Array<string | null> = []
    serverApi.setSessionWorktreeSlug = async (_instanceId, _sessionId, slug) => {
      metadataWrites.push(slug)
      return { metadata: { codenomad: { version: 1 } } }
    }
    const root = session(instanceId, "root-session", null, { codenomad: { version: 1, worktreeSlug: "feature" } })
    const child = session(instanceId, "child-session", root.id)
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[root.id, root], [child.id, child]])))

    try {
      assert.deepEqual(await requireSessionWorkspacePayload(instanceId, child.id), { workspace: "workspace-feature" })
      assert.deepEqual(calls.map(({ sessionID, id }) => ({ sessionID, id })), [
        { sessionID: root.id, id: "workspace-feature" },
        { sessionID: child.id, id: "workspace-feature" },
      ])
      assert.equal(sessions().get(instanceId)?.get(root.id)?.directory, "/repo-feature")
      assert.equal(sessions().get(instanceId)?.get(child.id)?.workspaceId, "workspace-feature")
      assert.deepEqual(metadataWrites, [null])
    } finally {
      serverApi.setSessionWorktreeSlug = originalSetWorktreeSlug
      cleanup()
    }
  })

  it("rolls back an incomplete family warp", async () => {
    const instanceId = "worktree-warp-rollback"
    const calls: Array<Record<string, unknown>> = []
    const cleanup = await setup(instanceId, async (parameters) => {
      calls.push(parameters)
      if (parameters.sessionID === "child-session") throw new Error("warp failed")
      return { data: true }
    })
    const root = session(instanceId, "root-session", null, { codenomad: { version: 1, worktreeSlug: "feature" } })
    const child = session(instanceId, "child-session", root.id)
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[root.id, root], [child.id, child]])))

    try {
      await assert.rejects(() => requireSessionWorkspacePayload(instanceId, root.id), /warp failed/)
      assert.deepEqual(calls.map(({ sessionID, id }) => ({ sessionID, id })), [
        { sessionID: root.id, id: "workspace-feature" },
        { sessionID: child.id, id: "workspace-feature" },
        { sessionID: root.id, id: null },
      ])
      assert.equal(sessions().get(instanceId)?.get(root.id)?.workspaceId, undefined)
      assert.equal(sessions().get(instanceId)?.get(root.id)?.directory, "/repo")
    } finally {
      cleanup()
    }
  })
})
