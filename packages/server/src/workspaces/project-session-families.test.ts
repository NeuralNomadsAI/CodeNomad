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
  active?: string[] | (() => string[])
  failMove?: (sessionId: string, call: number) => boolean
  visibilityDelayGets?: number
} = {}) {
  const sessions = new Map(initial.map((value) => [value.id, structuredClone(value)]))
  const moveCalls: string[] = []
  let moveCall = 0
  const pending = new Map<string, { location: SessionInfo["location"]; remaining: number }>()
  const client = {
    location: {
      get: async ({ location }: { location?: { directory?: string } }) => ({
        directory: location?.directory ?? ROOT,
        project: { id: "project", directory: ROOT, canonical: ROOT },
      }),
    },
    session: {
      list: async () => ({ data: Array.from(sessions.values()).map((value) => structuredClone(value)), cursor: {} }),
      active: async () => Object.fromEntries((typeof options.active === "function" ? options.active() : options.active ?? []).map((id) => [id, { type: "running" as const }])),
      get: async ({ sessionID }: { sessionID: string }) => {
        const update = pending.get(sessionID)
        if (update && update.remaining-- <= 0) {
          sessions.get(sessionID)!.location = update.location
          pending.delete(sessionID)
        }
        return structuredClone(sessions.get(sessionID)!)
      },
      move: async ({ sessionID, directory, workspaceID }: { sessionID: string; directory: string; workspaceID?: string }) => {
        moveCall += 1
        moveCalls.push(sessionID)
        if (options.failMove?.(sessionID, moveCall)) throw new Error(`move failed: ${sessionID}`)
        const location = { directory, workspaceID }
        if (options.visibilityDelayGets) pending.set(sessionID, { location, remaining: options.visibilityDelayGets })
        else sessions.get(sessionID)!.location = location
      },
    },
  } as unknown as OpenCodeClient
  return { client, sessions, moveCalls }
}

describe("project session families", () => {
  it("loads the complete paginated project inventory", async () => {
    const calls: Array<{ project?: string; cursor?: string }> = []
    const client = {
      session: {
        list: async (input: { project?: string; cursor?: string }) => {
          calls.push(input)
          return input.cursor
            ? { data: [session("child", "root")], cursor: {} }
            : { data: [session("root")], cursor: { next: "next" } }
        },
      },
    } as unknown as OpenCodeClient

    assert.deepEqual((await listCompleteProjectSessions(client, "project")).map(({ id }) => id), ["root", "child"])
    assert.ok(calls.every(({ project }) => project === "project"))
    assert.equal(calls[1]?.cursor, "next")
  })

  it("rejects malformed native cursors", async () => {
    const client = { session: { list: async () => ({ data: [session("root")], cursor: { next: 42 } }) } } as unknown as OpenCodeClient
    await assert.rejects(() => listCompleteProjectSessions(client, "project"), /invalid session inventory cursor/)
  })

  it("resolves complete families and rejects incomplete ancestry", () => {
    assert.deepEqual(
      Array.from(resolveSessionFamilies([session("child", "root"), session("root")]).values())
        .map((family) => family.map(({ id }) => id)),
      [["root", "child"]],
    )
    assert.throws(() => resolveSessionFamilies([session("child", "missing")]), /missing parent/)
  })

  it("moves a complete family to the target", async () => {
    const harness = clientHarness([session("root"), session("child", "root")])
    const moved = await moveProjectSessionFamily({
      client: harness.client,
      projectDirectory: ROOT,
      sessionId: "child",
      targetDirectory: WORKTREE,
    })
    assert.deepEqual(moved.sessionIds, ["root", "child"])
    assert.ok([...harness.sessions.values()].every(({ location }) => location.directory === WORKTREE))
  })

  it("waits for delayed move visibility", async () => {
    const harness = clientHarness([session("root")], { visibilityDelayGets: 2 })
    await moveProjectSessionFamily({ client: harness.client, projectDirectory: ROOT, sessionId: "root", targetDirectory: WORKTREE })
    assert.equal(harness.sessions.get("root")?.location.directory, WORKTREE)
  })

  it("rolls back transaction-owned moves after partial failure", async () => {
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
  })

  it("blocks deletion while an attached session is active", async () => {
    const harness = clientHarness([session("blocked", undefined, WORKTREE)], { active: ["blocked"] })
    await assert.rejects(() => removeProjectWorktree({
      client: harness.client,
      projectDirectory: ROOT,
      targetDirectory: WORKTREE,
      rootDirectory: ROOT,
      remove: async () => assert.fail("Git removal must not run"),
      isTargetRegistered: async () => true,
    }), (error: unknown) => error instanceof ProjectSessionError && error.statusCode === 409)
    assert.deepEqual(harness.moveCalls, [])
  })

  it("rolls back when a family member becomes active during evacuation", async () => {
    let harness: ReturnType<typeof clientHarness>
    harness = clientHarness([session("root", undefined, WORKTREE), session("child", "root", WORKTREE)], {
      active: () => harness.moveCalls.includes("root") ? ["child"] : [],
    })
    await assert.rejects(() => removeProjectWorktree({
      client: harness.client,
      projectDirectory: ROOT,
      targetDirectory: WORKTREE,
      rootDirectory: ROOT,
      remove: async () => assert.fail("Git removal must not run"),
      isTargetRegistered: async () => true,
    }), /Active sessions block/)
    assert.equal(harness.sessions.get("root")?.location.directory, WORKTREE)
  })

  it("evacuates a complete family before removing its worktree", async () => {
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
    assert.ok([...harness.sessions.values()].every(({ location }) => location.directory === ROOT))
  })

  it("rolls back only while the original worktree identity remains", async () => {
    const original = clientHarness([session("original", undefined, WORKTREE)])
    await assert.rejects(() => removeProjectWorktree({
      client: original.client,
      projectDirectory: ROOT,
      targetDirectory: WORKTREE,
      rootDirectory: ROOT,
      remove: async () => { throw new ProjectSessionError("dirty worktree", 409) },
      isTargetRegistered: async () => true,
    }), /dirty worktree/)
    assert.equal(original.sessions.get("original")?.location.directory, WORKTREE)

    const replacement = clientHarness([session("replacement", undefined, WORKTREE)])
    let identityChecks = 0
    await assert.rejects(() => removeProjectWorktree({
      client: replacement.client,
      projectDirectory: ROOT,
      targetDirectory: WORKTREE,
      rootDirectory: ROOT,
      remove: async () => { throw new ProjectSessionError("worktree changed", 409) },
      isTargetRegistered: async () => ++identityChecks === 1,
    }), /worktree changed/)
    assert.deepEqual(replacement.moveCalls, ["replacement"])
    assert.equal(replacement.sessions.get("replacement")?.location.directory, ROOT)
  })
})
