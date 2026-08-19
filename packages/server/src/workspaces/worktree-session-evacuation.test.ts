import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { OpenCodeClient, SessionInfo } from "@opencode-ai/client"
import { evacuateWorktreeSessions } from "./worktree-session-evacuation"

function session(id: string, directory: string, parentID?: string): SessionInfo {
  return { id, parentID, projectID: "project", location: { directory }, cost: 0, tokens: {}, time: { created: 1, updated: 1 } } as SessionInfo
}

describe("evacuateWorktreeSessions", () => {
  it("finds an unloaded family on a later page and moves its root", async () => {
    const moves: Array<{ sessionID: string; directory: string }> = []
    const lists: unknown[] = []
    let listCall = 0
    const root = session("old-root", "/repo/worktree")
    const child = session("old-child", "/repo/worktree", root.id)
    const grandchild = session("old-grandchild", "/repo/worktree", child.id)
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
          return { data: [session("loaded", "/repo"), session(root.id, "/repo"), session(child.id, "/repo", root.id), session(grandchild.id, "/repo", child.id)], cursor: {} }
        },
        move: async (input: { sessionID: string; directory: string }) => { moves.push(input) },
      },
    } as unknown as OpenCodeClient

    await evacuateWorktreeSessions({ client, projectDirectory: "/repo", targetDirectory: "/repo/worktree", rootDirectory: "/repo" })

    assert.deepEqual(moves, [{ sessionID: root.id, directory: "/repo" }])
    assert.equal(listCall, 3)
    assert.ok(lists.every((input: any) => input.project === "project" && input.directory === undefined))
  })
})
