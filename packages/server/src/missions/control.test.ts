import assert from "node:assert/strict"
import test from "node:test"
import { MISSION_MAX_ACTORS, MISSION_MAX_EVENTS, MISSION_MAX_MISSIONS, type MissionJsonValue } from "./model"

import {
  MissionControl,
  MissionControlError,
} from "./control"
import type {
  MissionSessionAdapter,
  MissionInputTransport,
  NativeMissionSession,
} from "./control-types"
import { MissionJournal, MISSION_JOURNAL_STORAGE_PREFIX, parseMissionEvent, type MissionStorage } from "./journal"

class MemoryStorage implements MissionStorage {
  readonly values = new Map<string, MissionJsonValue>()
  failNextEventType?: string

  async get(key: string) {
    return this.values.get(key)
  }

  async set(key: string, value: MissionJsonValue) {
    const eventType = value && typeof value === "object" && !Array.isArray(value)
      ? (value as { readonly [key: string]: MissionJsonValue }).type
      : undefined
    if (this.failNextEventType && eventType === this.failNextEventType) {
      const failedType = this.failNextEventType
      this.failNextEventType = undefined
      throw new Error(`failed to persist ${failedType}`)
    }
    this.values.set(key, structuredClone(value))
  }

  async scan(options: { prefix: string; after?: string; limit?: number }) {
    const keys = [...this.values.keys()].filter((key) => key.startsWith(options.prefix)).sort()
    const start = options.after ? keys.findIndex((key) => key > options.after!) : 0
    const offset = start < 0 ? keys.length : start
    const selected = keys.slice(offset, offset + (options.limit ?? 100))
    return {
      entries: selected.map((key) => ({ key, value: this.values.get(key)! })),
      next: offset + selected.length < keys.length ? selected.at(-1) : undefined,
    }
  }
}

class FakeSessions implements MissionSessionAdapter {
  readonly sessions = new Map<string, NativeMissionSession>()
  readonly prompts: Array<Parameters<MissionSessionAdapter["prompt"]>[0]> = []
  readonly synthetics: Array<Parameters<MissionSessionAdapter["synthetic"]>[0]> = []
  failNextSynthetic = false
  failSyntheticCount = 0

  async get({ sessionID }: { sessionID: string }) {
    const session = this.sessions.get(sessionID)
    if (!session) throw new Error("not found")
    return session
  }

  async create(input: Parameters<MissionSessionAdapter["create"]>[0]) {
    const existing = this.sessions.get(input.id)
    if (existing) throw new Error("already exists")
    const session: NativeMissionSession = {
      id: input.id,
      projectID: "project-1",
      title: input.title,
      agent: input.agent,
      model: input.model,
      location: input.location,
    }
    this.sessions.set(session.id, session)
    return session
  }

  async prompt(input: Parameters<MissionSessionAdapter["prompt"]>[0]) {
    this.prompts.push(input)
  }

  async synthetic(input: Parameters<MissionSessionAdapter["synthetic"]>[0]) {
    this.synthetics.push(input)
    if (this.failNextSynthetic || this.failSyntheticCount > 0) {
      this.failNextSynthetic = false
      this.failSyntheticCount = Math.max(0, this.failSyntheticCount - 1)
      throw new Error("synthetic admission unavailable")
    }
  }
}

function harness() {
  const storage = new MemoryStorage()
  const sessions = new FakeSessions()
  sessions.sessions.set("ses_coordinator", {
    id: "ses_coordinator",
    projectID: "project-1",
    title: "Coordinator",
    location: { directory: "/repo" },
  })
  let now = 1_000
  const changed: Array<{ missionID: string; revision: number }> = []
  const create = (transport?: MissionInputTransport) => new MissionControl({
    project: { id: "project-1", canonical: "/repo", location: { directory: "/repo" } },
    storage,
    sessions,
    transport,
    now: () => now++,
    changed: async (missionID, revision) => { changed.push({ missionID, revision }) },
  })
  return { storage, sessions, changed, create }
}

test("mission create is idempotent, creates only a native root, and does not prompt", async () => {
  const { create, sessions, storage } = harness()
  const control = create()
  const input = { requestID: "ui-create-1", objective: "Investigate", notes: "Start broad", template: "wayfinder" as const }
  const first = await control.create(input)
  const replay = await create().create(input)
  assert.equal(first.mission.id, replay.mission.id)
  assert.equal(first.mission.coordinatorSessionId, replay.mission.coordinatorSessionId)
  assert.equal(sessions.sessions.size, 2)
  assert.equal(sessions.prompts.length, 0)
  assert.equal(storage.values.size, 1)
  await assert.rejects(create().create({ ...input, objective: "Changed request" }), /different mission/)
})

test("mission creation rejects foreign/child coordinators and active membership", async () => {
  const { create, sessions } = harness()
  const control = create()
  sessions.sessions.set("ses_foreign", { ...sessions.sessions.get("ses_coordinator")!, id: "ses_foreign", projectID: "foreign" })
  sessions.sessions.set("ses_child", { ...sessions.sessions.get("ses_coordinator")!, id: "ses_child", parentID: "ses_coordinator" })
  await assert.rejects(control.create({ requestID: "foreign-create", objective: "No", template: "custom", coordinatorSessionID: "ses_foreign" }), /another project/)
  await assert.rejects(control.create({ requestID: "child-create", objective: "No", template: "custom", coordinatorSessionID: "ses_child" }), /root sessions only/)
  await control.create({ requestID: "first-active", objective: "Yes", template: "custom", coordinatorSessionID: "ses_coordinator" })
  await assert.rejects(create().create({ requestID: "second-active", objective: "No", template: "custom", coordinatorSessionID: "ses_coordinator" }), /already belongs/)
})

test("mission update uses CAS and request replay; deletion tombstones only the map", async () => {
  const { create, sessions, storage } = harness()
  const control = create()
  const created = await control.create({ requestID: "create-cas", objective: "Initial", notes: "Keep", template: "custom", coordinatorSessionID: "ses_coordinator" })
  const updated = await control.update({ missionID: created.mission.id, requestID: "update-cas", objective: "Revised", expectedRevision: created.mission.revision })
  assert.equal(updated.mission.objective, "Revised")
  assert.equal(updated.mission.notes, "Keep")
  assert.deepEqual(await create().update({ missionID: created.mission.id, requestID: "update-cas", objective: "Revised", expectedRevision: created.mission.revision }), updated)
  await assert.rejects(create().update({ missionID: created.mission.id, requestID: "stale", objective: "Stale", expectedRevision: created.mission.revision }), /changed/)
  const cleared = await control.update({ missionID: created.mission.id, requestID: "clear-notes", objective: "Revised", notes: "", expectedRevision: updated.mission.revision })
  assert.equal(cleared.mission.notes, "")
  await assert.rejects(create().update({ missionID: created.mission.id, requestID: "clear-notes", objective: "Revised", expectedRevision: updated.mission.revision }), /different edit/)
  await control.delete({ missionID: created.mission.id, requestID: "delete-cas", expectedRevision: cleared.mission.revision })
  await create().delete({ missionID: created.mission.id, requestID: "delete-cas", expectedRevision: cleared.mission.revision })
  assert.deepEqual((await create().snapshot()).missions, [])
  assert.ok(sessions.sessions.has("ses_coordinator"), "deleting a mission must not delete its native conversation")
  assert.equal(storage.values.size, 4, "created, both updates and deleted events remain in the journal")
  await assert.rejects(create().update({ missionID: created.mission.id, requestID: "late", objective: "Late", expectedRevision: cleared.mission.revision }), /Mission not found/)
})

