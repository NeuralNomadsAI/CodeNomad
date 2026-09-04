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

function session(id: string, parentID?: string, directory = ROOT, workspaceID?: string): SessionInfo {
  return {
    id,
    parentID,
    projectID: "project",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    location: { directory, workspaceID },
  }
}

function clientHarness(initial: SessionInfo[], options: {
  active?: string[] | (() => string[])
  failMove?: (sessionId: string, call: number) => boolean
  visibilityDelayGets?: number
  workspaceID?: string
} = {}) {
  const sessions = new Map(initial.map((value) => [value.id, structuredClone(value)]))
  const moveCalls: string[] = []
  let moveCall = 0
  const pending = new Map<string, { location: SessionInfo["location"]; remaining: number }>()
  const client = {
    location: {
      get: async ({ location }: { location?: { directory?: string } }) => ({
        directory: location?.directory ?? ROOT,
        workspaceID: options.workspaceID,
        project: { id: "project", directory: ROOT, canonical: ROOT },
      }),
    },
    session: {
      list: async (input?: { workspace?: string }) => ({
        data: Array.from(sessions.values())
          .filter((value) => !input?.workspace || value.location.workspaceID === input.workspace)
          .map((value) => structuredClone(value)),
        cursor: {},
      }),
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
    const calls: Array<{ project?: string; workspace?: string; cursor?: string; limit?: number; order?: string }> = []
    const pages = [
      session("root", undefined, ROOT, "workspace"),
      session("child-1", "root", ROOT, "workspace"),
      session("child-2", "root", ROOT, "workspace"),
      session("child-3", "root", ROOT, "workspace"),
      session("child-4", "root", ROOT, "workspace"),
    ]
    const client = {
      session: {
        list: async (input: { project?: string; cursor?: string }) => {
          calls.push(input)
          const index = input.cursor ? Number(input.cursor.slice("page-".length)) - 1 : 0
          return { data: [pages[index]!], cursor: { next: index < pages.length - 1 ? `page-${index + 2}` : null } }
        },
      },
    } as unknown as OpenCodeClient

    assert.deepEqual((await listCompleteProjectSessions(client, "project", "workspace")).map(({ id }) => id), pages.map(({ id }) => id))
    assert.deepEqual(calls[0], { project: "project", workspace: "workspace", limit: 500, order: "asc" })
    assert.deepEqual(calls.slice(1), ["page-2", "page-3", "page-4", "page-5"].map((cursor) => ({ cursor })))
  })

  it("rejects malformed native cursors", async () => {
    const client = { session: { list: async () => ({ data: [session("root")], cursor: { next: 42 } }) } } as unknown as OpenCodeClient
    await assert.rejects(() => listCompleteProjectSessions(client, "project"), /invalid session inventory cursor/)
  })

  it("runs a family move inside the supplied worktree mutation guard", async () => {
    const harness = clientHarness([session("root"), session("child", "root")])
    const guarded: string[][] = []

    await moveProjectSessionFamily({
      client: harness.client,
      projectLocation: { directory: ROOT },
      sessionId: "root",
      targetDirectory: WORKTREE,
      runMutation: async (directories, operation) => {
        guarded.push(directories)
        return operation()
      },
    })

    assert.deepEqual(guarded, [[ROOT, ROOT, WORKTREE]])
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
      projectLocation: { directory: ROOT },
      sessionId: "child",
      targetDirectory: WORKTREE,
    })
    assert.deepEqual(moved.sessionIds, ["root", "child"])
    assert.ok([...harness.sessions.values()].every(({ location }) => location.directory === WORKTREE))
  })

  it("rejects a family split across native workspaces", async () => {
    const harness = clientHarness([
      session("root", undefined, ROOT, "owned-workspace"),
      session("child", "root", ROOT, "foreign-workspace"),
    ], { workspaceID: "owned-workspace" })

    await assert.rejects(() => moveProjectSessionFamily({
      client: harness.client,
      projectLocation: { directory: ROOT, workspaceID: "owned-workspace" },
      sessionId: "root",
      targetDirectory: WORKTREE,
    }), /another workspace/)
    assert.deepEqual(harness.moveCalls, [])
  })

  it("waits for delayed move visibility", async () => {
    const harness = clientHarness([session("root")], { visibilityDelayGets: 2 })
    await moveProjectSessionFamily({ client: harness.client, projectLocation: { directory: ROOT }, sessionId: "root", targetDirectory: WORKTREE })
    assert.equal(harness.sessions.get("root")?.location.directory, WORKTREE)
  })

  it("rolls back transaction-owned moves after partial failure", async () => {
    const harness = clientHarness([session("root"), session("child", "root")], {
      failMove: (id, call) => id === "child" && call === 2,
    })
    await assert.rejects(() => moveProjectSessionFamily({
      client: harness.client,
      projectLocation: { directory: ROOT },
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
      projectLocation: { directory: ROOT },
      targetDirectory: WORKTREE,
      rootDirectory: ROOT,
      remove: async () => assert.fail("Git removal must not run"),
      isTargetRegistered: async () => true,
    }), (error: unknown) => error instanceof ProjectSessionError && error.statusCode === 409)
    assert.deepEqual(harness.moveCalls, [])
  })

  it("re-inventories an initially empty worktree before removing it", async () => {
    const harness = clientHarness([])
    let lists = 0
    ;(harness.client.session.list as any) = async () => ({
      data: ++lists < 3 ? [] : [session("intruder", undefined, WORKTREE)],
      cursor: {},
    })

    await assert.rejects(() => removeProjectWorktree({
      client: harness.client,
      projectLocation: { directory: ROOT },
      targetDirectory: WORKTREE,
      rootDirectory: ROOT,
      remove: async () => assert.fail("Git removal must not run"),
      isTargetRegistered: async () => true,
    }), /Sessions remain attached/)
  })

  it("rechecks deletion blockers after evacuation", async () => {
    const harness = clientHarness([session("root", undefined, WORKTREE)])
    let checks = 0
    await assert.rejects(() => removeProjectWorktree({
      client: harness.client,
      projectLocation: { directory: ROOT },
      targetDirectory: WORKTREE,
      rootDirectory: ROOT,
      remove: async () => assert.fail("Git removal must not run"),
      isTargetRegistered: async () => true,
      validateBeforeRemove: async () => {
        if (++checks === 2) throw new ProjectSessionError("running resource", 409)
      },
    }), /running resource/)
    assert.equal(checks, 2)
    assert.equal(harness.sessions.get("root")?.location.directory, WORKTREE)
  })

  it("rolls back when a family member becomes active during evacuation", async () => {
    let harness: ReturnType<typeof clientHarness>
    harness = clientHarness([session("root", undefined, WORKTREE), session("child", "root", WORKTREE)], {
      active: () => harness.moveCalls.includes("root") ? ["child"] : [],
    })
    await assert.rejects(() => removeProjectWorktree({
      client: harness.client,
      projectLocation: { directory: ROOT },
      targetDirectory: WORKTREE,
      rootDirectory: ROOT,
      remove: async () => assert.fail("Git removal must not run"),
      isTargetRegistered: async () => true,
    }), /Active sessions block/)
    assert.equal(harness.sessions.get("root")?.location.directory, WORKTREE)
  })

  it("rolls back from session state when inventory visibility is stale", async () => {
    const harness = clientHarness([session("root"), session("child", "root")], {
      failMove: (id, call) => id === "child" && call === 2,
    })
    const stale = [session("root"), session("child", "root")]
    ;(harness.client.session.list as any) = async () => ({ data: structuredClone(stale), cursor: {} })
    await assert.rejects(() => moveProjectSessionFamily({
      client: harness.client,
      projectLocation: { directory: ROOT },
      sessionId: "root",
      targetDirectory: WORKTREE,
    }), /move failed/)
    assert.equal(harness.sessions.get("root")?.location.directory, ROOT)
  })

  it("treats WSL service directories as case-sensitive POSIX paths", async () => {
    const harness = clientHarness([session("upper", undefined, "/home/dev/Foo")])
    let removed = false
    await removeProjectWorktree({
      client: harness.client,
      projectLocation: { directory: ROOT },
      targetDirectory: "/home/dev/foo",
      rootDirectory: ROOT,
      remove: async () => { removed = true },
      isTargetRegistered: async () => true,
    })
    assert.equal(removed, true)
    assert.deepEqual(harness.moveCalls, [])
  })

  it("evacuates a complete family before removing its worktree", async () => {
    const harness = clientHarness([session("root", undefined, WORKTREE), session("child", "root", WORKTREE)])
    let removed = false
    await removeProjectWorktree({
      client: harness.client,
      projectLocation: { directory: ROOT },
      targetDirectory: WORKTREE,
      rootDirectory: ROOT,
      remove: async () => { removed = true },
      isTargetRegistered: async () => true,
    })
    assert.equal(removed, true)
    assert.ok([...harness.sessions.values()].every(({ location }) => location.directory === ROOT))
  })

  it("guards every family source worktree during evacuation", async () => {
    const sibling = "/repo/.codenomad/worktrees/sibling"
    const harness = clientHarness([session("root", undefined, sibling), session("child", "root", WORKTREE)])
    let guarded: string[] = []
    await removeProjectWorktree({
      client: harness.client,
      projectLocation: { directory: ROOT },
      targetDirectory: WORKTREE,
      rootDirectory: ROOT,
      remove: async () => undefined,
      isTargetRegistered: async () => true,
      runMutation: async (directories, operation) => {
        guarded = directories
        return operation()
      },
    })
    assert.ok(guarded.includes(sibling))
    assert.ok(guarded.includes(WORKTREE))
    assert.ok(guarded.includes(ROOT))
  })

  it("blocks physical deletion when another workspace still owns a target session", async () => {
    const harness = clientHarness([
      session("foreign", undefined, WORKTREE, "foreign-workspace"),
    ], { workspaceID: "owned-workspace" })
    await assert.rejects(() => removeProjectWorktree({
      client: harness.client,
      projectLocation: { directory: ROOT, workspaceID: "owned-workspace" },
      targetDirectory: WORKTREE,
      rootDirectory: ROOT,
      remove: async () => assert.fail("Git removal must not run"),
      isTargetRegistered: async () => true,
    }), /another workspace/)
  })

  it("ignores unrelated sessions from another workspace when fencing deletion", async () => {
    const harness = clientHarness([
      session("owned", undefined, WORKTREE, "owned-workspace"),
      session("foreign", undefined, "/other/project", "foreign-workspace"),
    ], { workspaceID: "owned-workspace" })
    let guarded: string[] = []
    await removeProjectWorktree({
      client: harness.client,
      projectLocation: { directory: ROOT, workspaceID: "owned-workspace" },
      targetDirectory: WORKTREE,
      rootDirectory: ROOT,
      remove: async () => undefined,
      isTargetRegistered: async () => true,
      runMutation: async (directories, operation) => {
        guarded = directories
        return operation()
      },
    })
    assert.equal(guarded.includes("/other/project"), false)
  })

  it("rolls back only while the original worktree identity remains", async () => {
    const original = clientHarness([session("original", undefined, WORKTREE)])
    await assert.rejects(() => removeProjectWorktree({
      client: original.client,
      projectLocation: { directory: ROOT },
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
      projectLocation: { directory: ROOT },
      targetDirectory: WORKTREE,
      rootDirectory: ROOT,
      remove: async () => { throw new ProjectSessionError("worktree changed", 409) },
      isTargetRegistered: async () => ++identityChecks === 1,
    }), /Worktree changed/)
    assert.deepEqual(replacement.moveCalls, ["replacement"])
    assert.equal(replacement.sessions.get("replacement")?.location.directory, ROOT)
  })
})
