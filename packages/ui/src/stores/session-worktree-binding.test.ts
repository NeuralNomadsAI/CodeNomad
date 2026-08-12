import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { serverApi } from "../lib/api-client.ts"
import type { Session } from "../types/session.ts"
import { moveSessionToWorktree, requireSessionWorkspacePayload } from "./session-worktree-binding.ts"
import { handleSessionUpdate } from "./session-events.ts"
import { sessions, setSessions } from "./session-state.ts"
import { deleteWorktree, reloadWorktreeMap, reloadWorktrees, removeLegacyParentSessionMapping } from "./worktrees.ts"

function session(instanceId: string, id: string, parentId: string | null, directory = "/repo", metadata?: Record<string, unknown>): Session {
  return {
    id, instanceId, parentId, directory, title: id, agent: "build",
    model: { providerId: "provider", modelId: "model" }, status: "idle", retry: null, idleSince: null,
    generationRecovery: null, runtimeStatusKnown: true, version: "1", time: { created: 1, updated: 1 }, metadata,
  }
}

async function setup(instanceId: string) {
  const originalFetch = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => ({
    isGitRepo: true,
    worktrees: [
      { slug: "root", directory: "/repo", kind: "root" },
      { slug: "feature", directory: "/repo-feature", kind: "worktree" },
    ],
  })
  await reloadWorktrees(instanceId)
  serverApi.fetchWorktrees = originalFetch
  const root = session(instanceId, "root", null, "/repo", { codenomad: { version: 1, worktreeSlug: "feature" } })
  const child = session(instanceId, "child", root.id)
  setSessions((current) => new Map(current).set(instanceId, new Map([[root.id, root], [child.id, child]])))
  return {
    root,
    child,
    cleanup() {
      setSessions((current) => {
        const next = new Map(current)
        next.delete(instanceId)
        return next
      })
    },
  }
}

function moveResponse(slug: "root" | "feature") {
  const feature = slug === "feature"
  return {
    rootSessionId: "root",
    worktreeSlug: slug,
    sessions: ["root", "child"].map((sessionId) => ({
      sessionId,
      directory: feature ? "/repo-feature" : "/repo",
      workspaceId: feature ? "workspace-feature" : null,
    })),
  }
}