test("deleted mission rejects late task reports without deleting actor sessions", async () => {
  const { create, sessions } = harness()
  const control = create()
  await control.inspect("ses_coordinator", { start: { objective: "Keep conversation", template: "custom" } }, "start-for-delete")
  const task = { taskKey: "late-report", title: "Late", brief: "Work", role: "research", blockedBy: [], delivery: "queue" as const }
  const dispatched = await control.delegate("ses_coordinator", task)
  const actorID = dispatched.mission.tasks[0]!.actorSessionId!
  const revision = dispatched.mission.revision
  await control.delete({ missionID: dispatched.mission.id, requestID: "delete-with-actor", expectedRevision: revision })
  await assert.rejects(create().report(actorID, { missionID: dispatched.mission.id, taskKey: task.taskKey, outcome: "completed", summary: "Late result", evidence: [], next: [], final: false }), /No mission is associated|Mission is not visible/)
  assert.ok(sessions.sessions.has(actorID))
  assert.equal((await create().snapshot()).missions.length, 0)
})

test("persists native execution through a failed admission and restart without switching an existing actor", async () => {
  const { create, sessions } = harness()
  const control = create()
  await control.inspect("ses_coordinator", { start: { objective: "Review", template: "custom" } }, "start")
  const input = {
    taskKey: "native-review", title: "Review", brief: "Inspect", role: "reviewer", blockedBy: [], delivery: "queue" as const,
    execution: { agent: "review-all", model: { providerID: "fixture", id: "reasoner", variant: "high" } },
  }
  const prompt = sessions.prompt.bind(sessions)
  sessions.prompt = async () => { throw new Error("admission unavailable") }
  await assert.rejects(control.delegate("ses_coordinator", input), /admission unavailable/)
  const snapshot = await create().snapshot()
  assert.deepEqual(snapshot.missions[0].tasks[0].execution, input.execution)
  const actorID = snapshot.missions[0].tasks[0].actorSessionId!
  assert.deepEqual(sessions.sessions.get(actorID)?.model, input.execution.model)
  sessions.prompt = prompt
  await assert.rejects(create().delegate("ses_coordinator", { ...input, execution: { agent: "other" } }), /different contract/)
  sessions.sessions.get(actorID)!.agent = "other"
  await assert.rejects(create().delegate("ses_coordinator", input), /changed since dispatch/)
  assert.equal(sessions.prompts.length, 0)
  sessions.sessions.get(actorID)!.agent = "review-all"
  const retried = await create().delegate("ses_coordinator", input)
  assert.equal(retried.disposition, "dispatched")
  assert.equal(sessions.sessions.size, 2)
  assert.equal(sessions.prompts.length, 1)
  await assert.rejects(control.delegate("ses_coordinator", {
    ...input, taskKey: "wrong-target", targetSessionID: actorID, execution: { agent: "other" },
  }), /differs from the task contract/)
})

test("rejects a twenty-first mission without hiding an active mission", async () => {
  const { create, sessions, storage } = harness()
  const control = create()
  for (let index = 0; index <= MISSION_MAX_MISSIONS; index++) {
    const id = `ses_coordinator_${index}`
    sessions.sessions.set(id, { ...sessions.sessions.get("ses_coordinator")!, id })
    const start = () => control.inspect(id, { start: { objective: `Mission ${index}`, template: "custom" } }, `start-${index}`)
    if (index < MISSION_MAX_MISSIONS) await start()
    else await assert.rejects(start, (error: unknown) => error instanceof MissionControlError && error.code === "mission-limit")
  }
  assert.equal(storage.values.size, MISSION_MAX_MISSIONS)
  assert.equal((await create().snapshot()).discardedEvents, 0)
  const replay = await control.inspect("ses_coordinator_0", { start: { objective: "Mission 0", template: "custom" } }, "start-0")
  assert.ok(replay.mission)
})

test("rejects new explicit actors at capacity but permits reuse and retry", async () => {
  const { create, sessions } = harness()
  const control = create()
  await control.inspect("ses_coordinator", { start: { objective: "Bound actors", template: "custom" } }, "start")
  const assignment = (index: number, targetSessionID: string) => ({
    taskKey: `task-${index}`, title: `Task ${index}`, brief: "A bounded assignment", role: "specialist",
    blockedBy: [], delivery: "queue" as const, targetSessionID,
  })
  for (let index = 0; index < MISSION_MAX_ACTORS; index++) {
    const id = `ses_actor_${index}`
    sessions.sessions.set(id, { ...sessions.sessions.get("ses_coordinator")!, id })
    if (index < MISSION_MAX_ACTORS - 1) await control.delegate("ses_coordinator", assignment(index, id))
    else await assert.rejects(control.delegate("ses_coordinator", assignment(index, id)),
      (error: unknown) => error instanceof MissionControlError && error.code === "actor-limit")
  }
  const before = (await create().snapshot()).missions[0]!
  assert.equal(before.actors.length, MISSION_MAX_ACTORS)
  assert.equal(before.tasks.at(-1)?.status, "ready")
  assert.equal((await create().snapshot()).discardedEvents, 0)
  const retried = await control.delegate("ses_coordinator", assignment(MISSION_MAX_ACTORS - 1, "ses_actor_0"))
  assert.equal(retried.disposition, "dispatched")
  assert.equal(retried.mission.actors.length, MISSION_MAX_ACTORS)
})

test("delegates between root sessions, queues reports, and restores the durable map", async () => {
  const { create, sessions } = harness()
  const control = create()
  const started = await control.inspect("ses_coordinator", {
    start: { objective: "Fix the intermittent save bug", template: "pocock-fix-bug" },
  }, "call-start")
  assert.equal(started.actor?.kind, "coordinator")
  assert.equal(started.mission?.template, "pocock-fix-bug")

  const delegated = await control.delegate("ses_coordinator", {
    taskKey: "diagnose",
    title: "Confirm the cause",
    brief: "Build a red feedback loop and test ranked hypotheses.",
    role: "diagnostician",
    blockedBy: [],
    delivery: "queue",
  })
  assert.equal(delegated.disposition, "dispatched")
  assert.equal(delegated.mission.tasks[0]?.status, "queued")
  const actor = delegated.mission.actors.find((candidate) => candidate.kind === "specialist")!
  assert.equal(actor.managed, true)
  assert.equal(Object.prototype.hasOwnProperty.call(actor.location, "workspaceID"), false)
  assert.equal(sessions.prompts[0]?.delivery, "queue")
  assert.equal(sessions.prompts[0]?.resume, true)
  assert.match(sessions.prompts[0]?.text ?? "", /mission\.report/)

  const reported = await control.report(actor.sessionId, {
    taskKey: "diagnose",
    outcome: "completed",
    summary: "The cache key omits the workspace identity.",
    evidence: ["Focused test fails before the fix."],
    next: ["Add workspace identity to the cache key."],
    artifact: {
      kind: "diagnosis",
      feedbackLoop: { command: "npm test -- cache", redOutput: "expected workspace-a, got workspace-b" },
      minimizedRepro: "Two workspaces use the same relative cache key.",
      confirmedHypothesis: "The cache key omits workspace identity.",
      evidence: "Adding workspace identity separates both entries.",
      rejectedHypotheses: ["stale filesystem metadata"],
    },
    final: false,
  })
  assert.equal(reported.mission.tasks[0]?.status, "completed")
  assert.equal(sessions.synthetics[0]?.sessionID, "ses_coordinator")
  assert.equal(sessions.synthetics[0]?.delivery, "queue")
  assert.equal(sessions.synthetics[0]?.resume, true)

  const restored = await create().snapshot()
  assert.equal(restored.missions[0]?.reports[0]?.summary, "The cache key omits the workspace identity.")
  assert.equal(restored.missions[0]?.actors.length, 2)
})

