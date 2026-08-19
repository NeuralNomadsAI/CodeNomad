import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { OpenCodeClient, SessionInfo } from "@opencode-ai/client"
import { evacuateWorktreeSessions } from "./worktree-session-evacuation"

function session(id: string, directory: string, parentID?: string): SessionInfo {
  return { id, parentID, projectID: "project", location: { directory }, cost: 0, tokens: {}, time: { created: 1, updated: 1 } } as SessionInfo
}

describe("evacuateWorktreeSessions", () => {
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
})
