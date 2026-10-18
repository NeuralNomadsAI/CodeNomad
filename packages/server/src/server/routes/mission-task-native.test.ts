import assert from "node:assert/strict"
import test from "node:test"
import { interruptMissionTask, observeMissionTask } from "./mission-task-native"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { buildAssignmentPrompt } from "../../missions/recipes"
import type { MissionMap, MissionTask } from "../../missions/model"

const location = { directory: "/repo" }
const task = (key: string, status: MissionTask["status"] = "ready"): MissionTask => ({ id: `tsk_${key}`, key, title: key, brief: "Work",
  role: "specialist", blockedBy: [], status, createdAt: 1, updatedAt: 1, outstandingExecution: false, contractGeneration: 1,
  executionMode: { kind: "native", parentTaskKey: null } })

/** The coordinator launched ses_task for scope-a (with a running helper) and ses_other for scope-b. */
function fixture(status: MissionTask["status"] = "withdrawn") {
  const mission = { version: 1, id: "msn_fixture", projectID: "project", projectCanonical: "/repo", objective: "Chart",
    template: "custom", taskMode: "native", status: "active", runState: "running", coordinatorSessionId: "ses_coordinator",
    actors: [], tasks: [task("scope-a", status), task("scope-b")], reports: [], frontier: [], claims: [],
    createdAt: 1, updatedAt: 1, revision: 3, history: [], historyTruncated: false } as unknown as MissionMap
  const native = new Map<string, any>([
    ["ses_coordinator", { id: "ses_coordinator", projectID: "project", location }],
    ["ses_task", { id: "ses_task", parentID: "ses_coordinator", projectID: "project", location }],
    ["ses_helper", { id: "ses_helper", parentID: "ses_task", projectID: "project", location }],
    ["ses_other", { id: "ses_other", parentID: "ses_coordinator", projectID: "project", location }],
  ])
  const firsts = new Map([
    ["ses_task", { id: "msg_a", type: "user", text: buildAssignmentPrompt(mission, mission.tasks[0]) }],
    ["ses_other", { id: "msg_b", type: "user", text: buildAssignmentPrompt(mission, mission.tasks[1]) }],
  ])
  const running = new Set(["ses_task", "ses_helper", "ses_other"])
  const inboxes = new Map<string, any[]>([["ses_task", [{ id: "inb_continue", type: "user", payload: { text: "Keep going" } }]]])
  const calls: string[] = []
  const client = {
    rpc: () => ({ snapshot: async () => ({ projectID: "project", missions: [structuredClone(mission)] }) }),
    message: { list: async ({ sessionID }: any) => ({ data: firsts.has(sessionID) ? [structuredClone(firsts.get(sessionID))] : [] }) },
    session: {
      get: async ({ sessionID }: any) => structuredClone(native.get(sessionID)),
      list: async ({ parentID }: any) => ({ data: [...native.values()].filter(session => session.parentID === parentID).map(session => structuredClone(session)), cursor: { next: null } }),
      active: async () => Object.fromEntries([...running].map(id => [id, { type: "running" }])),
      interrupt: async ({ sessionID }: any) => { calls.push(`interrupt:${sessionID}`); return { interrupted: running.delete(sessionID) } },
      inbox: {
        list: async ({ sessionID }: any) => structuredClone(inboxes.get(sessionID) ?? []),
        cancel: async ({ sessionID, inboxID }: any) => { calls.push(`cancel:${sessionID}`); inboxes.set(sessionID, (inboxes.get(sessionID) ?? []).filter(item => item.id !== inboxID)) },
      },
    },
  }
  const manager = { list: () => [{ id: "workspace" }], getSharedServiceConnection: async () => ({ client, assertCurrent: () => {} }),
    ownsLocation: async () => true, getWorktreeIdentityForPath: async () => "/repo" }
  const command = (kind: string, taskKey = "scope-a") => ({ kind, input: { missionID: mission.id, taskKey } })
  const signal = new AbortController().signal
  return { mission, running, inboxes, calls, manager: manager as never, command, signal }
}

test("a task's conversations are its coordinator children carrying its exact canonical assignment", async () => {
  const f = fixture("ready")
  assert.deepEqual(await observeMissionTask(f.manager, "ses_coordinator", f.command("task-sessions"), f.signal),
    { sessions: [{ sessionID: "ses_task", active: true }], complete: true })
  assert.deepEqual(await observeMissionTask(f.manager, "ses_coordinator", f.command("task-sessions", "scope-b"), f.signal),
    { sessions: [{ sessionID: "ses_other", active: true }], complete: true })
  await assert.rejects(observeMissionTask(f.manager, "ses_other", f.command("task-sessions"), f.signal), /Missing mission owner|Foreign/)
  await assert.rejects(observeMissionTask(f.manager, "ses_coordinator", { kind: "task-sessions", input: { missionID: "msn_fixture", taskKey: "x", raw: 1 } }, f.signal))
})

test("stopping a retired task interrupts its family deepest first, cancels its queue and spares everything else", async () => {
  const f = fixture()
  const result = await interruptMissionTask(f.manager, new WorktreeDeletionFence(), "ses_coordinator", f.command("interrupt"), f.signal)
  assert.deepEqual(f.calls.filter(call => call.startsWith("interrupt:")), ["interrupt:ses_helper", "interrupt:ses_task"])
  assert.equal(f.running.has("ses_other"), true, "another task's conversation keeps running")
  assert.equal(f.calls.some(call => call.endsWith(":ses_coordinator")), false, "the coordinator is never touched")
  assert.deepEqual(f.inboxes.get("ses_task"), [], "queued inputs cannot re-wake retired work")
  assert.equal(result.complete, true)
  assert.deepEqual(result.sessions.map(session => [session.sessionID, session.interrupted, session.settled, session.descendants.interrupted]),
    [["ses_task", true, true, 1]])
})

test("live tasks and fenced worktrees are never interrupted", async () => {
  const live = fixture("ready")
  await assert.rejects(interruptMissionTask(live.manager, new WorktreeDeletionFence(), "ses_coordinator", live.command("interrupt"), live.signal),
    (error: any) => error.code === "task-not-retired")
  assert.deepEqual(live.calls, [])
  const fenced = fixture(), fence = new WorktreeDeletionFence()
  let release!: () => void
  const deletion = fence.run("/repo", ["/repo"], () => new Promise<void>(resolve => { release = resolve }))
  try {
    await assert.rejects(interruptMissionTask(fenced.manager, fence, "ses_coordinator", fenced.command("interrupt"), fenced.signal), /Worktree mutation/)
    assert.deepEqual(fenced.calls, [])
  } finally { release?.(); await deletion }
})