describe("session worktree binding", () => {
  it("applies one authoritative family move response", async () => {
    const instanceId = "family-response"
    const { child, cleanup } = await setup(instanceId)
    const originalMove = serverApi.moveWorktreeSessionFamily
    const originalMap = serverApi.readWorktreeMap
    serverApi.moveWorktreeSessionFamily = async () => moveResponse("feature")
    serverApi.readWorktreeMap = async () => ({ version: 1, defaultWorktreeSlug: "root", parentSessionWorktreeSlug: {} })
    try {
      assert.deepEqual(await requireSessionWorkspacePayload(instanceId, child.id), { workspace: "workspace-feature" })
      assert.equal(sessions().get(instanceId)?.get("root")?.directory, "/repo-feature")
      assert.equal(sessions().get(instanceId)?.get("child")?.workspaceId, "workspace-feature")
    } finally {
      serverApi.moveWorktreeSessionFamily = originalMove
      serverApi.readWorktreeMap = originalMap
      cleanup()
    }
  })

  it("ignores delayed pre-move session events until the moved location is observed", async () => {
    const instanceId = "delayed-location-event"
    const { root, cleanup } = await setup(instanceId)
    const originalMove = serverApi.moveWorktreeSessionFamily
    const originalMap = serverApi.readWorktreeMap
    serverApi.moveWorktreeSessionFamily = async () => moveResponse("feature")
    serverApi.readWorktreeMap = async () => ({ version: 1, defaultWorktreeSlug: "root", parentSessionWorktreeSlug: {} })
    const update = (directory: string, workspaceID?: string, updated = 1) => handleSessionUpdate(instanceId, {
      type: "session.updated",
      properties: { info: { ...root, directory, workspaceID, time: { ...root.time, updated } } },
    } as any)
    try {
      await moveSessionToWorktree(instanceId, root.id, "feature")
      update("/repo")
      assert.equal(sessions().get(instanceId)?.get(root.id)?.directory, "/repo-feature")
      assert.equal(sessions().get(instanceId)?.get(root.id)?.workspaceId, "workspace-feature")

      update("/repo-feature", "workspace-feature")
      assert.equal(sessions().get(instanceId)?.get(root.id)?.directory, "/repo-feature")

      update("/repo-other", "workspace-other", 2)
      assert.equal(sessions().get(instanceId)?.get(root.id)?.directory, "/repo-other")
      assert.equal(sessions().get(instanceId)?.get(root.id)?.workspaceId, "workspace-other")

      serverApi.moveWorktreeSessionFamily = async () => moveResponse("root")
      await moveSessionToWorktree(instanceId, root.id, "root")
      update("/repo")
      assert.equal(sessions().get(instanceId)?.get(root.id)?.workspaceId, undefined)
    } finally {
      serverApi.moveWorktreeSessionFamily = originalMove
      serverApi.readWorktreeMap = originalMap
      cleanup()
    }
  })

  it("serializes concurrent moves for one family", async () => {
    const instanceId = "serialized-family"
    const { root, cleanup } = await setup(instanceId)
    const originalMove = serverApi.moveWorktreeSessionFamily
    const originalMap = serverApi.readWorktreeMap
    const calls: string[] = []
    let releaseFirst!: () => void
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve })
    serverApi.moveWorktreeSessionFamily = async (_id, _session, { worktreeSlug }) => {
      calls.push(worktreeSlug)
      if (calls.length === 1) await firstPending
      return moveResponse(worktreeSlug as "root" | "feature")
    }
    serverApi.readWorktreeMap = async () => ({ version: 1, defaultWorktreeSlug: "root", parentSessionWorktreeSlug: {} })
    try {
      const first = moveSessionToWorktree(instanceId, root.id, "feature")
      const second = moveSessionToWorktree(instanceId, root.id, "root")
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      assert.deepEqual(calls, ["feature"])
      releaseFirst()
      await Promise.all([first, second])
      assert.deepEqual(calls, ["feature", "root"])
      assert.equal(sessions().get(instanceId)?.get(root.id)?.directory, "/repo")
    } finally {
      serverApi.moveWorktreeSessionFamily = originalMove
      serverApi.readWorktreeMap = originalMap
      cleanup()
    }
  })

  it("does not issue a renderer rollback when the server response is lost", async () => {
    const instanceId = "lost-response"
    const { root, cleanup } = await setup(instanceId)
    const originalMove = serverApi.moveWorktreeSessionFamily
    let calls = 0
    serverApi.moveWorktreeSessionFamily = async () => {
      calls += 1
      throw new Error("connection lost")
    }
    try {
      await assert.rejects(() => moveSessionToWorktree(instanceId, root.id, "feature"), /connection lost/)
      assert.equal(calls, 1)
    } finally {
      serverApi.moveWorktreeSessionFamily = originalMove
      cleanup()
    }
  })

  it("delegates deletion transactionally without moving sessions locally", async () => {
    const instanceId = "transactional-delete"
    const { cleanup } = await setup(instanceId)
    const originalDelete = serverApi.deleteWorktree
    const originalMove = serverApi.moveWorktreeSessionFamily
    let deletes = 0
    let moves = 0
    serverApi.deleteWorktree = async () => { deletes += 1 }
    serverApi.moveWorktreeSessionFamily = async () => { moves += 1; return moveResponse("root") }
    try {
      await deleteWorktree(instanceId, "feature")
      assert.deepEqual({ deletes, moves }, { deletes: 1, moves: 0 })
    } finally {
      serverApi.deleteWorktree = originalDelete
      serverApi.moveWorktreeSessionFamily = originalMove
      cleanup()
    }
  })

  it("serializes legacy map cleanup", async () => {
    const instanceId = "map-serialization"
    const originalRead = serverApi.readWorktreeMap
    const originalRemove = serverApi.removeWorktreeMapSession
    const writes: Array<Record<string, string>> = []
    let map = { version: 1 as const, defaultWorktreeSlug: "root", parentSessionWorktreeSlug: { first: "feature", second: "feature" } as Record<string, string> }
    serverApi.readWorktreeMap = async () => ({
      version: 1, defaultWorktreeSlug: "root", parentSessionWorktreeSlug: { first: "feature", second: "feature" },
    })
    serverApi.removeWorktreeMapSession = async (_id, sessionId) => {
      const parentSessionWorktreeSlug = { ...map.parentSessionWorktreeSlug }
      delete parentSessionWorktreeSlug[sessionId]
      map = { ...map, parentSessionWorktreeSlug }
      writes.push(parentSessionWorktreeSlug)
      return map
    }
    try {
      await reloadWorktreeMap(instanceId)
      await Promise.all([
        removeLegacyParentSessionMapping(instanceId, "first"),
        removeLegacyParentSessionMapping(instanceId, "second"),
      ])
      assert.deepEqual(writes, [{ second: "feature" }, {}])
    } finally {
      serverApi.readWorktreeMap = originalRead
      serverApi.removeWorktreeMapSession = originalRemove
    }
  })
})
