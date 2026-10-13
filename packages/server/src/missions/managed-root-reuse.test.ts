import assert from "node:assert/strict"
import test from "node:test"
import { MissionControl, MissionControlError } from "./control"
import type { MissionDelegateInput, MissionManagedRootCreation, MissionSessionAdapter, NativeMissionSession } from "./control-types"
import { stableToken, type MissionStorage } from "./journal"
import type { MissionJsonValue } from "./model"

function harness() {
  const values = new Map<string, MissionJsonValue>()
  const storage: MissionStorage = {
    async get(key) { return structuredClone(values.get(key)) },
    async set(key, value) { values.set(key, structuredClone(value)) },
    async scan({ prefix, after, limit = 100 }) {
      const keys = [...values.keys()].filter(key => key.startsWith(prefix) && (!after || key > after)).sort()
      const selected = keys.slice(0, limit)
      return { entries: selected.map(key => ({ key, value: structuredClone(values.get(key)!) })),
        ...(keys.length > limit ? { next: selected.at(-1) } : {}) }
    },
  }
  const coordinator: NativeMissionSession = { id: "ses_coordinator", projectID: "project", title: "Coordinator",
    location: { directory: "/repo" } }
  const sessions = new Map([[coordinator.id, coordinator]])
  const prompts: Array<Parameters<MissionSessionAdapter["prompt"]>[0]> = []
  const creates: string[] = [], managedCreates: string[] = []
  let failCreateAck = false, failPrompt = false, now = 100
  const adapter: MissionSessionAdapter = {
    async get({ sessionID }) {
      const session = sessions.get(sessionID)
      if (!session) throw new Error("missing")
      return structuredClone(session)
    },
    async create(input) {
      creates.push(input.id)
      const session = { ...input, projectID: "project" }
      sessions.set(input.id, session)
      return session
    },
    async prompt(input) {
      if (failPrompt) throw new Error("prompt unavailable")
      prompts.push(input)
    },
    async synthetic() {},
  }
  const create = () => {
    let control: MissionControl
    const createManagedRoot: MissionManagedRootCreation = async (_, input) => {
      managedCreates.push(input.taskKey)
      const mission = (await control.snapshot()).missions.find(mission => mission.id === input.missionID)!
      const task = mission.tasks.find(task => task.key === input.taskKey)!
      assert.equal(task.actorSessionId, `ses_${stableToken(`${mission.id}\0task\0${task.id}`, 26)}`,
        "The authenticated creation capability accepts only this task's deterministic root")
      const session = sessions.get(task.actorSessionId!) ?? await adapter.create({ id: task.actorSessionId!, title: task.title,
        location: coordinator.location, metadata: {}, ...task.execution })
      if (failCreateAck) throw new Error("creation-uncertain")
      return session
    }
    control = new MissionControl({ storage, sessions: adapter, createManagedRoot,
      project: { id: "project", canonical: "/repo", location: coordinator.location }, now: () => now++ })
    return control
  }
  const assignment = (taskKey: string, targetSessionID?: string): MissionDelegateInput => ({ taskKey, targetSessionID,
    title: taskKey, brief: "Keep the native context", role: "reviewer", blockedBy: [], delivery: "queue",
    executionMode: { kind: "independent", reason: targetSessionID ? "existing-root" : "lifetime", explanation: "Bounded explicit root work" },
    execution: { agent: "reviewer", model: { providerID: "fixture", id: "selected", variant: "careful" } } })
  const start = async () => {
    const control = create()
    await control.inspect(coordinator.id, { start: { objective: "Root provenance", template: "custom" } }, "start")
    return control
  }
  return { sessions, prompts, creates, managedCreates, assignment, create, start,
    setFailCreateAck(value: boolean) { failCreateAck = value }, setFailPrompt(value: boolean) { failPrompt = value } }
}

