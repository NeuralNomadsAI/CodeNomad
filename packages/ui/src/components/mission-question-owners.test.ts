import assert from "node:assert/strict"
import { test } from "node:test"
import { coordinatorAsks, currentMissionObservations, missionQuestionOwners, nativeMissionQuestions, taskQuestion, type MissionQuestion } from "./mission-question-owners"

// "ses_native" is a known native task conversation of the coordinator.
const mission = { coordinatorSessionId: "ses_coordinator", isTaskSession: (id: string) => id === "ses_native" }
const ask = (sessionId: string, actorSessionId: string, id = sessionId): MissionQuestion =>
  ({ sessionId, actorSessionId, request: { kind: "form", id: `form-${id}` } })
const live = { status: "dispatching" as const, actorSessionId: "ses_worker" }

test("only the coordinator's own question, or one of its family no task conversation carries, is the Mission's", () => {
  assert.equal(coordinatorAsks(mission, ask("ses_coordinator", "ses_coordinator")), true)
  // An ordinary child of the coordinator that is not a known task conversation.
  assert.equal(coordinatorAsks(mission, ask("ses_helper", "ses_coordinator")), true)
  // A declared task actor's (or its descendant's) question is its task's.
  assert.equal(coordinatorAsks(mission, ask("ses_worker", "ses_worker")), false)
  assert.equal(coordinatorAsks(mission, ask("ses_grandchild", "ses_worker")), false)
})

test("a live task carries its actor's or its exact conversation's question; a finished one never does", () => {
  const worker = ask("ses_grandchild", "ses_worker")
  assert.equal(taskQuestion(mission, [worker], live, undefined), worker)
  assert.equal(taskQuestion(mission, [worker], { ...live, status: "completed" as const }, undefined), undefined)
  assert.equal(taskQuestion(mission, [worker], { ...live, replacedByTaskKey: "next" }, undefined), undefined)
  assert.equal(taskQuestion(mission, [worker], { status: "dispatching", actorSessionId: "ses_other" }, undefined), undefined)
  // A native task conversation of the coordinator, matched exactly.
  const native = ask("ses_native", "ses_coordinator"), unknown = ask("ses_unknown", "ses_coordinator")
  assert.equal(taskQuestion(mission, [native], { status: "dispatching" }, "ses_native"), native, "a known native task conversation's question is its task's")
  assert.equal(taskQuestion(mission, [unknown], { status: "dispatching" }, "ses_unknown"), undefined, "an unknown one stays the coordinator's (its flag)")
  // The coordinator's own question is never a task's, whatever the task's actor.
  assert.equal(taskQuestion(mission, [ask("ses_coordinator", "ses_coordinator")], { status: "dispatching", actorSessionId: "ses_coordinator" }, "ses_coordinator"), undefined)
})

test("with the map known, a task's question no loaded live row carries goes to the flag", () => {
  const coordinator = ask("ses_coordinator", "ses_coordinator"), worker = ask("ses_worker", "ses_worker"), far = ask("ses_far", "ses_far")
  const questions = [coordinator, worker, far]
  // Without the map (a closed row), every non-coordinator question is its tasks'.
  assert.deepEqual(missionQuestionOwners(mission, questions), { flag: [coordinator], tasks: [worker, far] })
  // With it, the off-page actor's question is the flag's, so it stays one click away.
  assert.deepEqual(missionQuestionOwners(mission, questions, [live]), { flag: [coordinator, far], tasks: [worker] })
  assert.deepEqual(missionQuestionOwners(mission, questions, [{ ...live, status: "completed" as const }]),
    { flag: [coordinator, worker, far], tasks: [] })
})

test("splitting many questions over many tasks resolves each task's conversation once", () => {
  const tasks = Array.from({ length: 2_000 }, (_, index) => ({ status: "dispatching" as const, actorSessionId: index % 2 ? `ses_actor_${index}` : undefined }))
  const questions = Array.from({ length: 32 }, (_, index) => ask(`ses_native_${index}`, `ses_actor_${index * 2 + 1}`))
  let calls = 0
  const owners = missionQuestionOwners(mission, questions, tasks, () => { calls++; return undefined })
  assert.equal(calls, tasks.length, "linear in tasks, independent of the questions")
  assert.equal(owners.tasks.length, 32)
  assert.equal(missionQuestionOwners(mission, [], tasks, () => { calls++; return undefined }).flag.length, 0)
  assert.equal(calls, tasks.length, "no question, no conversation lookup")
})

test("current observation pages: own current windows, else current marks, never unknown ones", () => {
  const page = (state: string, id: string) => ({ id, requests: { state } })
  const store = (own: ReturnType<typeof page>[], marks: ReturnType<typeof page>[]) => ({ observations: () => own, markObservations: () => marks })
  assert.deepEqual(currentMissionObservations(store([page("observed", "own")], [page("observed", "mark")]), "i", "m").map(p => p.id), ["own"])
  // A superseded or failed own window neither counts nor hides current marks evidence.
  assert.deepEqual(currentMissionObservations(store([page("unknown", "own")], [page("observed", "mark")]), "i", "m").map(p => p.id), ["mark"])
  assert.deepEqual(currentMissionObservations(store([page("unknown", "own")], [page("unknown", "mark")]), "i", "m"), [])
  assert.deepEqual(currentMissionObservations(store([], [page("partial", "mark")]), "i", "m").map(p => p.id), ["mark"])
})

test("a proven native task conversation keeps its queued question when family coverage is unknown", () => {
  const forms = [{ id: "task-form", sessionID: "ses_native", title: "Task question", fields: [] },
    { id: "descendant-form", sessionID: "ses_unknown_child", title: "Unknown descendant", fields: [] },
    { id: "global-form", sessionID: "global", title: "Global", fields: [] }]
  const questions = nativeMissionQuestions({ actors: [{ sessionId: "ses_coordinator" }], family: { state: "unknown", members: [] }, forms, permissions: [],
    isTaskSession: id => id === "ses_native" })
  assert.deepEqual(questions.map(question => question.request.id), ["task-form"], "only exact task evidence, never unknown descendants or global requests")
  assert.equal(taskQuestion(mission, questions, { status: "dispatching" }, "ses_native"), questions[0], "its task row carries it")
})

test("a proven native task never changes the family's roots: its grandchild's question stays the coordinator family's", () => {
  const family = { state: "observed" as const, members: [
    { sessionId: "ses_coordinator", actorSessionId: "ses_coordinator", kind: "declared" as const },
    { sessionId: "ses_native", parentSessionId: "ses_coordinator", actorSessionId: "ses_coordinator", kind: "ordinary" as const },
    { sessionId: "ses_grandchild", parentSessionId: "ses_native", actorSessionId: "ses_coordinator", kind: "ordinary" as const }] }
  const forms = [{ id: "task-form", sessionID: "ses_native", title: "Task", fields: [] }, { id: "grand-form", sessionID: "ses_grandchild", title: "Grandchild", fields: [] }]
  const questions = nativeMissionQuestions({ actors: [{ sessionId: "ses_coordinator" }], family, forms, permissions: [], isTaskSession: id => id === "ses_native" })
  assert.deepEqual(questions.map(question => question.request.id).sort(), ["grand-form", "task-form"])
})
