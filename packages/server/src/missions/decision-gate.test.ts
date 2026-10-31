import assert from "node:assert/strict"
import test from "node:test"
import { MissionControl } from "./control"
import type { MissionSessionAdapter, NativeMissionSession } from "./control-types"
import type { HumanDecisionCandidate, HumanDecisionDiscoveryRequest, HumanDecisionMark, NativeHumanAnswerGate } from "./human-answer"
import { MissionJournal, type MissionStorage } from "./journal"
import type { MissionJsonValue, MissionMap } from "./model"
import { missionDecisionMaker } from "./decision-artifact"
import { decisionQuestionTag, fieldDecisionTag } from "./decision-question-tag"

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
/** After every task declaration of these fixtures (their clock starts at 1000). */
const LATER = 1_000_000

type MockField = { key: string; title: string; description: string }

/** Confirmed UI marks keyed by session and Form, holding each field's header and question. Like the native gate,
 * this one checks the cited field's exact question and answer, and binds a coordinator question per field. */
function fixture() {
  const sessions = new Map<string, NativeMissionSession>([[coordinator,
    { id: coordinator, projectID: "project-1", title: "Coordinator", location: { directory: "/repo" } }],
  ["ses_decision", { id: "ses_decision", parentID: coordinator, projectID: "project-1", title: "Decision", location: { directory: "/repo" } }]])
  const adapter: MissionSessionAdapter = {
    get: async ({ sessionID }) => { const session = sessions.get(sessionID); if (!session) throw new Error("not found"); return session },
    create: async () => { throw new Error("No roots") }, prompt: async () => {}, synthetic: async () => {},
  }
  const marks = new Map<string, HumanDecisionMark & { fields: MockField[] }>(), requests: Parameters<NativeHumanAnswerGate>[0][] = []
  const discoveries: HumanDecisionDiscoveryRequest[] = []
  const gate: NativeHumanAnswerGate = Object.assign(async (request: Parameters<NativeHumanAnswerGate>[0]) => {
    requests.push(request)
    const mark = marks.get(`${request.sessionID}/${request.formID}`), field = mark?.fields.find(field => field.key === request.fieldKey)
    if (!mark || !field || field.description !== request.question || mark.answer[request.fieldKey] !== request.answer) throw new Error("Exact native human mark unavailable")
    if (request.kind === "coordinator-form-answer" && fieldDecisionTag(field) !== decisionQuestionTag(request.contract.missionID, request.contract.taskKey))
      throw new Error("Coordinator question does not name this decision task")
    const { fields, ...receipt } = mark
    return structuredClone({ ...receipt, form: { ...receipt.form, fields } as never })
  }, { discover: async (request: HumanDecisionDiscoveryRequest) => {
    discoveries.push(request)
    const tag = decisionQuestionTag(request.contract.missionID, request.contract.taskKey)
    const candidates: HumanDecisionCandidate[] = [...marks.values()].filter(mark => mark.sessionID === request.coordinatorSessionID)
      .flatMap(mark => mark.fields.filter(field => fieldDecisionTag(field) === tag).map(field => ({ mark, field })))
      .map(({ mark, field }) => ({ question: field.description, answer: mark.answer[field.key] as string, askedBy: "coordinator" as const, artifact: { kind: "decision",
        decidedBy: "human", question: field.description, answer: mark.answer[field.key] as string, provenance: { kind: "coordinator-form-answer", contract: request.contract,
          sessionID: mark.sessionID, formID: mark.formID, messageID: `msg_${mark.formID}`, toolCallID: `call_${mark.formID}`, fieldKey: field.key } } }))
    return { candidates, complete: true }
  } })
  let now = 1_000
  const storage = new MemoryStorage()
  const control = new MissionControl({ project: { id: "project-1", canonical: "/repo", location: { directory: "/repo" } },
    storage, sessions: adapter, humanGate: gate, now: () => now++ })
  /** One answered question call: each entry is one field (`q0`, `q1`…) with its question, answer and optional header. */
  const answerForm = (sessionID: string, formID: string, entries: Array<{ question: string; answer: string; header?: string }>, answeredAt = LATER) =>
    marks.set(`${sessionID}/${formID}`, { formID, sessionID, answeredAt, via: "ui",
      fields: entries.map((entry, index) => ({ key: `q${index}`, title: entry.header ?? "Seam", description: entry.question })),
      answer: Object.fromEntries(entries.map((entry, index) => [`q${index}`, entry.answer])),
      form: { metadata: { kind: "question", tool: { messageID: `msg_${formID}`, id: `call_${formID}` } } } as never })
  const answer = (sessionID: string, formID: string, value: string, text = question, answeredAt = LATER) =>
    answerForm(sessionID, formID, [{ question: text, answer: value }], answeredAt)
  const start = async () => (await control.inspect(coordinator, { start: { objective: "Chart the pilot", template: "wayfinder" } }, "start")).mission!
  const declare = (taskKey: string) => control.declare(coordinator, { taskKey, title: `Task ${taskKey}`, brief: "Bounded decision", role: "decision", blockedBy: [] })
  const current = async () => (await control.snapshot()).missions.find(mission => mission.coordinatorSessionId === coordinator)!
  const readout = (taskKey: string, artifact?: MissionJsonValue) => control.report(coordinator, { taskKey, outcome: "completed",
    summary: "Settled the seam.", evidence: [], next: [], final: false, ...(artifact === undefined ? {} : { artifact }) })
  const finish = () => control.report(coordinator, { outcome: "completed", summary: "Route clear.", evidence: [], next: [], final: true })
  return { control, storage, marks, requests, discoveries, answer, answerForm, start, declare, current, readout, finish }
}

