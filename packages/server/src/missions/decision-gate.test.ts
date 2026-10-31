import assert from "node:assert/strict"
import test from "node:test"
import { MissionControl } from "./control"
import type { MissionSessionAdapter, NativeMissionSession } from "./control-types"
import type { HumanDecisionDiscoveryRequest, HumanDecisionMark, NativeHumanAnswerGate } from "./human-answer"
import type { MissionStorage } from "./journal"
import type { MissionJsonValue, MissionMap } from "./model"
import { missionDecisionMaker } from "./decision-artifact"

class MemoryStorage implements MissionStorage {
  readonly values = new Map<string, MissionJsonValue>()
  async get(key: string) { return this.values.get(key) }
  async set(key: string, value: MissionJsonValue) { this.values.set(key, structuredClone(value)) }
  async scan(options: { prefix: string; after?: string; limit?: number }) {
    const keys = [...this.values.keys()].filter(key => key.startsWith(options.prefix)).sort()
    const start = options.after ? Math.max(0, keys.findIndex(key => key > options.after!)) : 0
    const selected = keys.slice(start, start + (options.limit ?? 100))
    return { entries: selected.map(key => ({ key, value: this.values.get(key)! })),
      next: start + selected.length < keys.length ? selected[selected.length - 1] : undefined }
  }
}

const coordinator = "ses_coordinator"
const question = "Which seam?"

/** Confirmed UI marks keyed by session and Form; the gate refuses anything else, like the native one. */
function fixture() {
  const sessions = new Map<string, NativeMissionSession>([[coordinator,
    { id: coordinator, projectID: "project-1", title: "Coordinator", location: { directory: "/repo" } }],
  ["ses_decision", { id: "ses_decision", parentID: coordinator, projectID: "project-1", title: "Decision", location: { directory: "/repo" } }]])
  const adapter: MissionSessionAdapter = {
    get: async ({ sessionID }) => { const session = sessions.get(sessionID); if (!session) throw new Error("not found"); return session },
    create: async () => { throw new Error("No roots") }, prompt: async () => {}, synthetic: async () => {},
  }
  const marks = new Map<string, HumanDecisionMark>(), requests: Parameters<NativeHumanAnswerGate>[0][] = []
  const discoveries: HumanDecisionDiscoveryRequest[] = []
  const gate: NativeHumanAnswerGate = Object.assign(async (request: Parameters<NativeHumanAnswerGate>[0]) => {
    requests.push(request)
    const mark = marks.get(`${request.sessionID}/${request.formID}`)
    if (!mark || mark.answer[request.fieldKey] !== request.answer) throw new Error("Exact native human mark unavailable")
    return structuredClone(mark)
  }, { discover: async (request: HumanDecisionDiscoveryRequest) => { discoveries.push(request); return { candidates: [], complete: true } } })
  let now = 1_000
  const control = new MissionControl({ project: { id: "project-1", canonical: "/repo", location: { directory: "/repo" } },
    storage: new MemoryStorage(), sessions: adapter, humanGate: gate, now: () => now++ })
  const answer = (sessionID: string, formID: string, value: string) => marks.set(`${sessionID}/${formID}`, { formID, sessionID, answeredAt: 1, via: "ui",
    answer: { q0: value }, form: { metadata: { kind: "question", tool: { messageID: `msg_${formID}`, id: `call_${formID}` } } } as never })
  const start = async () => (await control.inspect(coordinator, { start: { objective: "Chart the pilot", template: "wayfinder" } }, "start")).mission!
  const declare = (taskKey: string) => control.declare(coordinator, { taskKey, title: `Task ${taskKey}`, brief: "Bounded decision", role: "decision", blockedBy: [] })
  const current = async () => (await control.snapshot()).missions.find(mission => mission.coordinatorSessionId === coordinator)!
  const readout = (taskKey: string, artifact?: MissionJsonValue) => control.report(coordinator, { taskKey, outcome: "completed",
    summary: "Settled the seam.", evidence: [], next: [], final: false, ...(artifact === undefined ? {} : { artifact }) })
  return { control, marks, requests, discoveries, answer, start, declare, current, readout }
}

const asked = (mission: MissionMap, taskKey: string, value: string, formID = "frm_1", sessionID = coordinator): MissionJsonValue => ({
  kind: "decision", decidedBy: "human", question, answer: value, provenance: { kind: "coordinator-form-answer",
    contract: { missionID: mission.id, taskKey, generation: 1 }, sessionID, formID, messageID: `msg_${formID}`, toolCallID: `call_${formID}`, fieldKey: "q0" } })
const own = { kind: "decision", decidedBy: "coordinator", question, decision: "Module", rationale: "The repository already isolates modules.",
  reversal: "Swap the adapter in one file." }
const maker = (mission: MissionMap, taskKey: string) => {
  const task = mission.tasks.find(task => task.key === taskKey)!
  return missionDecisionMaker(mission.template, task, task.report!)
}

test("a human-claimed decision without a confirmed UI mark is refused and records nothing", async () => {
  const f = fixture()
  const mission = await f.start()
  await f.declare("choose")
  await assert.rejects(f.readout("choose", asked(mission, "choose", "Module")), /Human decision required: the user must answer/)
  // A model-written answer without a cited native question never passes as the human's.
  await assert.rejects(f.readout("choose", { kind: "decision", question, answer: "Module" }), /Wayfinder decision evidence unavailable/)
  f.answer(coordinator, "frm_1", "Adapter")
  await assert.rejects(f.readout("choose", asked(mission, "choose", "Module")), /Human decision required/, "the mark holds another answer")
  f.answer("ses_decision", "frm_child", "Module")
  await assert.rejects(f.readout("choose", asked(mission, "choose", "Module", "frm_child", "ses_decision")), /Wayfinder decision evidence unavailable/,
    "a coordinator-asked answer lives in the coordinator's own conversation")
  await assert.rejects(f.readout("choose", { ...asked(mission, "choose", "Adapter") as object, decidedBy: "coordinator" } as MissionJsonValue),
    /A coordinator decision passes artifact/, "a human answer cannot be relabelled as the coordinator's")
  assert.equal((await f.current()).tasks[0].status, "ready")
  assert.equal((await f.current()).reports.length, 0)
})