test("derives blocked frontier tasks without automatically interpreting a workflow", async () => {
  const { create } = harness()
  const control = create()
  await control.inspect("ses_coordinator", { start: { objective: "Map a migration", template: "wayfinder" } }, "call-map")
  const first = await control.delegate("ses_coordinator", {
    taskKey: "choose-store", title: "Choose the durable store", brief: "Resolve one storage decision.",
    role: "decision", blockedBy: [], delivery: "queue",
  })
  const dependent = await control.delegate("ses_coordinator", {
    taskKey: "choose-schema", title: "Choose the schema", brief: "Use the storage decision.",
    role: "decision", blockedBy: ["choose-store"], delivery: "queue",
  })
  assert.equal(dependent.disposition, "blocked")
  assert.deepEqual(dependent.mission.frontier, [])
  assert.deepEqual(dependent.mission.claims, ["choose-store"])

  const actor = first.mission.actors.find((candidate) => candidate.kind === "specialist")!
  await control.report(actor.sessionId, {
    taskKey: "choose-store", outcome: "completed", summary: "Use native plugin storage.", evidence: [], next: [], final: false,
  })
  const inspection = await control.inspect("ses_coordinator", {}, "call-inspect")
  assert.deepEqual(inspection.mission?.frontier, ["choose-schema"])

  const dispatched = await control.delegate("ses_coordinator", {
    taskKey: "choose-schema", title: "Choose the schema", brief: "Use the storage decision.",
    role: "decision", blockedBy: ["choose-store"], delivery: "queue",
  })
  assert.equal(dispatched.disposition, "dispatched")
})

test("recovers only pending report notifications after transient failure and restart", async () => {
  const { create, sessions } = harness()
  const control = create()
  await control.inspect("ses_coordinator", { start: { objective: "Recover report wakeups", template: "custom" } }, "notification-outbox")
  const dispatched = await control.delegate("ses_coordinator", {
    taskKey: "fix", title: "Fix", brief: "Make the change.", role: "specialist", blockedBy: [], delivery: "queue",
  })
  const actor = actorFor(dispatched.mission, "specialist")
  sessions.failNextSynthetic = true
  const saved = await control.report(actor, {
    taskKey: "fix", outcome: "completed", summary: "Fixed.", evidence: [], next: [], final: false,
  })
  assert.equal(saved.disposition, "reported")
  assert.equal(saved.mission.reports[0]?.notificationStatus, "pending")
  const pending = (await control.snapshot()).missions[0]!
  assert.equal(pending.reports[0]?.notificationStatus, "pending")
  assert.equal(pending.tasks[0]?.status, "completed")
  assert.deepEqual(pending.frontier, [])
  const originalMessageID = sessions.synthetics[0]?.id

  const restarted = create()
  assert.equal((await restarted.retryPendingNotifications()).attempted, 1)
  const admitted = (await restarted.snapshot()).missions[0]!
  assert.equal(admitted.reports[0]?.notificationStatus, "admitted")
  assert.equal(sessions.synthetics[1]?.id, originalMessageID)
  assert.equal((await restarted.retryPendingNotifications()).attempted, 0)
  assert.equal(sessions.synthetics.length, 2)
  assert.equal(sessions.prompts.length, 1, "notification recovery must not dispatch or prompt tasks")
})

test("durable report writes reject actors moved from their exact admitted worktree", async () => {
  const f = harness()
  const control = f.create()
  await control.inspect("ses_coordinator", { start: { objective: "Validate report ownership", template: "custom" } }, "report-location")
  const dispatched = await control.delegate("ses_coordinator", { taskKey: "fix", title: "Fix", brief: "Existing work", role: "specialist", blockedBy: [], delivery: "queue" })
  const actor = actorFor(dispatched.mission, "specialist")
  f.sessions.sessions.set(actor, { ...f.sessions.sessions.get(actor)!, location: { directory: "/repo-other-worktree" } })
  await assert.rejects(control.report(actor, { taskKey: "fix", outcome: "completed", summary: "Moved", evidence: [], next: [], final: false }), /admitted location/)
  assert.equal((await control.snapshot()).missions[0].reports.length, 0)
  assert.equal(f.sessions.synthetics.length, 0)
})

test("failure to save a report remains an error and never notifies the coordinator", async () => {
  const f = harness()
  const control = f.create()
  await control.inspect("ses_coordinator", { start: { objective: "Do not fake persistence", template: "custom" } }, "report-save-failure")
  const dispatched = await control.delegate("ses_coordinator", { taskKey: "fix", title: "Fix", brief: "Existing work", role: "specialist", blockedBy: [], delivery: "queue" })
  f.storage.failNextEventType = "task.reported"
  await assert.rejects(control.report(actorFor(dispatched.mission, "specialist"), { taskKey: "fix", outcome: "completed", summary: "Not saved", evidence: [], next: [], final: false }), /failed to persist/)
  assert.equal((await control.snapshot()).missions[0].reports.length, 0)
  assert.equal(f.sessions.synthetics.length, 0)
})

test("explicit recovery requires secure transport and preserves one identity without changing the journal", async () => {
  const f = harness()
  const control = f.create()
  const initial = await control.inspect("ses_coordinator", { start: { objective: "Recover existing evidence", template: "custom" } }, "recover")
  const input = { missionID: initial.mission!.id, expectedRevision: initial.mission!.revision, target: "coordinator" as const }
  await assert.rejects(control.recover(input), /admission unavailable/)
  assert.equal(f.sessions.synthetics.length, 0, "no insecure native direct fallback")
  const admitted: Array<Parameters<MissionSessionAdapter["synthetic"]>[0]> = []
  const safe = f.create({
    prompt: async () => { throw new Error("Recovery cannot prompt an assignment") },
    synthetic: async (coordinatorID, notification) => {
      assert.equal(coordinatorID, "ses_coordinator")
      admitted.push(notification)
    },
  })
  const events = f.storage.values.size
  await safe.recover(input)
  await f.create({ prompt: async () => {}, synthetic: async (_coordinatorID, notification) => { admitted.push(notification) } }).recover(input)
  assert.equal(admitted.length, 2)
  assert.equal(admitted[0].id, admitted[1].id, "native idempotence identity survives control restart")
  assert.equal(f.storage.values.size, events)
  assert.deepEqual((await safe.snapshot()).missions[0], initial.mission)
  f.sessions.sessions.get("ses_coordinator")!.location = { directory: "/moved" }
  await assert.rejects(safe.recover(input), /actor moved/)
  assert.equal(admitted.length, 2)
})