/** The question the coordinator asks about `taskKey`, naming it with its tag. */
const about = (mission: MissionMap, taskKey: string) => `${question} ${decisionQuestionTag(mission.id, taskKey)}`
const asked = (mission: MissionMap, taskKey: string, value: string, formID = "frm_1", sessionID = coordinator, text = about(mission, taskKey)): MissionJsonValue => ({
  kind: "decision", decidedBy: "human", question: text, answer: value, provenance: { kind: "coordinator-form-answer",
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
  f.answer(coordinator, "frm_1", "Adapter", about(mission, "choose"))
  await assert.rejects(f.readout("choose", asked(mission, "choose", "Module")), /Human decision required/, "the mark holds another answer")
  f.answer("ses_decision", "frm_child", "Module", about(mission, "choose"))
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
  assert.equal((await f.finish()).disposition, "finished")
  assert.equal(f.requests.length, 0, "the final report accepts the coordinator decision as such")
})

test("the coordinator's own question settles only the decision task it names", async () => {
  const f = fixture()
  const mission = await f.start()
  await f.declare("choose"); await f.declare("schema"); await f.declare("naming")
  assert.match(decisionQuestionTag(mission.id, "choose"), /^\[decision choose [0-9a-f]{8}\]$/)
  f.answer(coordinator, "frm_1", "Module", about(mission, "choose"))
  await f.control.decisionCandidates(coordinator, mission.id, "choose")
  assert.equal(f.discoveries.at(-1)?.coordinatorSessionID, coordinator, "inspect lists the coordinator's answered questions")
  // Relabelling the answer to another task: its question names "choose", so it never settles "schema".
  await assert.rejects(f.readout("schema", asked(mission, "schema", "Module", "frm_1", coordinator, about(mission, "choose"))),
    /does not settle this decision task: the human must answer a question that ends with \[decision schema [0-9a-f]{8}\] and names no other decision/)
  assert.deepEqual((await f.control.decisionCandidates(coordinator, mission.id, "schema"))?.candidates, [], "not offered to another task")
  // Every candidate answers this exact task, so an artifact-free readout takes the single one.
  assert.equal((await f.readout("choose")).disposition, "reported")
  assert.equal(maker(await f.current(), "choose"), "human")
  // One batched question call: each field settles the one decision its own question names, with its own answer.
  f.answerForm(coordinator, "frm_batch", [{ question: about(mission, "schema"), answer: "Versioned" }, { question: about(mission, "naming"), answer: "Short" }])
  for (const [taskKey, fieldKey, answer] of [["schema", "q0", "Versioned"], ["naming", "q1", "Short"]]) {
    assert.deepEqual((await f.control.decisionCandidates(coordinator, mission.id, taskKey))?.candidates.map(item =>
      [item.artifact.provenance.fieldKey, item.answer]), [[fieldKey, answer]])
    assert.equal((await f.readout(taskKey)).disposition, "reported")
  }
  assert.deepEqual((await f.current()).tasks.map(task => [task.key, (task.report?.artifact as { answer?: string }).answer]),
    [["choose", "Module"], ["schema", "Versioned"], ["naming", "Short"]])
  const before = f.requests.length
  assert.equal((await f.finish()).disposition, "finished")
  assert.equal(f.requests.length - before, 3, "the final report re-verifies every human answer")
})

test("a field naming two decisions, or a tag outside its question's end, binds no decision", async () => {
  const f = fixture()
  const mission = await f.start()
  await f.declare("choose-seam"); await f.declare("delete-production")
  const seam = decisionQuestionTag(mission.id, "choose-seam"), deletion = decisionQuestionTag(mission.id, "delete-production")
  const quoted = `Which module seam? ${seam} Background only, NOT a deletion approval: the blocked task is "${deletion}".`
  const cases: Array<[string, { question: string; header?: string }]> = [
    ["a question quoting a second tag", { question: quoted }],
    ["two tags at its end", { question: `Which seam and may we delete? ${seam} ${deletion}` }],
    ["another tag in its header", { question: `Which module seam? ${seam}`, header: deletion }],
    ["its tag not at the end", { question: `${deletion} May we delete the production database?` }],
  ]
  for (const [index, [name, field]] of cases.entries()) {
    const formID = `frm_case_${index}`
    f.answerForm(coordinator, formID, [{ ...field, answer: "Module" }])
    for (const taskKey of ["choose-seam", "delete-production"]) {
      assert.deepEqual((await f.control.decisionCandidates(coordinator, mission.id, taskKey))?.candidates, [], `${name}: ${taskKey} not offered`)
      // The gate refuses a header it alone sees; the question text is refused before reaching it.
      await assert.rejects(f.readout(taskKey, asked(mission, taskKey, "Module", formID, coordinator, field.question)),
        /does not settle this decision task|does not name this decision task/, `${name}: ${taskKey}`)
    }
    f.marks.delete(`${coordinator}/${formID}`)
  }
  for (const taskKey of ["choose-seam", "delete-production"]) await assert.rejects(f.readout(taskKey), /Decision outcome required/)
  assert.equal((await f.current()).reports.length, 0)
  assert.equal(fieldDecisionTag({ description: `Which module seam? ${seam}`, title: seam }), seam, "the same tag repeated in the header still binds")
})

test("an answer given before the task existed or in another mission on the same coordinator never settles it", async () => {
  const f = fixture()
  const mission = await f.start()
  // Answered before the task was declared, even with the right tag.
  f.answer(coordinator, "frm_early", "Delete", about(mission, "delete-production"), 1)
  await f.declare("delete-production")
  await assert.rejects(f.readout("delete-production", asked(mission, "delete-production", "Delete", "frm_early")),
    /asked after the task was declared/)
  // A reused coordinator root: the earlier mission's question names that mission, not this one.
  const elsewhere = `${question} ${decisionQuestionTag("msn_earlier_mission", "delete-production")}`
  f.answer(coordinator, "frm_old_mission", "Delete", elsewhere)
  await assert.rejects(f.readout("delete-production", asked(mission, "delete-production", "Delete", "frm_old_mission", coordinator, elsewhere)),
    /does not settle this decision task/)
  // An untagged answer, such as consent asked for something else, is never offered nor accepted.
  f.answer(coordinator, "frm_untagged", "Yes", "May I proceed?")
  assert.deepEqual((await f.control.decisionCandidates(coordinator, mission.id, "delete-production"))?.candidates.map(item => item.artifact.provenance.formID),
    ["frm_early"], "discovery lists only questions naming the task; the gate still refuses the early one")
  await assert.rejects(f.readout("delete-production", asked(mission, "delete-production", "Yes", "frm_untagged", coordinator, "May I proceed?")),
    /does not settle this decision task/)
  await assert.rejects(f.readout("delete-production"), /asked after the task was declared/, "the early answer is not auto-filled into a settlement")
  assert.equal((await f.current()).reports.length, 0)
})

for (const [name, text] of [["never named this task", (_: MissionMap) => "Choose the seam?"],
  ["also quoted another decision", (mission: MissionMap) => `${about(mission, "choose")} Not about ${decisionQuestionTag(mission.id, "other")}.`]] as const) {
  test(`the final report re-checks the binding of a stored coordinator-asked answer whose question ${name}`, async () => {
    const f = fixture()
    const mission = await f.start()
    await f.declare("choose")
    // A readout an earlier build accepted, stored as is.
    f.answer(coordinator, "frm_unbound", "Module", text(mission))
    const current = await f.current()
    const artifact = asked(mission, "choose", "Module", "frm_unbound", coordinator, text(mission))
    await new MissionJournal(f.storage, "project-1", "/repo").append({ version: 1, id: "evt_unbound_readout", type: "task.reported", missionID: mission.id,
      projectID: "project-1", createdAt: current.updatedAt + 1, report: { id: "rpt_unbound", taskKey: "choose", sessionId: coordinator, outcome: "completed",
        summary: "Unbound answer", evidence: [], next: [], artifact, delivery: "coordinator-readout", createdAt: current.updatedAt + 1 } })
    assert.equal((await f.current()).tasks[0].status, "completed")
    await assert.rejects(f.finish(), /does not settle this decision task/)
    assert.equal((await f.current()).status, "active")
  })
}

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
  assert.equal((await f.finish()).disposition, "finished")
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
