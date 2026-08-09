import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { serverApi } from "../lib/api-client.ts"
import { sdkManager } from "../lib/sdk-manager.ts"
import type { Session } from "../types/session.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { clearOpenCodeWorkspaceCache } from "./opencode-workspaces.ts"
import { moveSessionToWorktree, requireSessionWorkspacePayload } from "./session-worktree-binding.ts"
import { sessions, setSessions } from "./session-state.ts"
import { deleteWorktree, reloadWorktreeMap, reloadWorktrees, removeLegacyParentSessionMapping } from "./worktrees.ts"

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

async function setup(
  instanceId: string,
  warp: (parameters: Record<string, unknown>) => Promise<unknown>,
  listed: Array<Record<string, any>> = [{ id: "root-session" }, { id: "child-session", parentID: "root-session" }],
) {
  const client = {
    session: {
      async list() { return { data: listed } },
    },
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

  it("repairs a divergent descendant before routing the family", async () => {
    const instanceId = "worktree-divergent-child"
    const calls: Array<Record<string, unknown>> = []
    const cleanup = await setup(
      instanceId,
      async (parameters) => {
        calls.push(parameters)
        return { data: true }
      },
      [
        { id: "root-session", directory: "/repo-feature", workspaceID: "workspace-feature" },
        { id: "child-session", parentID: "root-session", directory: "/repo" },
      ],
    )
    const originalSetWorktreeSlug = serverApi.setSessionWorktreeSlug
    serverApi.setSessionWorktreeSlug = async () => ({ metadata: {} })
    const root = {
      ...session(instanceId, "root-session", null),
      directory: "/repo-feature",
      workspaceId: "workspace-feature",
    }
    const child = session(instanceId, "child-session", root.id)
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[root.id, root], [child.id, child]])))

    try {
      assert.deepEqual(await requireSessionWorkspacePayload(instanceId, child.id), { workspace: "workspace-feature" })
      assert.deepEqual(calls.map(({ sessionID, id }) => ({ sessionID, id })), [
        { sessionID: root.id, id: "workspace-feature" },
        { sessionID: child.id, id: "workspace-feature" },
      ])
      assert.equal(sessions().get(instanceId)?.get(child.id)?.directory, "/repo-feature")
    } finally {
      serverApi.setSessionWorktreeSlug = originalSetWorktreeSlug
      cleanup()
    }
  })

  it("refuses to move a family with an unloaded descendant", async () => {
    const instanceId = "worktree-incomplete-family"
    let warpCalls = 0
    const cleanup = await setup(instanceId, async () => {
      warpCalls += 1
      return { data: true }
    })
    const root = session(instanceId, "root-session", null, { codenomad: { version: 1, worktreeSlug: "feature" } })
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[root.id, root]])))

    try {
      await assert.rejects(() => moveSessionToWorktree(instanceId, root.id, "feature"), /Failed to move/)
      assert.equal(warpCalls, 0)
    } finally {
      cleanup()
    }
  })

  it("refreshes stale local locations from the authoritative project list", async () => {
    const instanceId = "worktree-authoritative-location"
    let warpCalls = 0
    const cleanup = await setup(
      instanceId,
      async () => {
        warpCalls += 1
        return { data: true }
      },
      [
        { id: "root-session", directory: "/repo-feature", workspaceID: "workspace-feature" },
        { id: "child-session", parentID: "root-session", directory: "/repo-feature", workspaceID: "workspace-feature" },
      ],
    )
    const root = {
      ...session(instanceId, "root-session", null),
      directory: "/repo-feature",
      workspaceId: "workspace-feature",
    }
    const child = session(instanceId, "child-session", root.id)
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[root.id, root], [child.id, child]])))

    try {
      assert.deepEqual(await requireSessionWorkspacePayload(instanceId, child.id), { workspace: "workspace-feature" })
      assert.equal(warpCalls, 0)
      assert.equal(sessions().get(instanceId)?.get(child.id)?.directory, "/repo-feature")
      assert.equal(sessions().get(instanceId)?.get(child.id)?.workspaceId, "workspace-feature")
    } finally {
      cleanup()
    }
  })

  it("serializes concurrent moves for the same family", async () => {
    const instanceId = "worktree-serialized-family"
    const calls: Array<Record<string, unknown>> = []
    const cleanup = await setup(instanceId, async (parameters) => {
      calls.push(parameters)
      return { data: true }
    })
    const originalSetWorktreeSlug = serverApi.setSessionWorktreeSlug
    serverApi.setSessionWorktreeSlug = async () => ({ metadata: {} })
    const root = session(instanceId, "root-session", null)
    const child = session(instanceId, "child-session", root.id)
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[root.id, root], [child.id, child]])))

    try {
      await Promise.all([
        moveSessionToWorktree(instanceId, root.id, "feature"),
        moveSessionToWorktree(instanceId, root.id, "root"),
      ])
      assert.deepEqual(calls.map(({ sessionID, id }) => ({ sessionID, id })), [
        { sessionID: root.id, id: "workspace-feature" },
        { sessionID: child.id, id: "workspace-feature" },
        { sessionID: root.id, id: null },
        { sessionID: child.id, id: null },
      ])
      assert.equal(sessions().get(instanceId)?.get(root.id)?.directory, "/repo")
      assert.equal(sessions().get(instanceId)?.get(child.id)?.workspaceId, undefined)
    } finally {
      serverApi.setSessionWorktreeSlug = originalSetWorktreeSlug
      cleanup()
    }
  })

  it("restores sessions when Git refuses worktree deletion", async () => {
    const instanceId = "worktree-delete-rollback"
    const calls: Array<Record<string, unknown>> = []
    const listed = [
      { id: "root-session", directory: "/repo-feature", workspaceID: "workspace-feature" as string | undefined },
      { id: "child-session", parentID: "root-session", directory: "/repo-feature", workspaceID: "workspace-feature" as string | undefined },
    ]
    const cleanup = await setup(
      instanceId,
      async (parameters) => {
        calls.push(parameters)
        const session = listed.find((candidate) => candidate.id === parameters.sessionID)
        if (session) {
          session.directory = parameters.id ? "/repo-feature" : "/repo"
          session.workspaceID = typeof parameters.id === "string" ? parameters.id : undefined
        }
        return { data: true }
      },
      listed,
    )
    const originalDeleteWorktree = serverApi.deleteWorktree
    const originalSetWorktreeSlug = serverApi.setSessionWorktreeSlug
    serverApi.deleteWorktree = async () => { throw new Error("contains modified files") }
    serverApi.setSessionWorktreeSlug = async () => ({ metadata: {} })
    const root = {
      ...session(instanceId, "root-session", null),
      directory: "/repo-feature",
      workspaceId: "workspace-feature",
    }
    const child = {
      ...session(instanceId, "child-session", root.id),
      directory: "/repo-feature",
      workspaceId: "workspace-feature",
    }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[root.id, root], [child.id, child]])))

    try {
      await assert.rejects(() => deleteWorktree(instanceId, "feature"), /modified files/)
      assert.deepEqual(calls.map(({ sessionID, id }) => ({ sessionID, id })), [
        { sessionID: root.id, id: null },
        { sessionID: child.id, id: null },
        { sessionID: root.id, id: "workspace-feature" },
        { sessionID: child.id, id: "workspace-feature" },
      ])
      assert.equal(sessions().get(instanceId)?.get(root.id)?.directory, "/repo-feature")
    } finally {
      serverApi.deleteWorktree = originalDeleteWorktree
      serverApi.setSessionWorktreeSlug = originalSetWorktreeSlug
      cleanup()
    }
  })

  it("does not move a legacy virtual family when deletion fails", async () => {
    const instanceId = "worktree-delete-virtual-family"
    let warpCalls = 0
    const listed: Array<Record<string, any>> = [
      { id: "root-session", directory: "/repo" },
      { id: "child-session", parentID: "root-session", directory: "/repo" },
    ]
    const cleanup = await setup(instanceId, async () => {
      warpCalls += 1
      return { data: true }
    }, listed)
    const originalDeleteWorktree = serverApi.deleteWorktree
    const originalSetWorktreeSlug = serverApi.setSessionWorktreeSlug
    serverApi.deleteWorktree = async () => { throw new Error("contains modified files") }
    serverApi.setSessionWorktreeSlug = async () => ({ metadata: {} })
    const root = session(instanceId, "root-session", null, { codenomad: { version: 1, worktreeSlug: "feature" } })
    const child = session(instanceId, "child-session", root.id)
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[root.id, root], [child.id, child]])))

    try {
      await assert.rejects(() => deleteWorktree(instanceId, "feature"), /modified files/)
      assert.equal(warpCalls, 0)
      assert.equal(sessions().get(instanceId)?.get(root.id)?.directory, "/repo")
    } finally {
      serverApi.deleteWorktree = originalDeleteWorktree
      serverApi.setSessionWorktreeSlug = originalSetWorktreeSlug
      cleanup()
    }
  })

  it("serializes legacy map cleanup across families", async () => {
    const instanceId = "worktree-map-serialization"
    const originalReadWorktreeMap = serverApi.readWorktreeMap
    const originalWriteWorktreeMap = serverApi.writeWorktreeMap
    const writes: Array<Record<string, string>> = []
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve })
    serverApi.readWorktreeMap = async () => ({
      version: 1,
      defaultWorktreeSlug: "root",
      parentSessionWorktreeSlug: { first: "feature", second: "feature" },
    })
    serverApi.writeWorktreeMap = async (_instanceId, map) => {
      writes.push({ ...map.parentSessionWorktreeSlug })
      if (writes.length === 1) {
        markFirstStarted()
        await firstPending
      }
    }

    try {
      await reloadWorktreeMap(instanceId)
      const first = removeLegacyParentSessionMapping(instanceId, "first")
      await firstStarted
      const second = removeLegacyParentSessionMapping(instanceId, "second")
      releaseFirst()
      await Promise.all([first, second])
      assert.deepEqual(writes, [{ second: "feature" }, {}])
    } finally {
      serverApi.readWorktreeMap = originalReadWorktreeMap
      serverApi.writeWorktreeMap = originalWriteWorktreeMap
    }
  })
})
