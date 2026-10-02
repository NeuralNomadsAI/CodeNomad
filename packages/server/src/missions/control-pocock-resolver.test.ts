import assert from "node:assert/strict"
import test from "node:test"

import { MissionControl } from "./control"
import type { MissionSessionAdapter, NativeMissionSession } from "./control-types"
import type { MissionJsonValue } from "./model"
import type { MissionStorage } from "./journal"

class MemoryStorage implements MissionStorage {
  private readonly values = new Map<string, MissionJsonValue>()

  async get(key: string) { return this.values.get(key) }
  async set(key: string, value: MissionJsonValue) { this.values.set(key, structuredClone(value)) }
  async scan({ prefix }: { prefix: string; after?: string; limit?: number }) {
    return { entries: [...this.values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }
  }
}

class FakeSessions implements MissionSessionAdapter {
  private readonly sessions = new Map<string, NativeMissionSession>([["ses_coordinator", {
    id: "ses_coordinator", projectID: "project-pocock", title: "Coordinator", location: { directory: "/repo" },
  }]])

  async get({ sessionID }: { sessionID: string }) {
    const session = this.sessions.get(sessionID)
    if (!session) throw new Error("session not found")
    return session
  }
  async create(input: Parameters<MissionSessionAdapter["create"]>[0]) {
    const session: NativeMissionSession = {
      id: input.id, projectID: "project-pocock", title: input.title,
      location: input.location, agent: input.agent, model: input.model,
    }
    this.sessions.set(session.id, session)
    return session
  }
  async prompt() {}
  async synthetic() {}
}

test("delegates and revises Pocock resolvers to one actor shared by a multi-step implementation", async () => {
  const control = new MissionControl({
    project: { id: "project-pocock", canonical: "/repo", location: { directory: "/repo" } },
    storage: new MemoryStorage(), sessions: new FakeSessions(),
  })
  await control.inspect("ses_coordinator", {
    start: { objective: "Implement one fix in two dependent steps", template: "pocock-fix-bug" },
  }, "pocock-shared-implementer")

  const diagnosis = await control.delegate("ses_coordinator", {
    taskKey: "diagnose", title: "Diagnose", brief: "Confirm root cause.",
    role: "diagnostician", blockedBy: [], delivery: "queue",
  })
  await complete(control, actorFor(diagnosis.mission, "diagnostician"), "diagnose", diagnosisArtifact)

  const firstFix = await control.delegate("ses_coordinator", {
    taskKey: "fix-part-one", title: "Implement foundation", brief: "Make the foundational change.",
    role: "implementer", blockedBy: ["diagnose"], delivery: "queue",
  })
  const implementer = taskActor(firstFix.mission, "fix-part-one")
  await complete(control, implementer, "fix-part-one", fixArtifact)

  const secondFix = await control.delegate("ses_coordinator", {
    taskKey: "fix-part-two", title: "Complete implementation", brief: "Build on the first implementation step.",
    role: "implementer", blockedBy: ["fix-part-one"], targetSessionID: implementer, delivery: "queue",
  })
  assert.equal(secondFix.disposition, "dispatched")
  assert.equal(taskActor(secondFix.mission, "fix-part-two"), implementer)
  await complete(control, implementer, "fix-part-two", fixArtifact)

  const standards = await control.delegate("ses_coordinator", {
    taskKey: "standards", title: "Review standards", brief: "Review the completed implementation.",
    role: "review-standards", blockedBy: ["fix-part-two"], delivery: "queue",
  })
  const specification = await control.delegate("ses_coordinator", {
    taskKey: "specification", title: "Review specification", brief: "Check the requested behavior.",
    role: "review-spec", blockedBy: ["fix-part-two"], delivery: "queue",
  })
  await complete(control, actorFor(standards.mission, "review-standards"), "standards", standardsArtifact)
  await complete(control, actorFor(specification.mission, "review-spec"), "specification", specArtifact)

  const firstResolver = await control.delegate("ses_coordinator", {
    taskKey: "resolver-one", title: "Resolve reviews", brief: "Address review findings.",
    role: "resolver", blockedBy: ["standards", "specification"], targetSessionID: implementer, delivery: "queue",
  })
  assert.equal(taskActor(firstResolver.mission, "resolver-one"), implementer)
  await complete(control, implementer, "resolver-one", resolverArtifact)

  const beforeRevise = (await control.snapshot()).missions[0]!
  const revised = await control.revise("ses_coordinator", {
    missionID: beforeRevise.id, expectedRevision: beforeRevise.revision,
    requestID: "revise-shared-actor-resolver", reason: "Record the final resolution pass",
    retireTasks: [{ taskKey: "resolver-one", replacementTaskKey: "resolver-two" }],
    addTasks: [{ taskKey: "resolver-two", title: "Final resolution", brief: "Confirm all review feedback is addressed.",
      role: "resolver", blockedBy: ["standards", "specification"], replacesTaskKey: "resolver-one" }],
    dependencyUpdates: [],
  })
  assert.equal(revised.mission.tasks.find(task => task.key === "resolver-one")?.status, "withdrawn")
  const finalResolver = await control.delegate("ses_coordinator", {
    taskKey: "resolver-two", title: "Final resolution", brief: "Confirm all review feedback is addressed.",
    role: "resolver", blockedBy: ["standards", "specification"], targetSessionID: implementer, delivery: "queue",
  })
  assert.equal(finalResolver.disposition, "dispatched")
  assert.equal(taskActor(finalResolver.mission, "resolver-two"), implementer)
  await complete(control, implementer, "resolver-two", resolverArtifact)
  assert.equal((await control.snapshot()).missions[0]?.reports.filter(report => report.taskKey.startsWith("fix-part-")).length, 2)
})

async function complete(control: MissionControl, sessionID: string, taskKey: string, artifact: unknown): Promise<void> {
  await control.report(sessionID, {
    taskKey, outcome: "completed", summary: `${taskKey} complete`, evidence: ["verified"], next: [],
    artifact: artifact as MissionJsonValue, final: false,
  })
}

function taskActor(mission: Awaited<ReturnType<MissionControl["snapshot"]>>["missions"][number], taskKey: string): string {
  const sessionID = mission.tasks.find(task => task.key === taskKey)?.actorSessionId
  assert.ok(sessionID, `actor assigned to ${taskKey}`)
  return sessionID
}

function actorFor(mission: Awaited<ReturnType<MissionControl["snapshot"]>>["missions"][number], role: string): string {
  const actor = mission.actors.find(candidate => candidate.roles.includes(role))
  assert.ok(actor, `actor for ${role}`)
  return actor.sessionId
}

const diagnosisArtifact = {
  kind: "diagnosis",
  feedbackLoop: { command: "npm test -- cache", redOutput: "workspace values collide" },
  minimizedRepro: "Two workspaces use one relative key.",
  confirmedHypothesis: "The key omits workspace identity.",
  evidence: "Including the workspace separates both values.",
  rejectedHypotheses: ["stale timestamps"],
}

const fixArtifact = {
  kind: "fix",
  changedFiles: ["src/cache.ts", "src/cache.test.ts"],
  regressionTest: { seam: "present", path: "src/cache.test.ts", command: "npm test -- cache", redObserved: true, greenObserved: true },
  originalLoopGreen: true,
  debugInstrumentationRemoved: true,
  prevention: "Workspace identity is included in the cache key.",
}

const standardsArtifact = { kind: "review", axis: "standards", verdict: "pass", findings: [] }
const specArtifact = { kind: "review", axis: "spec", verdict: "pass", findings: [] }
const resolverArtifact = { kind: "resolution", addressed: [], deferred: [], focusedChecks: [] }