test("a coordinator decision needs no human proof and is labelled as the coordinator's", async () => {
  const f = fixture()
  await f.start()
  await f.declare("choose")
  await assert.rejects(f.readout("choose", { ...own, rationale: undefined } as unknown as MissionJsonValue), /A coordinator decision passes artifact/)
  await assert.rejects(f.readout("choose", { ...own, answer: "Module" }), /A coordinator decision passes artifact/,
    "a coordinator decision never carries a human answer field")
  assert.equal((await f.readout("choose", own)).disposition, "reported")
  assert.equal(f.requests.length, 0, "no human gate is consulted")
  const mission = await f.current()
  assert.equal(maker(mission, "choose"), "coordinator")
  assert.deepEqual(mission.tasks[0].report?.artifact, own)
  const finished = await f.control.report(coordinator, { outcome: "completed", summary: "Route clear.", evidence: [], next: [], final: true })
  assert.equal(finished.disposition, "finished")
  assert.equal(f.requests.length, 0, "the final report accepts the coordinator decision as such")
})

test("the human's answer to the coordinator's own question passes with its confirmed UI mark, once per decision", async () => {
  const f = fixture()
  const mission = await f.start()
  await f.declare("choose"); await f.declare("schema")
  f.answer(coordinator, "frm_1", "Module")
  await f.control.decisionCandidates(coordinator, mission.id, "choose")
  assert.deepEqual(f.discoveries.at(-1)?.coordinatorSessionID, coordinator, "inspect lists the coordinator's answered questions")
  assert.deepEqual(f.discoveries.at(-1)?.exclude, [])
  // An artifact-free readout discovers only the decision task's own conversations: a coordinator answer is passed explicitly.
  await assert.rejects(f.readout("choose"), /Decision outcome required/)
  assert.equal(f.discoveries.at(-1)?.coordinatorSessionID, undefined)
  assert.equal((await f.readout("choose", asked(mission, "choose", "Module"))).disposition, "reported")
  assert.equal(maker(await f.current(), "choose"), "human")
  await assert.rejects(f.readout("schema", asked(mission, "schema", "Module")), /already settles another decision task/)
  await f.control.decisionCandidates(coordinator, mission.id, "schema")
  assert.deepEqual(f.discoveries.at(-1)?.exclude, [{ formID: "frm_1", fieldKey: "q0" }], "a used answer is not offered again")
  await assert.rejects(f.readout("schema", asked(mission, "choose", "Module", "frm_2")), /Wayfinder decision evidence unavailable/,
    "the cited contract names this task")
  f.answer(coordinator, "frm_2", "Versioned")
  assert.equal((await f.readout("schema", asked(mission, "schema", "Versioned", "frm_2"))).disposition, "reported")
  const before = f.requests.length
  assert.equal((await f.control.report(coordinator, { outcome: "completed", summary: "Route clear.", evidence: [], next: [], final: true })).disposition, "finished")
  assert.equal(f.requests.length - before, 2, "the final report re-verifies both human answers")
})

test("the decision conversation's own answer (missions started before coordinator-asked decisions) still passes", async () => {
  const f = fixture()
  const mission = await f.start()
  await f.declare("choose")
  const legacy = { kind: "decision", question, answer: "Module", provenance: { kind: "native-form-answer",
    contract: { missionID: mission.id, taskKey: "choose", generation: 1 },
    nativeCall: { generation: 1, parentSessionID: coordinator, parentMessageID: "msg_parent", toolCallID: "call_subagent" },
    sessionID: "ses_decision", formID: "frm_child", messageID: "msg_frm_child", toolCallID: "call_frm_child", fieldKey: "q0" } }
  await assert.rejects(f.readout("choose", legacy), /Human decision required/)
  f.answer("ses_decision", "frm_child", "Module")
  assert.equal((await f.readout("choose", legacy)).disposition, "reported")
  assert.equal(f.requests.at(-1)?.kind, "native-form-answer")
  assert.equal(maker(await f.current(), "choose"), "human")
})

test("only gated reports name who decided", () => {
  const task = { role: "decision", executionMode: { kind: "native" as const, parentTaskKey: null } }
  const report = { outcome: "completed" as const, delivery: "coordinator-readout" as const, artifact: own }
  assert.equal(missionDecisionMaker("wayfinder", task, report), "coordinator")
  assert.equal(missionDecisionMaker("wayfinder", { ...task, executionMode: undefined }, report), undefined, "an independent root's own report is not gated")
  assert.equal(missionDecisionMaker("wayfinder", task, { ...report, delivery: "native-return" }), undefined, "a task actor never decides for the coordinator")
  assert.equal(missionDecisionMaker("wayfinder", task, { ...report, artifact: { kind: "decision", question, humanAnswer: true } }), undefined,
    "an unproven historical claim is not shown as the human's")
  assert.equal(missionDecisionMaker("custom", task, report), undefined)
  assert.equal(missionDecisionMaker("wayfinder", task, { ...report, outcome: "blocked" }), undefined)
})
