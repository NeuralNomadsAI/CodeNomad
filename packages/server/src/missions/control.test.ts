import assert from "node:assert/strict"
import test from "node:test"
import { MISSION_MAX_ACTORS, MISSION_MAX_EVENTS, MISSION_MAX_MISSIONS, type MissionJsonValue } from "./model"

import {
  MissionControl,
  MissionControlError,
} from "./control"
import type {
  MissionSessionAdapter,
  NativeMissionSession,
} from "./control-types"
import { MissionJournal, parseMissionEvent, type MissionStorage } from "./journal"

class MemoryStorage implements MissionStorage {
  readonly values = new Map<string, MissionJsonValue>()

  async get(key: string) {
    return this.values.get(key)
  }

  async set(key: string, value: MissionJsonValue) {
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
  const create = () => new MissionControl({
    project: { id: "project-1", canonical: "/repo", location: { directory: "/repo" } },
    storage,
    sessions,
    now: () => now++,
    changed: async (missionID, revision) => { changed.push({ missionID, revision }) },
  })
  return { storage, sessions, changed, create }
}

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
  assert.equal(sessions.synthetics[0]?.id, sessions.synthetics[1]?.id)
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
  storage.values.set("codenomad-missions/v1/bad/corrupt", { bad: true })
  const journal = new MissionJournal(storage, "project-1", "/repo", () => 100)
  const snapshot = await journal.snapshot()
  assert.equal(snapshot.missions.length, 0)
})

test("rejects a new event before the durable journal can exceed its safety limit", async () => {
  const storage = new MemoryStorage()
  const journal = new MissionJournal(storage, "project-1", "/repo", () => 100)
  for (let index = 0; index < MISSION_MAX_EVENTS; index += 1) {
    storage.values.set(`codenomad-missions/v1/${journal.projectToken}/seed/${index.toString().padStart(4, "0")}`, { seed: index })
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
