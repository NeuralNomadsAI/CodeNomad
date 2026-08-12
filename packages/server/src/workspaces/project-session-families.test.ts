import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { OpenCodeClient, SessionInfo } from "@opencode-ai/client"
import {
  listCompleteProjectSessions,
  moveProjectSessionFamily,
  ProjectSessionError,
  removeProjectWorktree,
  resolveSessionFamilies,
} from "./project-session-families"

const ROOT = "/repo"
const WORKTREE = "/repo/.codenomad/worktrees/feature"

function session(id: string, parentID?: string, directory = ROOT): SessionInfo {
  return {
    id,
    parentID,
    projectID: "project",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    location: { directory },
  }
}

function clientHarness(initial: SessionInfo[], options: {
  active?: string[]
  failMove?: (sessionId: string, call: number) => boolean
  moveGate?: (sessionId: string) => Promise<void>
} = {}) {
  const sessions = new Map(initial.map((value) => [value.id, structuredClone(value)]))
  const moveCalls: string[] = []
    const listCalls: Array<{ cursor?: string; project?: string; order?: string }> = []
  let moveCall = 0
  const client = {
    location: {
      get: async ({ location: value }: { location?: { directory?: string } }) => ({
        directory: value?.directory ?? ROOT,
        project: { id: "project", directory: ROOT, canonical: ROOT },
      }),
    },
    session: {
      list: async (input: { cursor?: string; project?: string; order?: string }) => {
        listCalls.push(input)
        return { data: Array.from(sessions.values()).map((value) => structuredClone(value)), cursor: {} }
      },
      active: async () => Object.fromEntries((options.active ?? []).map((id) => [id, { type: "running" as const }])),
      get: async ({ sessionID }: { sessionID: string }) => structuredClone(sessions.get(sessionID)!),
      move: async ({ sessionID, directory, workspaceID }: { sessionID: string; directory: string; workspaceID?: string }) => {
        moveCall += 1
        moveCalls.push(sessionID)
        if (options.failMove?.(sessionID, moveCall)) throw new Error(`move failed: ${sessionID}`)
        await options.moveGate?.(sessionID)
        sessions.get(sessionID)!.location = { directory, workspaceID }
      },
    },
  } as unknown as OpenCodeClient
  return { client, sessions, moveCalls, listCalls }
}

describe("project session families", () => {
  it("loads every cursor page and rejects repeated cursors", async () => {
    const first = session("root")
    const second = session("child", "root")
    let call = 0
    const paged = {
      session: {
        list: async () => ++call === 1
          ? { data: [first], cursor: { next: "next" } }
          : { data: [second], cursor: {} },
      },
    } as unknown as OpenCodeClient
    assert.deepEqual((await listCompleteProjectSessions(paged, "project")).map(({ id }) => id), ["root", "child"])
    assert.equal(call, 2)

    const repeated = {
      session: { list: async () => ({ data: [], cursor: { next: "same" } }) },
    } as unknown as OpenCodeClient
    await assert.rejects(() => listCompleteProjectSessions(repeated, "project"), /repeated cursor/)
  })

  it("resolves complete root and descendant families and fails closed on missing parents and cycles", () => {
    assert.deepEqual(
      Array.from(resolveSessionFamilies([session("child", "root"), session("root")]).entries())
        .map(([root, members]) => [root, members.map(({ id }) => id)]),
      [["root", ["root", "child"]]],
    )
    assert.throws(() => resolveSessionFamilies([session("child", "missing")]), /missing parent/)
    assert.throws(() => resolveSessionFamilies([session("a", "b"), session("b", "a")]), /cycle/)
  })

  it("moves root and descendants sequentially and verifies authoritative locations", async () => {
    const harness = clientHarness([session("child", "root"), session("root")])
    const result = await moveProjectSessionFamily({
      client: harness.client,
      projectDirectory: ROOT,
      sessionId: "child",
      targetDirectory: WORKTREE,
    })
    assert.deepEqual(result, { rootSessionId: "root", sessionIds: ["root", "child"] })
    assert.ok(harness.listCalls.every(({ order }) => order === "asc"))
    assert.deepEqual(harness.moveCalls, ["root", "child"])
    assert.equal(harness.sessions.get("root")?.location.directory, WORKTREE)
    assert.equal(harness.sessions.get("child")?.location.directory, WORKTREE)
  })

  it("refreshes and rolls back after a partial move failure", async () => {
    const harness = clientHarness([session("root"), session("child", "root")], {
      failMove: (id, call) => id === "child" && call === 2,
    })
    await assert.rejects(() => moveProjectSessionFamily({
      client: harness.client,
      projectDirectory: ROOT,
      sessionId: "root",
      targetDirectory: WORKTREE,
    }), /move failed/)
    assert.deepEqual(harness.moveCalls, ["root", "child", "root"])
    assert.equal(harness.sessions.get("root")?.location.directory, ROOT)
    assert.ok(harness.listCalls.length >= 2)
  })

  it("serializes concurrent operations for the same project", async () => {
    let release!: () => void
    let firstMoveStarted!: () => void
    const started = new Promise<void>((resolve) => { firstMoveStarted = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    let held = true
    const harness = clientHarness([session("root")], {
      moveGate: async () => {
        if (!held) return
        firstMoveStarted()
        await gate
        held = false
      },
    })
    const first = moveProjectSessionFamily({ client: harness.client, projectDirectory: ROOT, sessionId: "root", targetDirectory: WORKTREE })
    await started
    const second = moveProjectSessionFamily({ client: harness.client, projectDirectory: ROOT, sessionId: "root", targetDirectory: ROOT })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(harness.moveCalls, ["root"])
    release()
    await Promise.all([first, second])
    assert.deepEqual(harness.moveCalls, ["root", "root"])
  })

  it("evacuates attached families before deletion and blocks active sessions", async () => {
    const harness = clientHarness([session("root", undefined, WORKTREE), session("child", "root", WORKTREE)])
    let removed = false
    await removeProjectWorktree({
      client: harness.client,
      projectDirectory: ROOT,
      targetDirectory: WORKTREE,
      rootDirectory: ROOT,
      remove: async () => { removed = true },
      isTargetRegistered: async () => true,
    })
    assert.equal(removed, true)
    assert.deepEqual(harness.moveCalls, ["root", "child"])

    const active = clientHarness([session("blocked", undefined, WORKTREE)], { active: ["blocked"] })
    await assert.rejects(() => removeProjectWorktree({
      client: active.client,
      projectDirectory: ROOT,
      targetDirectory: WORKTREE,
      rootDirectory: ROOT,
      remove: async () => assert.fail("Git removal must not run"),
      isTargetRegistered: async () => true,
    }), (error: unknown) => error instanceof ProjectSessionError && error.statusCode === 409)
    assert.deepEqual(active.moveCalls, [])
  })

  it("rolls sessions back when Git removal fails while the worktree remains registered", async () => {
    const harness = clientHarness([session("root", undefined, WORKTREE)])
    await assert.rejects(() => removeProjectWorktree({
      client: harness.client,
      projectDirectory: ROOT,
      targetDirectory: WORKTREE,
      rootDirectory: ROOT,
      remove: async () => { throw new ProjectSessionError("dirty worktree", 409) },
      isTargetRegistered: async () => true,
    }), /dirty worktree/)
    assert.deepEqual(harness.moveCalls, ["root", "root"])
    assert.equal(harness.sessions.get("root")?.location.directory, WORKTREE)
  })
})
