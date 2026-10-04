import assert from "node:assert/strict"
import test from "node:test"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { admitMissionInput } from "./mission-input"

function fixture() {
  const target = { sessionID: "ses_actor", coordinatorSessionID: "ses_coordinator", projectID: "project", missionID: "msn_fixture", location: { directory: "/repo" } }
  const sessions = new Map<string, any>([
    ["ses_coordinator", { id: "ses_coordinator", projectID: "project", location: { directory: "/repo" } }],
    ["ses_actor", { id: "ses_actor", projectID: "project", location: { directory: "/repo" },
      metadata: { "codenomad.mission": { version: 1, missionID: "msn_fixture", kind: "actor" } } }],
  ])
  const state = { allowed: true, current: true, owned: true, children: false, fail: false, afterList: () => {} }
  const removed: string[] = []
  const client = {
    rpc: () => ({ cleanupTarget: async () => state.allowed ? { target } : {} }),
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (state.fail) throw new Error("read failed")
        if (!sessions.has(sessionID)) throw Object.assign(new Error("missing"), { _tag: "SessionNotFoundError", sessionID })
        return structuredClone(sessions.get(sessionID))
      },
      list: async () => { state.afterList(); return { data: state.children ? [{ id: "ses_child" }] : [] } },
      remove: async ({ sessionID }: { sessionID: string }) => { removed.push(sessionID); sessions.delete(sessionID) },
    },
  }
  const manager = {
    list: () => [{ id: "workspace" }],
    getSharedServiceConnection: async () => ({ client, assertCurrent: () => { if (!state.current) throw new Error("stale") } }),
    ownsLocation: async () => state.owned,
    getWorktreeIdentityForPath: async () => "/repo",
  }
  const fence = new WorktreeDeletionFence()
  const command = { kind: "cleanup", input: { missionID: "msn_fixture", deletionID: "evt_delete", sessionID: "ses_actor" } }
  const send = (signal = new AbortController().signal) => admitMissionInput(manager as never, fence, "ses_coordinator", command, signal)
  return { target, state, sessions, removed, fence, send }
}

test("cleanup bridge removes only an authorized native specialist and tolerates confirmed absence", async () => {
  const f = fixture()
  assert.deepEqual(await f.send(), { outcome: "removed" })
  assert.deepEqual(await f.send(), { outcome: "removed" })
  assert.deepEqual(f.removed, ["ses_actor"])
  assert.ok(f.sessions.has("ses_coordinator"))
})

test("cleanup bridge retains reused, moved, foreign and child-bearing sessions", async () => {
  for (const mode of ["no-permit", "metadata", "project", "directory", "workspace", "parent", "children", "move-during-read"]) {
    const f = fixture()
    const session = f.sessions.get("ses_actor")
    if (mode === "no-permit") f.state.allowed = false
    if (mode === "metadata") session.metadata = {}
    if (mode === "project") session.projectID = "other"
    if (mode === "directory") session.location.directory = "/other"
    if (mode === "workspace") session.location.workspaceID = "other"
    if (mode === "parent") session.parentID = "ses_other"
    if (mode === "children") f.state.children = true
    if (mode === "move-during-read") f.state.afterList = () => { session.location.directory = "/other" }
    const result = await f.send() as { outcome: string; reason?: string }
    assert.equal(result.outcome, "retained", mode)
    if (mode === "children") assert.equal(result.reason, "children")
    if (mode === "directory" || mode === "workspace" || mode === "move-during-read") assert.equal(result.reason, "moved")
    assert.deepEqual(f.removed, [])
  }
})

test("cleanup bridge fails closed across lost ownership, connections, cancellation and read errors", async () => {
  for (const mode of ["unowned", "foreign-permit", "coordinator", "stale", "stale-after-read", "abort", "read-error"]) {
    const f = fixture()
    const abort = new AbortController()
    if (mode === "unowned") f.state.owned = false
    if (mode === "foreign-permit") f.target.projectID = "other"
    if (mode === "coordinator") f.target.sessionID = "ses_coordinator"
    if (mode === "stale") f.state.current = false
    if (mode === "stale-after-read") f.state.afterList = () => { f.state.current = false }
    if (mode === "abort") f.state.afterList = () => abort.abort()
    if (mode === "read-error") f.state.fail = true
    await assert.rejects(f.send(abort.signal), `Must reject ${mode}`)
    assert.deepEqual(f.removed, [])
    await f.fence.run("project", ["/repo"], async () => {})
  }
})

test("cleanup respects a concurrent worktree mutation fence", async () => {
  const f = fixture()
  await f.fence.run("project", ["/repo"], async () => {
    await assert.rejects(f.send(), /Worktree mutation/)
  })
  assert.deepEqual(f.removed, [])
})