test("notification recovery honors lifecycle fences and skips tombstoned missions", async () => {
  const { create, sessions } = harness()
  const control = create()
  await control.inspect("ses_coordinator", { start: { objective: "Fence notification recovery", template: "custom" } }, "notification-fences")
  const dispatched = await control.delegate("ses_coordinator", {
    taskKey: "task", title: "Task", brief: "Work.", role: "specialist", blockedBy: [], delivery: "queue",
  })
  sessions.failNextSynthetic = true
  await control.report(actorFor(dispatched.mission, "specialist"), {
    taskKey: "task", outcome: "completed", summary: "Done.", evidence: [], next: [], final: false,
  })
  const before = sessions.synthetics.length
  assert.equal((await control.retryPendingNotifications(() => false)).attempted, 0)
  assert.equal(sessions.synthetics.length, before)
  const mission = (await control.snapshot()).missions[0]!
  await control.delete({ missionID: mission.id, expectedRevision: mission.revision, requestID: "tombstone-before-notify" })
  assert.equal((await create().retryPendingNotifications()).attempted, 0)
  assert.equal(sessions.synthetics.length, before)
})

test("reuses the deterministic notification ID when admission succeeded but its ack was lost", async () => {
  const { create, sessions, storage } = harness()
  const control = create()
  await control.inspect("ses_coordinator", { start: { objective: "Recover an unacknowledged admission", template: "custom" } }, "notification-ack-loss")
  const dispatched = await control.delegate("ses_coordinator", {
    taskKey: "task", title: "Task", brief: "Work.", role: "specialist", blockedBy: [], delivery: "queue",
  })
  const actor = actorFor(dispatched.mission, "specialist")
  storage.failNextEventType = "report.notified"
  const saved = await control.report(actor, {
    taskKey: "task", outcome: "completed", summary: "Done.", evidence: [], next: [], final: false,
  })
  assert.equal(saved.disposition, "reported")
  assert.equal(saved.mission.reports[0]?.notificationStatus, "pending")
  const admittedID = sessions.synthetics[0]?.id
  assert.equal((await control.snapshot()).missions[0]?.reports[0]?.notificationStatus, "pending")
  assert.equal((await create().retryPendingNotifications()).attempted, 1)
  assert.equal(sessions.synthetics[1]?.id, admittedID)
  assert.equal((await control.snapshot()).missions[0]?.reports[0]?.notificationStatus, "admitted")
})

test("rotates bounded notification batches so persistent failures cannot starve later reports", async () => {
  const { create, sessions } = harness()
  const control = create()
  await control.inspect("ses_coordinator", { start: { objective: "Drain notifications fairly", template: "custom" } }, "notification-fairness")
  sessions.sessions.set("ses_shared_actor", {
    id: "ses_shared_actor", projectID: "project-1", title: "Shared actor", location: { directory: "/repo" },
  })
  const reports = 12
  for (let index = 0; index < reports; index += 1) {
    const taskKey = `report-${String(index).padStart(2, "0")}`
    await control.delegate("ses_coordinator", {
      taskKey, title: taskKey, brief: "Complete this task.", role: "specialist", blockedBy: [],
      targetSessionID: "ses_shared_actor", delivery: "queue",
    })
    sessions.failNextSynthetic = true
    await control.report("ses_shared_actor", {
      taskKey, outcome: "completed", summary: "Done.", evidence: [], next: [], final: false,
    })
  }

  sessions.failSyntheticCount = 10
  const first = await control.retryPendingNotifications()
  assert.equal(first.attempted, 10)
  assert.equal(first.failed, 10)
  assert.ok(first.cursor)
  const second = await control.retryPendingNotifications(() => true, first.cursor)
  assert.equal(second.attempted, 10)
  assert.equal(second.failed, 0)
  assert.ok((await control.snapshot()).missions[0]?.reports.filter(report => report.notificationStatus === "admitted").length >= 10)
  const third = await control.retryPendingNotifications(() => true, second.cursor)
  assert.equal(third.attempted, 2)
  assert.equal((await control.snapshot()).missions[0]?.reports.filter(report => report.notificationStatus === "pending").length, 0)
})

test("assigns distinct stable actors to deferred tasks with identical role and title", async () => {
  const { create, sessions } = harness()
  const control = create()
  await control.inspect("ses_coordinator", { start: { objective: "Dispatch both deferred tasks", template: "custom" } }, "deferred-actor-identity")
  const base = await control.delegate("ses_coordinator", {
    taskKey: "base", title: "Shared title", brief: "Unblock both tasks.", role: "specialist", blockedBy: [], delivery: "queue",
  })
  const deferredInput = (taskKey: string) => ({
    taskKey, title: "Same deferred title", brief: "Same deferred contract.", role: "specialist", blockedBy: ["base"], delivery: "queue" as const,
  })
  const firstBlocked = await control.delegate("ses_coordinator", deferredInput("deferred-one"))
  const secondBlocked = await control.delegate("ses_coordinator", deferredInput("deferred-two"))
  assert.equal(firstBlocked.disposition, "blocked")
  assert.equal(secondBlocked.disposition, "blocked")
  await control.report(actorFor(base.mission, "specialist"), {
    taskKey: "base", outcome: "completed", summary: "Base complete", evidence: [], next: [], final: false,
  })
  const first = await control.delegate("ses_coordinator", deferredInput("deferred-one"))
  const second = await control.delegate("ses_coordinator", deferredInput("deferred-two"))
  const firstActor = first.mission.tasks.find(task => task.key === "deferred-one")!.actorSessionId!
  const secondActor = second.mission.tasks.find(task => task.key === "deferred-two")!.actorSessionId!
  assert.notEqual(firstActor, secondActor)
  assert.notEqual(first.mission.tasks.find(task => task.key === "deferred-one")!.id,
    first.mission.tasks.find(task => task.key === "deferred-two")!.id)
  assert(sessions.sessions.has(firstActor))
  assert(sessions.sessions.has(secondActor))
  const retry = await control.delegate("ses_coordinator", deferredInput("deferred-one"))
  assert.equal(retry.mission.tasks.find(task => task.key === "deferred-one")?.actorSessionId, firstActor)
})

test("normalizes duplicate dependency keys before persistence and replay comparison", async () => {
  const { create, storage } = harness()
  const control = create()
  await control.inspect("ses_coordinator", { start: { objective: "Retry duplicate dependencies", template: "custom" } }, "duplicate-dependency-start")
  await control.delegate("ses_coordinator", {
    taskKey: "base", title: "Base", brief: "Unblock the retry.", role: "specialist", blockedBy: [], delivery: "queue",
  })
  const duplicated = {
    taskKey: "child", title: "Child", brief: "Depends on base.", role: "specialist", blockedBy: ["base", "base"], delivery: "queue" as const,
  }
  const first = await control.delegate("ses_coordinator", duplicated)
  assert.equal(first.disposition, "blocked")
  assert.deepEqual(first.mission.tasks.find(task => task.key === "child")?.blockedBy, ["base"])
  const retry = await control.delegate("ses_coordinator", duplicated)
  assert.equal(retry.disposition, "blocked")
  assert.deepEqual(retry.mission.tasks.find(task => task.key === "child")?.blockedBy, ["base"])
  const taskEvent = [...storage.values.values()].find((event: any) => event?.type === "task.created" && event.task?.key === "child") as any
  assert.deepEqual(taskEvent.task.blockedBy, ["base"])
  const reviseInput = {
    missionID: first.mission.id, expectedRevision: first.mission.revision, requestID: "duplicate-dependency-revision",
    reason: "Keep the same dependency", dependencyUpdates: [{ taskKey: "child", blockedBy: ["base", "base"] }],
    retireTasks: [], addTasks: [],
  }
  const revised = await control.revise("ses_coordinator", reviseInput)
  const revisedEvent = [...storage.values.entries()].find(([, value]) => (value as any)?.type === "mission.revised"
    && (value as any)?.requestID === reviseInput.requestID)
  assert.ok(revisedEvent)
  const legacy = structuredClone(revisedEvent![1]) as any
  legacy.dependencyUpdates[0].blockedBy = ["base", "base"]
  storage.values.set(revisedEvent![0], legacy)
  const reviseReplay = await create().revise("ses_coordinator", reviseInput)
  assert.equal(reviseReplay.mission.revision, revised.mission.revision)
  assert.deepEqual(reviseReplay.mission.tasks.find(task => task.key === "child")?.blockedBy, ["base"])
  const baseActorSessionID = revised.mission.tasks.find(task => task.key === "base")?.actorSessionId!
  await control.report(baseActorSessionID, {
    taskKey: "base", outcome: "completed", summary: "Base complete.", evidence: [], next: [], final: false,
  })
  const afterUnblock = await control.delegate("ses_coordinator", duplicated)
  assert.equal(afterUnblock.disposition, "dispatched")
  assert.equal(afterUnblock.mission.tasks.find(task => task.key === "child")?.status, "queued")
})

