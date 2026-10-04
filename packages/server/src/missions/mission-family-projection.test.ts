import assert from "node:assert/strict"
import test from "node:test"
import type { SessionInfo } from "@opencode/client"
import { projectMissionFamily } from "./mission-family-projection"
import type { MissionActor, MissionMap, MissionTask } from "./model"
import type { NativeMissionFamilyTree } from "./native-session-family"

const location = { directory: "/owned", workspaceID: "owned-workspace" }
const session = (id: string, parentID?: string): SessionInfo => ({ id, ...(parentID ? { parentID } : {}),
  projectID: "project", location, cost: 0, time: { created: 1, updated: 1 },
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
const actor = (sessionId: string): MissionActor => ({ sessionId, kind: "specialist", managed: true,
  title: sessionId, roles: [], location, joinedAt: 1 })
const map = (ids = ["root"], tasks: MissionTask[] = []): MissionMap => ({ version: 1, id: "mission", projectID: "project",
  projectCanonical: "/owned", objective: "Observe", template: "custom", status: "active", coordinatorSessionId: ids[0],
  revision: 1, actors: ids.map(actor), tasks, reports: [], frontier: [], claims: [], history: [], historyTruncated: false,
  createdAt: 1, updatedAt: 1 })
const tree = (...sessions: SessionInfo[]): NativeMissionFamilyTree => new Map(sessions.map(value => [value.id, value]))
const project = (mission: MissionMap, entries: Array<[string, NativeMissionFamilyTree]>, observed = true) =>
  projectMissionFamily({ mission, trees: new Map(entries), observed })
const unknown = { state: "unknown", members: [] }
const task = (key: string, actorSessionId = "worker", active = false): MissionTask => {
  const binding = { generation: 1, parentSessionID: "root", parentMessageID: `msg-${key}`, toolCallID: `call-${key}` }
  return { id: key, key, title: key, brief: key, role: "specialist", actorSessionId, status: "queued", blockedBy: [],
    nativeBinding: binding, nativeExecution: { binding, ...(active ? {} : { ended: "returned" as const }) },
    contractGeneration: 1, outstandingExecution: false, createdAt: 1, updatedAt: 1 }
}

test("ordinary descendants inherit nearest actual declared ancestor, never catalog order", () => {
  const mission = map(["root", "worker"], [task("current")])
  const root = session("root"), worker = session("worker", "middle"), middle = session("middle", "root"), leaf = session("leaf", "worker")
  // No fabricated task context: the native binding says root, while actual parent
  // is middle. Topology is still observed independently of business context.
  const before = structuredClone(mission)
  const result = project(mission, [["root", tree(leaf, middle, root, worker)], ["worker", tree(leaf, worker)]])
  assert.equal(result.state, "observed")
  assert.deepEqual(Object.fromEntries(result.members.map(member => [member.sessionId, member])), {
    root: { sessionId: "root", actorSessionId: "root", kind: "declared" },
    middle: { sessionId: "middle", parentSessionId: "root", actorSessionId: "root", kind: "ordinary" },
    worker: { sessionId: "worker", parentSessionId: "middle", actorSessionId: "worker", kind: "declared" },
    leaf: { sessionId: "leaf", parentSessionId: "worker", actorSessionId: "worker", kind: "ordinary" },
  })
  assert.deepEqual(mission, before)
})

test("overlapping actor families display declared actors exactly once and retain independent roots", () => {
  const root = session("root", "outside"), worker = session("worker", "root"), child = session("child", "worker"), other = session("other")
  const result = project(map(["root", "worker", "other"]), [["root", tree(root, worker, child)],
    ["worker", tree(worker, child)], ["other", tree(other)]])
  assert.equal(result.state, "observed")
  assert.equal(result.members.length, 4)
  assert.equal(result.members.filter(member => member.kind === "declared").length, 3)
  assert.equal(result.members.find(member => member.sessionId === "root")?.parentSessionId, "outside")
  assert.equal(result.members.find(member => member.sessionId === "child")?.actorSessionId, "worker")
})

test("a unique active native invocation outranks reported history regardless of row order and updatedAt", () => {
  const old = task("old"), current = task("current", "worker", true)
  old.status = "completed"; old.updatedAt = 999
  old.report = { id: "report", taskKey: old.key, sessionId: "worker", outcome: "completed", summary: "Old", evidence: [], next: [], createdAt: 999 }
  current.report = { ...old.report, id: "current-report", taskKey: current.key }
  current.status = "completed"
  const root = session("root"), worker = session("worker", "root"), child = session("child", "worker")
  for (const tasks of [[old, current], [current, old]]) {
    const result = project(map(["root", "worker"], tasks), [["root", tree(root, worker, child)], ["worker", tree(worker, child)]])
    assert.equal(result.state, "observed")
    for (const member of result.members.filter(member => member.actorSessionId === "worker")) assert.equal(member.taskKey, "current")
  }
})

test("unknown or tied invocation context omits taskKey instead of guessing a latest call", () => {
  const root = session("root"), worker = session("worker", "root")
  const entries: Array<[string, NativeMissionFamilyTree]> = [["root", tree(root, worker)], ["worker", tree(worker)]]
  for (const tasks of [[task("one"), task("two")], [task("one", "worker", true), task("two", "worker", true)],
    [task("one", "worker", true), { ...task("two"), contractGeneration: 2 }]]) {
    const result = project(map(["root", "worker"], tasks), entries)
    assert.equal(result.state, "observed")
    assert.ok(result.members.every(member => member.taskKey === undefined))
  }
})

test("saved task topology cannot graft a native child onto a different ancestor", () => {
  const value = task("declared"); value.executionMode = { kind: "native", parentTaskKey: "invented" }
  const root = session("root"), worker = session("worker", "root")
  const result = project(map(["root", "worker"], [value]), [["root", tree(root, worker)], ["worker", tree(worker)]])
  assert.equal(result.members.find(member => member.sessionId === "worker")?.parentSessionId, "root")
  assert.equal(result.members.find(member => member.sessionId === "worker")?.taskKey, "declared")
})

test("unobserved, missing, moved and foreign roots invalidate the whole mission membership", () => {
  const mission = map(["root", "worker"]), root = session("root"), worker = session("worker", "root")
  const entries: Array<[string, NativeMissionFamilyTree]> = [["root", tree(root, worker)], ["worker", tree(worker)]]
  assert.deepEqual(project(mission, entries, false), unknown)
  assert.deepEqual(project(mission, entries.slice(0, 1)), unknown)
  for (const changed of [{ ...worker, location: { ...location, workspaceID: "foreign" } },
    { ...worker, projectID: "foreign" }, { ...worker, id: "forged" }]) {
    assert.deepEqual(project(mission, [["root", tree(root, worker)], ["worker", new Map([["worker", changed]])]]), unknown)
  }
})

test("conflicting native parents or inherited Locations cannot leak partial members", () => {
  const root = session("root"), worker = session("worker", "root"), child = session("child", "worker")
  for (const changed of [{ ...child, parentID: "root" }, { ...child, location: { directory: location.directory } },
    { ...child, projectID: "foreign" }]) {
    assert.deepEqual(project(map(["root", "worker"]), [["root", tree(root, worker, child)], ["worker", tree(worker, changed)]]), unknown)
  }
})

test("cycles across roots and missing catalog edges fail closed", () => {
  const root = session("root"), worker = session("worker", "root")
  assert.deepEqual(project(map(["root", "worker"]), [["root", tree(root)], ["worker", tree(worker)]]), unknown)
  const cyclicRoot = session("root", "worker")
  assert.deepEqual(project(map(["root", "worker"]), [["root", tree(cyclicRoot, worker)], ["worker", tree(worker)]]), unknown)
  assert.deepEqual(project(map(), [["root", tree(root, session("orphan", "missing"))]]), unknown)
})

test("raw children consume only the family bound, never actor or task capacity", () => {
  const mission = map(), root = session("root"), children = Array.from({ length: 32 }, (_, i) => session(`child-${i}`, "root"))
  const result = project(mission, [["root", tree(root, ...children)]])
  assert.equal(result.state, "observed")
  assert.equal(result.members.length, 33)
  assert.equal(result.members.filter(member => member.kind === "ordinary").length, 32)
  assert.equal(mission.actors.length, 1)
  assert.equal(mission.tasks.length, 0)
  assert.deepEqual(project(mission, [["root", tree(root, ...children, session("too-many", "root"))]]), unknown)
})

test("duplicate declared identities cannot mint ordinary or repeated actor entries", () => {
  assert.deepEqual(project(map(["root", "root"]), [["root", tree(session("root"))]]), unknown)
})

test("unique independent execution context may display, but an unbound declaration cannot", () => {
  const value = task("independent", "root")
  delete value.nativeBinding; delete value.nativeExecution
  value.admissionId = "msg-existing"
  const entries: Array<[string, NativeMissionFamilyTree]> = [["root", tree(session("root"), session("child", "root"))]]
  assert.ok(project(map(["root"], [value]), entries).members.every(member => member.taskKey === value.key))
  delete value.admissionId
  assert.ok(project(map(["root"], [value]), entries).members.every(member => member.taskKey === undefined))
})
