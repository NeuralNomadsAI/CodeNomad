import assert from "node:assert/strict"
import test from "node:test"

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
  readonly values = new Map<string, unknown>()

  async get(key: string) {
    return this.values.get(key)
  }

  async set(key: string, value: unknown) {
    this.values.set(key, structuredClone(value))
  }

  async scan(options: { prefix: string; after?: string; limit?: number }) {
    const keys = [...this.values.keys()].filter((key) => key.startsWith(options.prefix)).sort()
    const start = options.after ? keys.findIndex((key) => key > options.after!) : 0
    const offset = start < 0 ? keys.length : start
    const selected = keys.slice(offset, offset + (options.limit ?? 100))
    return {
      entries: selected.map((key) => ({ key, value: this.values.get(key) })),
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
  assert.equal(sessions.prompts[0]?.delivery, "queue")
  assert.equal(sessions.prompts[0]?.resume, true)
  assert.match(sessions.prompts[0]?.text ?? "", /mission\.report/)

  const reported = await control.report(actor.sessionId, {
    taskKey: "diagnose",
    outcome: "completed",
    summary: "The cache key omits the workspace identity.",
    evidence: ["Focused test fails before the fix."],
    next: ["Add workspace identity to the cache key."],
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