test("revises tasks atomically, preserves lineage, and records late reports without completing withdrawn work", async () => {
  const { create, sessions } = harness()
  const control = create()
  await control.inspect("ses_coordinator", { start: { objective: "Change the plan", template: "wayfinder" } }, "revise-start")
  const first = await control.delegate("ses_coordinator", {
    taskKey: "old-store", title: "Choose a store", brief: "Pick storage.", role: "decision", blockedBy: [], delivery: "queue",
  })
  await control.delegate("ses_coordinator", {
    taskKey: "dependent", title: "Pick a schema", brief: "Based on the store.", role: "decision", blockedBy: ["old-store"], delivery: "queue",
  })
  const beforeRevision = (await control.snapshot()).missions[0]!
  const oldActor = beforeRevision.tasks.find((task) => task.key === "old-store")!.actorSessionId!
  const revise = {
    missionID: beforeRevision.id,
    expectedRevision: beforeRevision.revision,
    requestID: "revise-store-1",
    reason: "New compatibility requirement",
    retireTasks: [{ taskKey: "old-store", replacementTaskKey: "new-store" }],
    addTasks: [{
      taskKey: "new-store", title: "Choose compatible storage", brief: "Select storage for the added platform.",
      role: "decision", blockedBy: [], replacesTaskKey: "old-store",
    }],
    dependencyUpdates: [{ taskKey: "dependent", blockedBy: ["new-store"] }],
  }
  const changed = await control.revise("ses_coordinator", revise)
  const replay = await create().revise("ses_coordinator", revise)
  assert.equal(replay.mission.revision, changed.mission.revision)
  await assert.rejects(control.revise("ses_coordinator", {
    ...revise, requestID: "revise-store-stale", reason: "Stale editor submit",
  }), (error: unknown) => error instanceof MissionControlError && error.code === "revision-conflict")
  assert.equal(changed.mission.tasks.find((task) => task.key === "old-store")?.status, "withdrawn")
  assert.equal(changed.mission.tasks.find((task) => task.key === "old-store")?.replacedByTaskKey, "new-store")
  assert.equal(changed.mission.tasks.find((task) => task.key === "new-store")?.replacesTaskKey, "old-store")
  assert.deepEqual(changed.mission.tasks.find((task) => task.key === "dependent")?.blockedBy, ["new-store"])
  assert.equal(changed.mission.history[0]?.reason, "New compatibility requirement")
  assert.deepEqual(changed.mission.history[0]?.dependencyUpdates[0], {
    taskKey: "dependent", before: ["old-store"], after: ["new-store"],
  })
  assert.equal(changed.mission.tasks.find((task) => task.key === "old-store")?.outstandingExecution, true)
  await assert.rejects(control.report("ses_coordinator", {
    final: true, outcome: "completed", summary: "Done", evidence: [], next: [],
  }), /terminal report/)

  const late = await control.report(oldActor, {
    taskKey: "old-store", outcome: "completed", summary: "The retired choice was finished anyway.", evidence: [], next: [], final: false,
  })
  assert.equal(late.mission.tasks.find((task) => task.key === "old-store")?.status, "withdrawn")
  assert.equal(late.mission.tasks.find((task) => task.key === "old-store")?.lateReports?.[0]?.late, true)
  assert.equal(late.mission.tasks.find((task) => task.key === "old-store")?.outstandingExecution, false)
  assert.equal(late.mission.frontier.includes("dependent"), false)
  const lateReplay = await control.report(oldActor, {
    taskKey: "old-store", outcome: "completed", summary: "A second completion must not replace it.", evidence: [], next: [], final: false,
  })
  assert.equal(lateReplay.disposition, "existing")
  assert.equal(lateReplay.mission.tasks.find((task) => task.key === "old-store")?.lateReports?.length, 1)
  assert.equal(sessions.sessions.has(oldActor), true)
  assert.equal(sessions.prompts.length, 1)
})

test("projects human edits and coordinator revisions once in an attributed ordered history", async () => {
  const { create } = harness()
  const control = create()
  const started = await control.inspect("ses_coordinator", {
    start: { objective: "Initial objective", notes: "Initial notes", template: "custom" },
  }, "history-attribution-start")
  const update = {
    missionID: started.mission!.id, requestID: "human-edit-1", expectedRevision: started.mission!.revision,
    objective: "Human-edited objective", notes: "Human-edited notes",
  }
  const edited = await control.update(update)
  const replay = await create().update(update)
  assert.equal(replay.mission.revision, edited.mission.revision)
  assert.equal(replay.mission.history.length, 1, "An idempotent replay does not duplicate history")
  assert.deepEqual(replay.mission.history[0], {
    revision: update.expectedRevision + 1,
    source: "user",
    objective: { before: "Initial objective", after: "Human-edited objective" },
    notes: { before: "Initial notes", after: "Human-edited notes" },
    addedTaskKeys: [], retiredTasks: [], dependencyUpdates: [],
    createdAt: replay.mission.history[0]!.createdAt,
  })
  assert.equal(replay.mission.history[0]?.actorSessionId, undefined)
  assert.equal(replay.mission.history[0]?.reason, undefined)

  const revised = await control.revise("ses_coordinator", {
    missionID: edited.mission.id, expectedRevision: edited.mission.revision,
    requestID: "coordinator-revise-after-edit", reason: "Plan needs one more pass", objective: "Coordinator-revised objective",
    retireTasks: [], addTasks: [], dependencyUpdates: [],
  })
  assert.equal(revised.mission.history.length, 2)
  assert.equal(revised.mission.history[0]?.source, "user")
  assert.equal(revised.mission.history[1]?.source, "coordinator")
  assert.equal(revised.mission.history[1]?.actorSessionId, "ses_coordinator")
  assert.equal(revised.mission.history[1]?.reason, "Plan needs one more pass")
  assert(revised.mission.history[0]!.revision < revised.mission.history[1]!.revision)
})

