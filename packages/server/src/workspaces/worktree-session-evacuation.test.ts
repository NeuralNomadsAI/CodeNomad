import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { OpenCodeClient, SessionInfo } from "@opencode-ai/client"
import { evacuateWorktreeSessions, WorktreeDeletionFence } from "./worktree-session-evacuation"

function session(id: string, directory: string, parentID?: string): SessionInfo {
  return { id, parentID, projectID: "project", location: { directory }, cost: 0, tokens: {}, time: { created: 1, updated: 1 } } as SessionInfo
}

describe("evacuateWorktreeSessions", () => {
  it("serializes deletion attempts for the same worktree", async () => {
    const fence = new WorktreeDeletionFence()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const calls: string[] = []
    const first = fence.run("/repo/worktree", ["/repo/worktree"], async () => {
      calls.push("first:start")
      await gate
      calls.push("first:end")
    })
    const second = fence.run("/repo/worktree", ["/repo/worktree"], async () => { calls.push("second") })

    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(calls, ["first:start"])
    assert.equal(fence.isBlocked("/repo/worktree/"), true)
    release()
    await Promise.all([first, second])
    assert.deepEqual(calls, ["first:start", "first:end", "second"])
    assert.equal(fence.isBlocked("/repo/worktree"), false)
  })

  it("waits for admitted mutations before deleting and rejects later admission", async () => {
    const fence = new WorktreeDeletionFence()
    const releaseMutation = fence.enter(["/repo/worktree"])
    assert.ok(releaseMutation)
    const calls: string[] = []
    const deletion = fence.run("/repo/worktree", ["/repo/worktree"], async () => { calls.push("delete") })

    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(calls, [])
    assert.equal(fence.enter(["/repo/worktree"]), undefined)
    releaseMutation()
    await deletion
    assert.deepEqual(calls, ["delete"])
  })

  it("fails deletion closed when an admitted mutation does not finish", async () => {
    const fence = new WorktreeDeletionFence(1)
    const releaseMutation = fence.enter(["/repo/worktree"])
    assert.ok(releaseMutation)

    await assert.rejects(
      fence.run("/repo/worktree", ["/repo/worktree"], async () => {}),
      /Timed out waiting for worktree mutations/,
    )
    assert.equal(fence.isBlocked("/repo/worktree"), false)
    releaseMutation()
  })

  it("finds later-page sessions and waits for their asynchronous moves", async () => {
    const moves: Array<{ sessionID: string; directory: string }> = []
    const lists: unknown[] = []
    let listCall = 0
    const root = session("old-root", "/repo/worktree")
    const child = session("old-child", "/repo/worktree", root.id)
    const grandchild = session("old-grandchild", "/repo/worktree", child.id)
    const state = new Map([root, child, grandchild].map((item) => [item.id, item]))
    let removed = false
    const client = {
      project: {
        list: async () => [{ id: "project", canonical: "/repo", sandboxes: ["/repo/worktree"], time: { created: 1, updated: 1 } }],
      },
      session: {
        list: async (input: unknown) => {
          lists.push(input)
          listCall += 1
          if (listCall === 1) return { data: [session("loaded", "/repo")], cursor: { next: "older" } }
          if (listCall === 2) return { data: [root, child, grandchild], cursor: {} }
          return { data: [session("loaded", "/repo"), ...state.values()], cursor: {} }
        },
        active: async () => ({}),
        move: async (input: { sessionID: string; directory: string }) => {
          moves.push(input)
          setImmediate(() => state.set(input.sessionID, { ...state.get(input.sessionID)!, location: { directory: input.directory } }))
        },
      },
    } as unknown as OpenCodeClient

    await evacuateWorktreeSessions({
      client, projectDirectory: "/repo", targetDirectory: "/repo/worktree", rootDirectory: "/repo",
      remove: async () => { removed = true },
    })

    assert.deepEqual(moves.map(({ sessionID }) => sessionID), [root.id, child.id, grandchild.id])
    assert.equal(removed, true)
    assert.ok(listCall > 3)
    assert.ok(lists.every((input: any) => input.project === "project" && input.directory === undefined))
  })

  it("evacuates sessions whose directory resolves to the target alias", async () => {
    const aliased = session("aliased", "/repo/alias")
    let current = aliased
    let removed = false
    const client = {
      project: { list: async () => [{ id: "project", canonical: "/repo", sandboxes: ["/repo/worktree"], time: { created: 1, updated: 1 } }] },
      session: {
        list: async () => ({ data: [current], cursor: {} }),
        active: async () => ({}),
        move: async (input: { directory: string }) => { current = { ...current, location: { directory: input.directory } } },
      },
    } as unknown as OpenCodeClient

    await evacuateWorktreeSessions({
      client,
      projectDirectory: "/repo",
      targetDirectory: "/repo/worktree",
      rootDirectory: "/repo",
      resolveDirectory: async (directory) => directory === "/repo/alias" ? "/repo/worktree" : directory,
      remove: async () => { removed = true },
    })

    assert.equal(current.location.directory, "/repo")
    assert.equal(removed, true)
  })

  it("rolls sessions back when Git removal fails", async () => {
    const current = session("session", "/repo/worktree")
    const moves: string[] = []
    const client = {
      project: { list: async () => [{ id: "project", canonical: "/repo", sandboxes: ["/repo/worktree"], time: { created: 1, updated: 1 } }] },
      session: {
        list: async () => ({ data: [current], cursor: {} }),
        active: async () => ({}),
        move: async ({ directory }: { directory: string }) => {
          moves.push(directory)
          current.location = { directory }
        },
      },
    } as unknown as OpenCodeClient

    await assert.rejects(evacuateWorktreeSessions({
      client, projectDirectory: "/repo", targetDirectory: "/repo/worktree", rootDirectory: "/repo",
      remove: async () => { throw new Error("Git removal failed") },
    }), /Git removal failed/)
    assert.deepEqual(moves, ["/repo", "/repo/worktree"])
    assert.equal(current.location.directory, "/repo/worktree")
  })

  it("re-inventories active sessions immediately before removal", async () => {
    const current = session("session", "/repo/worktree")
    const intruder = session("intruder", "/repo/worktree")
    let listCalls = 0
    let removed = false
    const client = {
      project: { list: async () => [{ id: "project", canonical: "/repo", sandboxes: ["/repo/worktree"], time: { created: 1, updated: 1 } }] },
      session: {
        list: async () => {
          listCalls += 1
          return { data: listCalls >= 3 ? [current, intruder] : [current], cursor: {} }
        },
        active: async () => ({ intruder: { type: "running" } }),
        move: async ({ directory }: { directory: string }) => { current.location = { directory } },
      },
    } as unknown as OpenCodeClient

    await assert.rejects(evacuateWorktreeSessions({
      client, projectDirectory: "/repo", targetDirectory: "/repo/worktree", rootDirectory: "/repo",
      remove: async () => { removed = true },
    }), /Active sessions block worktree deletion: intruder/)

    assert.equal(removed, false)
    assert.equal(current.location.directory, "/repo/worktree")
  })
})