test("managed root reuse queues a new assignment without recreating or dropping cleanup provenance, including restart/retry", async () => {
  const f = harness(), control = await f.start()
  const first = await control.delegate("ses_coordinator", f.assignment("source"))
  const actorID = first.mission.tasks[0].actorSessionId!
  const actor = first.mission.actors.find(actor => actor.sessionId === actorID)!
  const before = structuredClone(f.sessions.get(actorID))
  f.setFailPrompt(true)
  await assert.rejects(control.delegate("ses_coordinator", f.assignment("reuse", actorID)), /prompt unavailable/)
  assert.deepEqual(f.managedCreates, ["source"], "Even failed reuse never requests a new root")
  f.setFailPrompt(false)
  const reused = await f.create().delegate("ses_coordinator", f.assignment("reuse", actorID))
  assert.equal(reused.disposition, "dispatched")
  assert.deepEqual(reused.mission.actors.find(actor => actor.sessionId === actorID), actor)
  assert.equal(reused.mission.tasks[1].actorSessionId, actorID)
  assert.deepEqual(f.sessions.get(actorID), before)
  assert.equal(f.creates.length, 1)
  assert.deepEqual(f.managedCreates, ["source"])
  assert.equal(f.prompts[1].sessionID, actorID)
  assert.equal(f.prompts[1].delivery, "queue")
  assert.equal(f.prompts[1].resume, true)
  assert.equal((await f.create().delegate("ses_coordinator", f.assignment("reuse", actorID))).disposition, "existing")
  assert.equal(f.prompts.length, 2)
})

test("a late readable root cannot bypass uncertain original creation through explicit reuse or retry", async () => {
  const f = harness(), control = await f.start()
  f.setFailCreateAck(true)
  await assert.rejects(control.delegate("ses_coordinator", f.assignment("source")), /creation-uncertain/)
  const actorID = (await control.snapshot()).missions[0].tasks[0].actorSessionId!
  assert.ok(f.sessions.has(actorID), "Native root exists despite lost acknowledgement")
  await assert.rejects(f.create().delegate("ses_coordinator", f.assignment("source")), /creation-uncertain/)
  await assert.rejects(f.create().delegate("ses_coordinator", f.assignment("reuse", actorID)),
    error => error instanceof MissionControlError && error.code === "invalid-dispatch")
  assert.deepEqual(f.managedCreates, ["source", "source"])
  assert.equal(f.prompts.length, 0)
  f.setFailCreateAck(false)
  await f.create().delegate("ses_coordinator", f.assignment("source"))
  await f.create().delegate("ses_coordinator", f.assignment("reuse", actorID))
  assert.equal(f.creates.length, 1)
  assert.deepEqual(f.managedCreates, ["source", "source", "source"])
  assert.equal(f.prompts.length, 2)
})

test("reuse of a missing managed root fails closed and never recreates it under a later assignment", async () => {
  const f = harness(), control = await f.start()
  const first = await control.delegate("ses_coordinator", f.assignment("source"))
  const actorID = first.mission.tasks[0].actorSessionId!
  f.setFailPrompt(true)
  await assert.rejects(control.delegate("ses_coordinator", f.assignment("reuse", actorID)), /prompt unavailable/)
  f.sessions.delete(actorID)
  f.setFailPrompt(false)
  await assert.rejects(f.create().delegate("ses_coordinator", f.assignment("reuse", actorID)),
    error => error instanceof MissionControlError && error.code === "target-missing")
  assert.equal(f.creates.length, 1)
  assert.deepEqual(f.managedCreates, ["source"])
  assert.equal(f.prompts.length, 1)
})

test("managed root reuse rechecks profile, location and root ownership without switching the actor", async () => {
  for (const change of ["profile", "location", "project", "parent"] as const) {
    const f = harness(), control = await f.start()
    const first = await control.delegate("ses_coordinator", f.assignment("source"))
    const actorID = first.mission.tasks[0].actorSessionId!
    f.setFailPrompt(true)
    await assert.rejects(control.delegate("ses_coordinator", f.assignment("reuse", actorID)), /prompt unavailable/)
    const actor = f.sessions.get(actorID)!
    if (change === "profile") actor.agent = "another-agent"
    if (change === "location") actor.location = { directory: "/moved" }
    if (change === "project") actor.projectID = "foreign"
    if (change === "parent") actor.parentID = "ses_coordinator"
    f.setFailPrompt(false)
    await assert.rejects(f.create().delegate("ses_coordinator", f.assignment("reuse", actorID)),
      error => error instanceof MissionControlError && ["execution-conflict", "foreign-session", "child-session"].includes(error.code))
    assert.equal(f.creates.length, 1)
    assert.deepEqual(f.managedCreates, ["source"])
    assert.equal(f.prompts.length, 1)
  }
})