test("requires dependents of withdrawn tasks to be explicitly rewritten", async () => {
  const { create } = harness()
  const control = create()
  await control.inspect("ses_coordinator", { start: { objective: "Revise safely", template: "custom" } }, "revise-dependencies")
  const first = await control.delegate("ses_coordinator", {
    taskKey: "base", title: "Base", brief: "Base work.", role: "specialist", blockedBy: [], delivery: "queue",
  })
  await control.delegate("ses_coordinator", {
    taskKey: "followup", title: "Follow up", brief: "Dependent work.", role: "specialist", blockedBy: ["base"], delivery: "queue",
  })
  const beforeRevision = (await control.snapshot()).missions[0]!
  await assert.rejects(control.revise("ses_coordinator", {
    missionID: beforeRevision.id, expectedRevision: beforeRevision.revision, requestID: "withdraw-base",
    reason: "No longer needed", retireTasks: [{ taskKey: "base" }], addTasks: [], dependencyUpdates: [],
  }), (error: unknown) => error instanceof MissionControlError && error.code === "dependency-update-required")
})

test("keeps task and admission identities idempotent across retries", async () => {
  const { create, sessions } = harness()
  const control = create()
  await control.inspect("ses_coordinator", { start: { objective: "Review a diff", template: "custom" } }, "call-start")
  const input = {
    taskKey: "review", title: "Review", brief: "Review the current diff.", role: "specialist",
    blockedBy: [], delivery: "queue" as const,
  }
  const first = await control.delegate("ses_coordinator", input)
  const second = await control.delegate("ses_coordinator", input)
  assert.equal(second.disposition, "existing")
  assert.equal(first.mission.tasks[0]?.id, second.mission.tasks[0]?.id)
  assert.equal(sessions.prompts.length, 1)

  const actor = first.mission.actors.find((candidate) => candidate.kind === "specialist")!
  const report = {
    taskKey: "review", outcome: "completed" as const, summary: "Pass", evidence: [], next: [], final: false,
  }
  await control.report(actor.sessionId, report)
  await control.report(actor.sessionId, report)
  assert.equal(sessions.synthetics.length, 1, "an acknowledged notification is not resent on explicit report replay")
  assert.equal((await control.snapshot()).missions[0]?.reports.length, 1)
})

test("serializes project mutations so concurrent task contracts cannot overwrite journal history", async () => {
  const { create, sessions } = harness()
  const first = create()
  const second = create()
  await first.inspect("ses_coordinator", { start: { objective: "Review safely", template: "custom" } }, "concurrent-task")

  const results = await Promise.allSettled([
    first.delegate("ses_coordinator", {
      taskKey: "review", title: "Review A", brief: "Review contract A.", role: "specialist",
      blockedBy: [], delivery: "queue",
    }),
    second.delegate("ses_coordinator", {
      taskKey: "review", title: "Review B", brief: "Review contract B.", role: "specialist",
      blockedBy: [], delivery: "queue",
    }),
  ])

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
  assert.ok(rejected)
  assert.equal(rejected.reason instanceof MissionControlError && rejected.reason.code, "task-conflict")
  assert.equal((await first.snapshot()).missions[0]?.tasks.length, 1)
  assert.equal(sessions.prompts.length, 1)
})

test("admits only one concurrent active mission for a coordinator", async () => {
  const { create } = harness()
  const first = create()
  const second = create()
  const results = await Promise.allSettled([
    first.inspect("ses_coordinator", { start: { objective: "First", template: "custom" } }, "concurrent-first"),
    second.inspect("ses_coordinator", { start: { objective: "Second", template: "custom" } }, "concurrent-second"),
  ])

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
  assert.ok(rejected)
  assert.equal(rejected.reason instanceof MissionControlError && rejected.reason.code, "already-member")
  assert.equal((await first.snapshot()).missions.filter((mission) => mission.status === "active").length, 1)
})

test("rejects child, foreign, and non-coordinator topology changes", async () => {
  const { create, sessions } = harness()
  const control = create()
  sessions.sessions.set("ses_child", {
    id: "ses_child", parentID: "ses_coordinator", projectID: "project-1", location: { directory: "/repo" },
  })
  await assert.rejects(
    control.inspect("ses_child", { start: { objective: "No", template: "custom" } }, "child"),
    (error: unknown) => error instanceof MissionControlError && error.code === "child-session",
  )

  await control.inspect("ses_coordinator", { start: { objective: "Owned", template: "custom" } }, "owned")
  sessions.sessions.set("ses_foreign", { id: "ses_foreign", projectID: "project-2", location: { directory: "/other" } })
  await assert.rejects(
    control.delegate("ses_coordinator", {
      taskKey: "foreign", title: "Foreign", brief: "Do not admit", role: "specialist", blockedBy: [],
      targetSessionID: "ses_foreign", delivery: "queue",
    }),
    (error: unknown) => error instanceof MissionControlError && error.code === "foreign-session",
  )

  const delegated = await control.delegate("ses_coordinator", {
    taskKey: "owned", title: "Owned", brief: "Do work", role: "specialist", blockedBy: [], delivery: "queue",
  })
  const actor = delegated.mission.actors.find((candidate) => candidate.kind === "specialist")!
  await assert.rejects(
    control.delegate(actor.sessionId, {
      taskKey: "escape", title: "Escape", brief: "No", role: "specialist", blockedBy: [], delivery: "queue",
    }),
    (error: unknown) => error instanceof MissionControlError && error.code === "coordinator-only",
  )
})

test("finishes green only after every task reports complete", async () => {
  const { create } = harness()
  const control = create()
  await control.inspect("ses_coordinator", { start: { objective: "Ship safely", template: "custom" } }, "finish")
  const delegated = await control.delegate("ses_coordinator", {
    taskKey: "check", title: "Check", brief: "Validate", role: "specialist", blockedBy: [], delivery: "queue",
  })
  await assert.rejects(control.report("ses_coordinator", {
    outcome: "completed", summary: "Done", evidence: [], next: [], final: true,
  }), /Every mission task/)
  const actor = delegated.mission.actors.find((candidate) => candidate.kind === "specialist")!
  await control.report(actor.sessionId, {
    taskKey: "check", outcome: "completed", summary: "Green", evidence: ["tests pass"], next: [], final: false,
  })
  const finished = await control.report("ses_coordinator", {
    outcome: "completed", summary: "All gates are green", evidence: [], next: [], final: true,
  })
  assert.equal(finished.mission.status, "completed")
  assert.equal(finished.mission.summary, "All gates are green")
})

test("bounds and validates persisted journal records", async () => {
  assert.equal(parseMissionEvent({ version: 1, type: "mission.created" }), undefined)
  const storage = new MemoryStorage()
  storage.values.set(`${MISSION_JOURNAL_STORAGE_PREFIX}/bad/corrupt`, { bad: true })
  const journal = new MissionJournal(storage, "project-1", "/repo", () => 100)
  const snapshot = await journal.snapshot()
  assert.equal(snapshot.missions.length, 0)
})

test("rejects a new event before the durable journal can exceed its safety limit", async () => {
  const storage = new MemoryStorage()
  const journal = new MissionJournal(storage, "project-1", "/repo", () => 100)
  for (let index = 0; index < MISSION_MAX_EVENTS; index += 1) {
    storage.values.set(`${MISSION_JOURNAL_STORAGE_PREFIX}/${journal.projectToken}/seed/${index.toString().padStart(4, "0")}`, { seed: index })
  }

  await assert.rejects(journal.append({
    version: 1,
    id: "evt_capacity",
    type: "mission.created",
    missionID: "msn_capacity",
    projectID: "project-1",
    projectCanonical: "/repo",
    objective: "Do not overflow",
    template: "custom",
    coordinator: { sessionID: "ses_coordinator", title: "Coordinator", location: { directory: "/repo" } },
    createdAt: 100,
  }), /2000-event safety limit/)
  assert.equal(storage.values.size, MISSION_MAX_EVENTS)
})

test("runs the Pocock evidence gates dynamically while reusing the implementer for resolution", async () => {
  const { create } = harness()
  const control = create()
  await control.inspect("ses_coordinator", {
    start: { objective: "Fix save isolation without publishing", template: "pocock-fix-bug" },
  }, "pocock-full")

  const diagnosis = await control.delegate("ses_coordinator", {
    taskKey: "diagnose", title: "Diagnose save isolation", brief: "Confirm the cause.",
    role: "diagnostician", blockedBy: [], delivery: "queue",
  })
  const diagnostician = actorFor(diagnosis.mission, "diagnostician")
  await reportCompleted(control, diagnostician, "diagnose", pocockArtifact("diagnostician"))

  const implementation = await control.delegate("ses_coordinator", {
    taskKey: "implement", title: "Implement the regression fix", brief: "Use the confirmed diagnosis.",
    role: "implementer", blockedBy: ["diagnose"], delivery: "queue",
  })
  const implementer = actorFor(implementation.mission, "implementer")
  await reportCompleted(control, implementer, "implement", pocockArtifact("implementer"))

  const standards = await control.delegate("ses_coordinator", {
    taskKey: "review-standards", title: "Review repository standards", brief: "Review the fixed diff only.",
    role: "review-standards", blockedBy: ["implement"], delivery: "queue",
  })
  const specification = await control.delegate("ses_coordinator", {
    taskKey: "review-spec", title: "Review reported behavior", brief: "Review the fixed diff only.",
    role: "review-spec", blockedBy: ["implement"], delivery: "queue",
  })
  await reportCompleted(control, actorFor(standards.mission, "review-standards"), "review-standards", pocockArtifact("review-standards"))
  await reportCompleted(control, actorFor(specification.mission, "review-spec"), "review-spec", pocockArtifact("review-spec"))

  const resolution = await control.delegate("ses_coordinator", {
    taskKey: "resolve", title: "Resolve both reviews", brief: "Address all correct hard findings.",
    role: "resolver", blockedBy: ["review-standards", "review-spec"], targetSessionID: implementer, delivery: "queue",
  })
  assert.equal(actorFor(resolution.mission, "resolver"), implementer)
  await reportCompleted(control, implementer, "resolve", pocockArtifact("resolver"))

  const validation = await control.delegate("ses_coordinator", {
    taskKey: "validate", title: "Validate the complete fix", brief: "Run every configured gate read-only.",
    role: "validator", blockedBy: ["resolve"], delivery: "queue",
  })
  await reportCompleted(control, actorFor(validation.mission, "validator"), "validate", pocockArtifact("validator"))
  const finished = await control.report("ses_coordinator", {
    outcome: "completed", summary: "Diagnosis, fix, both reviews, resolution, and validation are green.",
    evidence: [], next: [], final: true,
  })
  assert.equal(finished.mission.status, "completed")
  assert.equal(finished.mission.tasks.length, 6)
  assert.equal(finished.mission.actors.length, 6)
})

test("routes Pocock resolver to the live replacement implementer through revise and delegate", async () => {
  const { create } = harness()
  const control = create()
  const executionMode = { kind: "independent" as const, reason: "existing-root" as const,
    explanation: "Qualify explicit independent root replacement and exact implementer reuse" }
  await control.inspect("ses_coordinator", {
    start: { objective: "Replace a completed fix and resolve its reviews", template: "pocock-fix-bug" },
  }, "pocock-replaced-implementer")
  const diagnosis = await control.delegate("ses_coordinator", {
    taskKey: "diagnose", title: "Diagnose", brief: "Confirm the cause.", role: "diagnostician", blockedBy: [], delivery: "queue",
  })
  const diagnostician = actorFor(diagnosis.mission, "diagnostician")
  await reportCompleted(control, diagnostician, "diagnose", pocockArtifact("diagnostician"))
  const oldFix = await control.delegate("ses_coordinator", {
    taskKey: "old-fix", title: "Implement the fix", brief: "First implementation.", role: "implementer", blockedBy: ["diagnose"], delivery: "queue",
  })
  const oldImplementer = oldFix.mission.tasks.find(task => task.key === "old-fix")!.actorSessionId!
  await reportCompleted(control, oldImplementer, "old-fix", pocockArtifact("implementer"))

  const beforeReplace = (await control.snapshot()).missions[0]!
  const replacement = await control.revise("ses_coordinator", {
    missionID: beforeReplace.id, expectedRevision: beforeReplace.revision, requestID: "replace-old-fix",
    reason: "The original fix does not cover the updated contract",
    retireTasks: [{ taskKey: "old-fix", replacementTaskKey: "new-fix" }],
    addTasks: [{ taskKey: "new-fix", title: "Implement the revised fix", brief: "Use the expanded contract.",
      role: "implementer", blockedBy: ["diagnose"], replacesTaskKey: "old-fix", executionMode }],
    dependencyUpdates: [],
  })
  const newFixDispatch = await control.delegate("ses_coordinator", {
    taskKey: "new-fix", title: "Implement the revised fix", brief: "Use the expanded contract.",
    role: "implementer", blockedBy: ["diagnose"], delivery: "queue", executionMode,
  })
  const newImplementer = newFixDispatch.mission.tasks.find(task => task.key === "new-fix")!.actorSessionId!
  assert.notEqual(newImplementer, oldImplementer)
  await reportCompleted(control, newImplementer, "new-fix", pocockArtifact("implementer"))

  const standards = await control.delegate("ses_coordinator", {
    taskKey: "standards", title: "Standards review", brief: "Review new fix.", role: "review-standards", blockedBy: ["new-fix"], delivery: "queue",
  })
  const specification = await control.delegate("ses_coordinator", {
    taskKey: "specification", title: "Spec review", brief: "Review new fix.", role: "review-spec", blockedBy: ["new-fix"], delivery: "queue",
  })
  await reportCompleted(control, actorFor(standards.mission, "review-standards"), "standards", pocockArtifact("review-standards"))
  await reportCompleted(control, actorFor(specification.mission, "review-spec"), "specification", pocockArtifact("review-spec"))

  const firstResolver = await control.delegate("ses_coordinator", {
    taskKey: "resolver-first", title: "Resolve reviews", brief: "Address the new reviews.", role: "resolver",
    blockedBy: ["standards", "specification"], targetSessionID: newImplementer, delivery: "queue",
  })
  await reportCompleted(control, newImplementer, "resolver-first", pocockArtifact("resolver"))
  const beforeResolverReplacement = (await control.snapshot()).missions[0]!
  const revisedResolver = await control.revise("ses_coordinator", {
    missionID: beforeResolverReplacement.id, expectedRevision: beforeResolverReplacement.revision,
    requestID: "replace-resolver", reason: "The review outcomes require one more resolution pass",
    retireTasks: [{ taskKey: "resolver-first", replacementTaskKey: "resolver-final" }],
    addTasks: [{ taskKey: "resolver-final", title: "Resolve updated reviews", brief: "Address all review findings.",
      role: "resolver", blockedBy: ["standards", "specification"], replacesTaskKey: "resolver-first", executionMode }],
    dependencyUpdates: [],
  })
  assert.equal(revisedResolver.mission.tasks.find(task => task.key === "resolver-first")?.status, "withdrawn")
  await assert.rejects(control.delegate("ses_coordinator", {
    taskKey: "resolver-final", title: "Resolve updated reviews", brief: "Address all review findings.", role: "resolver",
    blockedBy: ["standards", "specification"], targetSessionID: oldImplementer, delivery: "queue", executionMode,
  }), (error: unknown) => error instanceof MissionControlError && error.code === "invalid-role-policy")
  const finalResolver = await control.delegate("ses_coordinator", {
    taskKey: "resolver-final", title: "Resolve updated reviews", brief: "Address all review findings.", role: "resolver",
    blockedBy: ["standards", "specification"], targetSessionID: newImplementer, delivery: "queue", executionMode,
  })
  assert.equal(finalResolver.mission.tasks.find(task => task.key === "resolver-final")?.actorSessionId, newImplementer)
  assert.equal(actorFor(finalResolver.mission, "resolver"), newImplementer)
  await reportCompleted(control, newImplementer, "resolver-final", pocockArtifact("resolver"))
  assert(firstResolver.mission.tasks.some(task => task.key === "resolver-first"))
})

test("enforces Pocock evidence gates even when the coordinator omits dependency keys", async () => {
  const { create } = harness()
  const control = create()
  await control.inspect("ses_coordinator", {
    start: { objective: "Fix only after proving the bug", template: "pocock-fix-bug" },
  }, "pocock-policy")

  await assert.rejects(control.delegate("ses_coordinator", {
    taskKey: "implement", title: "Implement too early", brief: "Skip diagnosis.",
    role: "implementer", blockedBy: [], delivery: "queue",
  }), (error: unknown) => error instanceof MissionControlError && error.code === "invalid-role-policy")

  await assert.rejects(control.report("ses_coordinator", {
    outcome: "completed", summary: "Skip every evidence gate", evidence: [], next: [], final: true,
  }), (error: unknown) => error instanceof MissionControlError && error.code === "invalid-role-policy")
})

test("charts a Wayfinder frontier breadth-first without auto-dispatching work in the fog", async () => {
  const { create } = harness()
  const control = create()
  const started = await control.inspect("ses_coordinator", {
    start: {
      objective: "Choose a safe persistence boundary",
      template: "wayfinder",
      notes: "Fog: deployment ownership cannot be phrased until storage and audience constraints are known.",
    },
  }, "wayfinder-full")
  assert.equal(started.mission?.tasks.length, 0)
  assert.match(started.mission?.notes ?? "", /Fog:/)

  const storage = await control.delegate("ses_coordinator", {
    taskKey: "storage-facts", title: "Map storage constraints", brief: "Return facts only.",
    role: "research", blockedBy: [], delivery: "queue",
  })
  const audience = await control.delegate("ses_coordinator", {
    taskKey: "audience-facts", title: "Map audience constraints", brief: "Return facts only.",
    role: "research", blockedBy: [], delivery: "queue",
  })
  const blocked = await control.delegate("ses_coordinator", {
    taskKey: "choose-boundary", title: "Choose the persistence boundary", brief: "Decide from both fact reports.",
    role: "decision", blockedBy: ["storage-facts", "audience-facts"], delivery: "queue",
  })
  assert.equal(blocked.disposition, "blocked")
  assert.deepEqual(blocked.mission.claims, ["storage-facts", "audience-facts"])
  assert.deepEqual(blocked.mission.frontier, [])
  assert.equal(blocked.mission.actors.length, 3)

  await control.report(actorFor(storage.mission, "research"), {
    taskKey: "storage-facts", outcome: "completed", summary: "Project storage is location scoped.",
    evidence: ["Storage contract"], next: [], final: false,
  })
  const audienceActor = audience.mission.tasks.find((task) => task.key === "audience-facts")?.actorSessionId
  assert.ok(audienceActor)
  const secondReport = await control.report(audienceActor, {
    taskKey: "audience-facts", outcome: "completed", summary: "Only same-project actors consume the map.",
    evidence: ["Ownership fence"], next: ["Choose the boundary"], final: false,
  })
  assert.deepEqual(secondReport.mission.frontier, ["choose-boundary"])
  assert.deepEqual(secondReport.mission.claims, [])

  const decision = await control.delegate("ses_coordinator", {
    taskKey: "choose-boundary", title: "Choose the persistence boundary", brief: "Decide from both fact reports.",
    role: "decision", blockedBy: ["storage-facts", "audience-facts"], delivery: "queue",
  })
  assert.equal(decision.disposition, "dispatched")
  await control.report(actorFor(decision.mission, "decision"), {
    taskKey: "choose-boundary", outcome: "completed", summary: "Use the project-local append-only journal.",
    evidence: ["Both blockers resolved"], next: [], final: false,
  })
  const finished = await control.report("ses_coordinator", {
    outcome: "completed", summary: "The route is clear; implementation remains outside this planning mission.",
    evidence: [], next: [], final: true,
  })
  assert.equal(finished.mission.status, "completed")
  assert.equal(finished.mission.tasks.every((task) => task.status === "completed"), true)
})

function actorFor(mission: Awaited<ReturnType<MissionControl["snapshot"]>>["missions"][number], role: string): string {
  const actor = mission.actors.find((candidate) => candidate.roles.includes(role))
  assert.ok(actor, `actor for ${role}`)
  return actor.sessionId
}

async function reportCompleted(control: MissionControl, sessionID: string, taskKey: string, artifact: any): Promise<void> {
  await control.report(sessionID, {
    taskKey, outcome: "completed", summary: `${taskKey} complete`, evidence: ["verified"], next: [], artifact, final: false,
  })
}

function pocockArtifact(role: string): any {
  if (role === "diagnostician") return {
    kind: "diagnosis",
    feedbackLoop: { command: "npm test -- save", redOutput: "cross-workspace value observed" },
    minimizedRepro: "Two workspaces save the same key.",
    confirmedHypothesis: "The key omits workspace identity.",
    evidence: "Including identity isolates the values.",
    rejectedHypotheses: [],
  }
  if (role === "implementer") return {
    kind: "fix",
    changedFiles: ["src/cache.ts", "src/cache.test.ts"],
    regressionTest: { seam: "present", path: "src/cache.test.ts", command: "npm test -- save", redObserved: true, greenObserved: true },
    originalLoopGreen: true,
    debugInstrumentationRemoved: true,
    prevention: "Workspace identity is part of the public cache key.",
  }
  if (role === "review-standards" || role === "review-spec") return {
    kind: "review", axis: role === "review-standards" ? "standards" : "spec", verdict: "pass", findings: [],
  }
  if (role === "resolver") return { kind: "resolution", addressed: [], deferred: [], focusedChecks: [] }
  return {
    kind: "validation",
    checks: [
      { kind: "typecheck", command: "npm run typecheck", status: "passed", summary: "green" },
      { kind: "lint", command: "", status: "not-configured", summary: "not configured" },
      { kind: "test", command: "npm test", status: "passed", summary: "green" },
      { kind: "build", command: "npm run build", status: "passed", summary: "green" },
    ],
    focusedRegression: { command: "npm test -- save", status: "passed", summary: "green" },
    verdict: "green",
  }
}
