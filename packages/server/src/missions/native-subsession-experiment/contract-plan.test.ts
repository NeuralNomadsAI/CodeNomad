import assert from "node:assert/strict"
import test from "node:test"
import { MissionJournal, stableToken, type MissionStorage } from "../journal"
import type { MissionEvent, MissionJsonValue, MissionLocation } from "../model"
import { createNativeContractPlans, Ref, Task, type Binding, type ContractTask, type EventPayload, type Reference } from "./contract-plan"

const location = { directory: "D:/fixture/worktree", workspaceID: "wrk_fixture" }
const missionID = "msn_contract_test", coordinatorID = "ses_coordinator"
const task = (key: string, options: Partial<ContractTask> = {}): ContractTask => ({ key, parentTaskKey: null, title: key, brief: "Bounded contract qualification", role: "worker", blockedBy: [], ...options })
const ref = (taskKey: string, revision = 1): Reference => ({ missionID, taskKey, revision })
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function fixture() {
  const values = new Map<string, MissionJsonValue>()
  const storage: MissionStorage = {
    get: async key => values.has(key) ? copy(values.get(key)!) : undefined,
    set: async (key, value) => { values.set(key, copy(value)) },
    scan: async ({ prefix, after, limit = 100 }) => {
      const keys = [...values.keys()].filter(key => key.startsWith(prefix) && (!after || key > after)).sort()
      const page = keys.slice(0, limit)
      return { entries: page.map(key => ({ key, value: copy(values.get(key)!) })), ...(keys.length > limit ? { next: page[page.length - 1]! } : {}) }
    },
  }
  const sessions = new Map<string, { id: string; parentID?: string; projectID: string; title: string; location: MissionLocation }>([[coordinatorID, { id: coordinatorID, projectID: "project_fixture", title: "coordinator", location }]])
  const journal = new MissionJournal(storage, "project_fixture", "D:/fixture/repository", () => 1)
  let clock = 100, active = true, writes = 0
  let failOnWrite = Number.POSITIVE_INFINITY
  const get = async <T>(key: string) => values.has("private/" + key) ? copy(values.get("private/" + key)!) as T : undefined
  const set = async (key: string, value: unknown) => {
    if (++writes === failOnWrite) throw new Error("Injected storage failure")
    values.set("private/" + key, copy(value) as MissionJsonValue)
  }
  const events: EventPayload[] = []
  const event = async (id: string, identity: string, payload: EventPayload) => {
    events.push(copy(payload))
    await journal.append({ version: 1, missionID: id, projectID: "project_fixture", id: "evt_" + stableToken(id + "\0" + identity, 32), createdAt: clock++, ...payload } as MissionEvent)
  }
  const deps = { get, set, event, snapshot: () => journal.snapshot(), session: { get: async ({ sessionID }: { sessionID: string }) => {
    const session = sessions.get(sessionID)
    if (!session) throw new Error("Unknown native session")
    return copy(session)
  } }, assertActive: () => { if (!active) throw new Error("Disposed") }, location: { ...location, project: { id: "project_fixture", canonical: "D:/fixture/repository" } } }
  const plans = createNativeContractPlans(deps)
  const seed = (tasks: ContractTask[]) => plans.seed({ missionID, coordinatorID, expectedRevision: 0, objective: "Initial fixture objective", tasks })
  const revise = (edits: Record<string, unknown> = {}) => plans.revise({ missionID, coordinatorID, expectedRevision: 1, requestID: "request-first", reason: "Explicit coordinator change", ...edits })
  const bind = async (taskKey: string, childID = "ses_" + taskKey, revision = 1, parentID = coordinatorID, depth = 1) => {
    const binding: Binding = { ...ref(taskKey, revision), parentID, childID, callID: "call_" + taskKey, messageID: "msg_" + taskKey, depth }
    const title = (await journal.snapshot()).missions[0]?.actors.find(actor => actor.sessionId === childID)?.title ?? taskKey
    sessions.set(childID, { id: childID, parentID, projectID: "project_fixture", title, location })
    await event(missionID, "bind-" + taskKey, { type: "task.native-bound", taskKey, actor: { sessionID: childID, title, location, managed: false }, binding: { generation: revision, parentSessionID: parentID, toolCallID: binding.callID, parentMessageID: binding.messageID } })
    await set(`owner/${missionID}/${taskKey}`, binding)
    await set(`binding/${parentID}/${binding.callID}`, binding)
    await set("current/" + childID, binding)
    return binding
  }
  const report = async (taskKey: string, revision = 1, late = false) => {
    const binding = await get<Binding>(`owner/${missionID}/${taskKey}`)
    const business = { id: "report_" + taskKey, contract: ref(taskKey, revision), sessionId: binding!.childID, outcome: "completed" as const, summary: "Explicit completion" }
    const { contract: _, ...businessReport } = business
    await event(missionID, "report-" + taskKey, { type: "task.reported", report: { ...businessReport, taskKey, evidence: [], next: [], createdAt: clock, ...(late ? { late: true } : {}) } })
    await set(`report/${missionID}/${taskKey}`, business)
  }
  return { plans, deps, values, get, set, seed, revise, bind, report, journal, sessions, events, dispose: () => { active = false }, failAfter: (count: number) => { failOnWrite = writes + count } }
}

test("seed preserves initial ABI, task schema, native root and shared business projection", async () => {
  const f = fixture(), input = [task("parent"), task("child", { parentTaskKey: "parent" })]
  assert.deepEqual(await f.seed(input), { missionID, revision: 1 })
  const { plan, task: contract } = await f.plans.planFor(ref("parent"))
  assert.deepEqual(plan.tasks, input)
  assert.equal("generation" in contract, false)
  assert.equal("revision" in contract, false)
  assert.equal(plan.generations.parent, 1)
  const mission = (await f.journal.snapshot()).missions[0]
  assert.equal(mission.revision, 3)
  assert.equal(mission.projectCanonical, "D:/fixture/repository")
  assert.equal((await f.plans.admitted(ref("parent"), coordinatorID)).depth, 1)
  const parentBinding = await f.bind("parent")
  assert.equal(await f.plans.isCurrent(parentBinding), true)
  assert.equal((await f.plans.admitted(ref("child"), "ses_parent")).depth, 2)
  assert.deepEqual(await f.seed(input), { missionID, revision: 1 })
  assert.equal(f.events.length, 4)
  await assert.rejects(f.seed([task("different")]), /identity conflict/)
})

test("task generations are independent of unrelated plan edits and journal events", async () => {
  const f = fixture()
  await f.seed([task("parent"), task("child", { parentTaskKey: "parent", blockedBy: ["sibling"] }), task("sibling")])
  await f.revise({ dependencyUpdates: [{ taskKey: "child", blockedBy: [] }] })
  assert.equal((await f.plans.planFor(ref("child", 2))).plan.revision, 2)
  assert.equal(await f.plans.isCurrent(ref("parent")), true)
  await assert.rejects(f.plans.planFor(ref("child")), /stale task generation/)
  assert.deepEqual((await f.plans.planFor(ref("child"), { historical: true })).task.blockedBy, ["sibling"])
  await f.bind("parent")
  assert.equal((await f.plans.admitted(ref("child", 2), "ses_parent")).depth, 2)
  await f.revise({ expectedRevision: 2, requestID: "unrelated", retireTasks: [{ taskKey: "sibling" }] })
  assert.equal(await f.plans.isCurrent(ref("child", 2)), true)
  assert.equal((await f.plans.admitted(ref("child", 2), "ses_parent")).depth, 2)
  const revised = f.events.filter((event): event is Extract<EventPayload, { type: "mission.revised" }> => event.type === "mission.revised")
  assert.deepEqual(revised.map(event => event.expectedRevision), [4, 6])
})

test("retire/replacement retains outstanding execution and admits only the replacement", async () => {
  const f = fixture()
  await f.seed([task("oldtask"), task("waiting", { blockedBy: ["oldtask"] })])
  await f.bind("oldtask")
  const oldContract = (await f.plans.planFor(ref("oldtask"))).task
  await f.revise({ retireTasks: [{ taskKey: "oldtask", replacementTaskKey: "newtask" }], addTasks: [{ ...task("newtask", { execution: { agent: "research", model: { providerID: "fixture", id: "reasoner", variant: "fast" } } }), replacesTaskKey: "oldtask" }], dependencyUpdates: [{ taskKey: "waiting", blockedBy: ["newtask"] }] })
  assert.equal(await f.plans.isCurrent(ref("oldtask")), false)
  await assert.rejects(f.plans.admitted(ref("oldtask"), coordinatorID), /Retired/)
  assert.deepEqual((await f.plans.planFor(ref("oldtask"), { historical: true })).task, oldContract)
  let mission = (await f.journal.snapshot()).missions[0]
  assert.equal(mission.tasks.find(task => task.key === "oldtask")!.outstandingExecution, true)
  assert.deepEqual(mission.tasks.find(task => task.key === "newtask")!.execution, { agent: "research", model: { providerID: "fixture", id: "reasoner", variant: "fast" } })
  await f.report("oldtask", 1, true)
  mission = (await f.journal.snapshot()).missions[0]
  assert.equal(mission.tasks.find(task => task.key === "oldtask")!.outstandingExecution, false)
  assert.equal(mission.tasks.find(task => task.key === "oldtask")!.status, "withdrawn")
  await assert.rejects(f.plans.admitted(ref("waiting", 2), coordinatorID), /current generation/)
})

test("dependency completions require exact current-generation report references", async () => {
  const f = fixture()
  await f.seed([task("dependency", { blockedBy: ["another"] }), task("another"), task("dependent", { blockedBy: ["dependency"] })])
  await f.revise({ dependencyUpdates: [{ taskKey: "dependency", blockedBy: [] }] })
  await f.set(`report/${missionID}/dependency`, { contract: ref("dependency"), outcome: "completed" })
  await assert.rejects(f.plans.admitted(ref("dependent"), coordinatorID), /current generation/)
  await f.set(`report/${missionID}/dependency`, { outcome: "completed" })
  await assert.rejects(f.plans.admitted(ref("dependent"), coordinatorID), /current generation/)
  await f.bind("dependency", "ses_dependency", 2)
  await f.report("dependency", 2)
  assert.deepEqual((await f.get<{ contract: Reference }>(`report/${missionID}/dependency`))!.contract, ref("dependency", 2))
  assert.equal("contract" in (await f.journal.snapshot()).missions[0].reports[0], false)
  assert.equal((await f.plans.admitted(ref("dependent"), coordinatorID)).depth, 1)
})

test("assigned and completed tasks cannot change dependencies but may be retired", async () => {
  for (const completed of [false, true]) {
    const f = fixture()
    await f.seed([task("worker"), task("another")])
    await f.bind("worker")
    if (completed) await f.report("worker")
    await assert.rejects(f.revise({ dependencyUpdates: [{ taskKey: "worker", blockedBy: ["another"] }] }), /after dispatch or completion/)
    await f.revise({ retireTasks: [{ taskKey: "worker" }] })
    assert.equal((await f.journal.snapshot()).missions[0].tasks.find(task => task.key === "worker")!.outstandingExecution, !completed)
  }
})

test("revisions have stable exact retries and independent document revisions", async () => {
  const f = fixture()
  await f.seed([task("first"), task("second"), task("third")])
  const edit = { retireTasks: [{ taskKey: "first" }] }
  assert.deepEqual(await f.revise(edit), { missionID, revision: 2 })
  const count = f.events.length
  assert.deepEqual(await f.revise(edit), { missionID, revision: 2 })
  assert.equal(f.events.length, count)
  await assert.rejects(f.revise({ ...edit, reason: "Different" }), /identity conflict/)
  await assert.rejects(f.revise({ requestID: "fresh", retireTasks: [{ taskKey: "second" }] }), /document revision conflict/)
  await f.revise({ expectedRevision: 2, requestID: "second-edit", retireTasks: [{ taskKey: "second" }] })
  assert.deepEqual(await f.revise(edit), { missionID, revision: 2 })
  assert.deepEqual(await f.seed([task("first"), task("second"), task("third")]), { missionID, revision: 1 })
})

test("coordinator and native Location identities cannot be self-granted or moved", async () => {
  const f = fixture()
  f.sessions.set("ses_intruder", { id: "ses_intruder", projectID: "project_fixture", title: "intruder", location })
  await f.seed([task("first")])
  await assert.rejects(f.revise({ coordinatorID: "ses_intruder", retireTasks: [{ taskKey: "first" }] }), /Only the coordinator/)
  f.sessions.get(coordinatorID)!.location = { directory: "D:/other" }
  await assert.rejects(f.revise({ retireTasks: [{ taskKey: "first" }] }), /admitted Location/)
  await assert.rejects(f.seed([task("first")]), /admitted Location/)
  const childRoot = fixture()
  childRoot.sessions.get(coordinatorID)!.parentID = "ses_parent"
  await assert.rejects(childRoot.seed([task("first")]), /owned coordinator root/)
  const foreign = fixture()
  foreign.sessions.get(coordinatorID)!.projectID = "foreign_project"
  await assert.rejects(foreign.seed([task("first")]), /owned coordinator root/)
})

test("explicit same-child reuse requires an owned predecessor and matching replacement topology", async () => {
  const f = fixture()
  await f.seed([task("oldtask"), task("other")]); await f.bind("oldtask")
  await assert.rejects(f.revise({ retireTasks: [{ taskKey: "oldtask", replacementTaskKey: "newtask" }], addTasks: [{ ...task("newtask", { reuseFromTaskKey: "other" }), replacesTaskKey: "oldtask" }] }), /no owned native actor/)
  await f.revise({ retireTasks: [{ taskKey: "oldtask", replacementTaskKey: "newtask" }], addTasks: [{ ...task("newtask", { reuseFromTaskKey: "oldtask" }), replacesTaskKey: "oldtask" }] })
  assert.equal((await f.plans.planFor(ref("newtask"))).task.reuseFromTaskKey, "oldtask")
  assert.equal((await f.get<Binding>("current/ses_oldtask"))!.taskKey, "oldtask", "revision never impersonates a native executor or rebinds a child")
  await assert.rejects(f.plans.admitted(ref("oldtask"), coordinatorID), /Retired/)
  await f.bind("newtask", "ses_oldtask")
  await f.report("oldtask", 1, true)
  await f.report("newtask")
  const mission = (await f.journal.snapshot()).missions[0]
  assert.equal(mission.tasks.find(task => task.key === "oldtask")!.outstandingExecution, false)
  assert.equal(mission.tasks.find(task => task.key === "newtask")!.status, "completed")
  assert.equal(mission.actors.find(actor => actor.sessionId === "ses_oldtask")!.title, "oldtask")
  assert.equal((await f.journal.snapshot()).discardedEvents, 0)
})

test("replacing unused work may independently authorize the running investigator as exact actor source", async () => {
  const f = fixture()
  await f.seed([task("investigate"), task("obsolete"), task("nested", { parentTaskKey: "investigate", blockedBy: ["gate"] }), task("gate")])
  const binding = await f.bind("investigate")
  const previousTask = (await f.plans.planFor(ref("investigate"))).task
  const previousProjection = (await f.journal.snapshot()).missions[0].tasks.find(task => task.key === "investigate")!
  const previousHistory = await f.get(`history/${missionID}/investigate/1`)
  assert.equal(previousProjection.status, "queued")
  assert.equal(previousProjection.report, undefined)
  assert.equal(previousProjection.nativeBinding!.nativeReturned, undefined)
  assert.equal(await f.get(`returned/${binding.parentID}/${binding.callID}`), undefined)

  const revision = { retireTasks: [{ taskKey: "obsolete", replacementTaskKey: "implement" }], addTasks: [{ ...task("implement", { reuseFromTaskKey: "investigate" }), replacesTaskKey: "obsolete" }] }
  assert.deepEqual(await f.revise(revision), { missionID, revision: 2 })
  const { plan, task: implementation } = await f.plans.planFor(ref("implement"))
  assert.equal(implementation.reuseFromTaskKey, "investigate")
  assert.equal(plan.generations.implement, 1)
  assert.equal(plan.generations.investigate, 1)
  assert.deepEqual((await f.plans.planFor(ref("investigate"))).task, previousTask)
  assert.deepEqual((await f.journal.snapshot()).missions[0].tasks.find(task => task.key === "investigate"), previousProjection)
  assert.deepEqual(await f.get(`history/${missionID}/investigate/1`), previousHistory)
  assert.deepEqual(await f.get(`owner/${missionID}/investigate`), binding)
  assert.deepEqual(await f.get("current/" + binding.childID), binding)
  assert.equal(await f.get(`owner/${missionID}/implement`), undefined, "revision authorization is not native continuation")
  assert.equal((await f.journal.snapshot()).missions[0].tasks.find(task => task.key === "obsolete")!.status, "withdrawn")

  await f.revise({ expectedRevision: 2, requestID: "nested-edit", dependencyUpdates: [{ taskKey: "nested", blockedBy: [] }] })
  assert.equal((await f.plans.admitted(ref("nested", 2), binding.childID)).depth, 2)
  assert.equal(await f.plans.isCurrent(binding), true)
  await f.report("investigate")
  const savedReport = await f.get(`report/${missionID}/investigate`)
  assert.deepEqual(await f.revise(revision), { missionID, revision: 2 })
  assert.deepEqual(await f.get(`report/${missionID}/investigate`), savedReport)
  assert.equal((await f.journal.snapshot()).missions[0].tasks.find(task => task.key === "investigate")!.status, "completed")
  assert.deepEqual(await f.get(`history/${missionID}/investigate/1`), previousHistory)
})

test("independent actor reuse rejects missing, foreign and mismatched source evidence before persistence", async () => {
  const cases = ["missing", "unowned", "foreign-owner", "stale-generation", "wrong-parent", "foreign-session", "mismatched-journal", "wrong-current"] as const
  for (const scenario of cases) {
    const f = fixture()
    await f.seed([task("investigate"), task("obsolete"), task("unowned"), task("parent")])
    const binding = await f.bind("investigate")
    let reuseFromTaskKey = "investigate", parentTaskKey: string | null = null
    if (scenario === "missing") reuseFromTaskKey = "not-in-this-mission"
    if (scenario === "unowned") reuseFromTaskKey = "unowned"
    if (scenario === "foreign-owner") await f.set(`owner/${missionID}/investigate`, { ...binding, missionID: "msn_foreign" })
    if (scenario === "stale-generation") await f.set(`owner/${missionID}/investigate`, { ...binding, revision: 2 })
    if (scenario === "wrong-parent") parentTaskKey = "parent"
    if (scenario === "foreign-session") f.sessions.get(binding.childID)!.projectID = "foreign_project"
    if (scenario === "mismatched-journal") await f.set(`owner/${missionID}/investigate`, { ...binding, callID: "different_call" })
    if (scenario === "wrong-current") await f.set("current/" + binding.childID, { ...binding, taskKey: "obsolete" })
    const count = f.events.length
    await assert.rejects(f.revise({ retireTasks: [{ taskKey: "obsolete", replacementTaskKey: "implement" }], addTasks: [{ ...task("implement", { parentTaskKey, reuseFromTaskKey }), replacesTaskKey: "obsolete" }] }), /Reuse/)
    assert.equal(f.events.length, count, scenario)
    assert.equal((await f.plans.planFor(ref("obsolete"))).plan.revision, 1, scenario)
  }
})

test("invalid bounded graphs, duplicates and replacement shapes never write events", async () => {
  const invalid = [
    [task("duplicate"), task("duplicate")],
    [task("first", { blockedBy: ["missing"] })],
    [task("first", { blockedBy: ["first"] })],
    [task("first", { blockedBy: ["second", "second"] }), task("second")],
    [task("first", { parentTaskKey: "missing" })],
    [task("first", { parentTaskKey: "second" }), task("second", { parentTaskKey: "first" })],
    [task("first", { blockedBy: ["second"] }), task("second", { blockedBy: ["first"] })],
    [task("first", { blockedBy: ["second"] }), task("second", { parentTaskKey: "first" })],
    [task("first"), task("second", { parentTaskKey: "first" }), task("third", { parentTaskKey: "second" }), task("fourth", { parentTaskKey: "third" })],
  ]
  for (const tasks of invalid) {
    const f = fixture()
    await assert.rejects(f.seed(tasks))
    assert.equal(f.events.length, 0)
  }
  const f = fixture()
  await f.seed([task("first"), task("second", { blockedBy: ["first"] })])
  await assert.rejects(f.revise({ retireTasks: [{ taskKey: "first" }] }), /retired/)
  await assert.rejects(f.revise({ addTasks: [{ ...task("newtask"), replacesTaskKey: "first" }] }), /Replacement must match/)
  await assert.rejects(f.revise({ retireTasks: [{ taskKey: "first", replacementTaskKey: "newtask" }] }), /replacement/)
  await assert.rejects(f.revise(), /Empty/)
})

test("schema rejects hidden authority fields and delegates execution validation to shared parser", () => {
  assert.throws(() => Ref.parse({ ...ref("task"), coordinatorID }), /unrecognized_keys|Unrecognized/)
  assert.throws(() => Task.parse({ ...task("first"), generation: 2 }), /unrecognized_keys|Unrecognized/)
  assert.throws(() => Task.parse(task("first", { execution: { agent: " " } })), /identifier/)
  assert.throws(() => Task.parse({ ...task("first"), execution: { apiKey: "not-allowed" } }), /Unknown execution field/)
  assert.throws(() => Task.parse({ ...task("first"), execution: { model: { providerID: "fixture", id: "model", token: "not-allowed" } } }), /Unknown model field/)
})

test("pending or damaged persistence fails closed, including exact retries", async () => {
  for (const failAfter of [2, 3, 4, 5]) {
    const f = fixture()
    f.failAfter(failAfter)
    await assert.rejects(f.seed([task("first")]), /storage failure/)
    await assert.rejects(f.plans.planFor(ref("first")), /partial|Partial/)
    await assert.rejects(f.seed([task("first")]), /partial|Partial/)
  }
  const f = fixture()
  await f.seed([task("first"), task("second")])
  f.failAfter(2)
  await assert.rejects(f.revise({ retireTasks: [{ taskKey: "first" }] }), /storage failure/)
  await assert.rejects(f.plans.planFor(ref("second")), /Partial/)
  await assert.rejects(f.revise({ retireTasks: [{ taskKey: "first" }] }), /Partial/)
  const damaged = fixture()
  await damaged.seed([task("first")])
  damaged.values.delete(`private/history/${missionID}/first/1`)
  await assert.rejects(damaged.plans.planFor(ref("first")))
  damaged.dispose()
  await assert.rejects(damaged.plans.isCurrent(ref("first")), /Disposed/)
})

test("unknown journal updates and stopped lifecycle confer no current privileges", async () => {
  const f = fixture()
  await f.seed([task("first")])
  await f.deps.event(missionID, "stopped", { type: "mission.finished", outcome: "failed", summary: "Fixture terminal state" })
  await assert.rejects(f.plans.admitted(ref("first"), coordinatorID), /not running/)
  assert.equal((await f.plans.planFor(ref("first"), { historical: true })).task.key, "first")
  await assert.rejects(f.revise({ retireTasks: [{ taskKey: "first" }] }), /not running/)
  const g = fixture()
  await g.seed([task("first")])
  await g.deps.event(missionID, "outside-task", { type: "task.created", task: { id: "task_outside", key: "outside", title: "Outside", brief: "Not in contract", role: "worker", blockedBy: [] } })
  await assert.rejects(g.plans.planFor(ref("first")), /Partial contract/)
})

test("partial parent current/owner/call state cannot delegate without accepted native binding", async () => {
  const f = fixture()
  await f.seed([task("parent"), task("child", { parentTaskKey: "parent" })])
  const binding: Binding = { ...ref("parent"), parentID: coordinatorID, childID: "ses_parent", callID: "call_parent", messageID: "msg_parent", depth: 1 }
  f.sessions.set("ses_parent", { id: "ses_parent", parentID: coordinatorID, projectID: "project_fixture", title: "parent", location })
  await f.set("current/ses_parent", binding)
  await assert.rejects(f.plans.admitted(ref("child"), "ses_parent"))
  await f.set(`owner/${missionID}/parent`, binding)
  await f.set(`binding/${coordinatorID}/call_parent`, binding)
  await assert.rejects(f.plans.admitted(ref("child"), "ses_parent"), /native admission evidence/)
  await f.bind("parent")
  assert.equal((await f.plans.admitted(ref("child"), "ses_parent")).depth, 2)
  await f.set(`binding/${coordinatorID}/call_parent`, { ...binding, messageID: "wrong_message" })
  await assert.rejects(f.plans.admitted(ref("child"), "ses_parent"), /native admission evidence/)
})

test("a current-generation private report without accepted business event cannot unlock work", async () => {
  const f = fixture()
  await f.seed([task("dependency"), task("dependent", { blockedBy: ["dependency"] })])
  await f.bind("dependency")
  await f.set(`report/${missionID}/dependency`, { id: "report_dependency", contract: ref("dependency"), sessionId: "ses_dependency", outcome: "completed", summary: "Unaccepted" })
  await assert.rejects(f.plans.admitted(ref("dependent"), coordinatorID), /journal evidence/)
  await f.report("dependency")
  assert.equal((await f.plans.admitted(ref("dependent"), coordinatorID)).depth, 1)
  await f.set(`report/${missionID}/dependency`, { id: "different_report", contract: ref("dependency"), sessionId: "ses_dependency", outcome: "completed" })
  await assert.rejects(f.plans.admitted(ref("dependent"), coordinatorID), /journal evidence/)
})

test("no-op dependencies never advance generations or appear in accepted revision events", async () => {
  const f = fixture()
  await f.seed([task("first"), task("second"), task("third")])
  await assert.rejects(f.revise({ dependencyUpdates: [{ taskKey: "second", blockedBy: [] }] }), /Empty effective/)
  assert.equal(f.events.length, 4)
  await f.revise({ retireTasks: [{ taskKey: "first" }], dependencyUpdates: [{ taskKey: "second", blockedBy: [] }] })
  assert.equal((await f.plans.planFor(ref("second"))).plan.generations.second, 1)
  const event = f.events[f.events.length - 1]
  assert.equal(event.type, "mission.revised")
  if (event.type === "mission.revised") assert.deepEqual(event.dependencyUpdates, [])
  await f.bind("second")
  assert.equal((await f.journal.snapshot()).discardedEvents, 0)
})

test("replacement targets are one-to-one and newly added tasks start at generation one", async () => {
  const f = fixture()
  await f.seed([task("first"), task("second"), task("parent")])
  await f.bind("parent")
  await assert.rejects(f.revise({ retireTasks: [{ taskKey: "first", replacementTaskKey: "newtask" }, { taskKey: "second", replacementTaskKey: "newtask" }], addTasks: [{ ...task("newtask", { parentTaskKey: "parent" }), replacesTaskKey: "first" }] }), /exactly one retired/)
  await f.revise({ retireTasks: [{ taskKey: "first", replacementTaskKey: "newtask" }], addTasks: [{ ...task("newtask", { parentTaskKey: "parent" }), replacesTaskKey: "first" }] })
  const { plan } = await f.plans.planFor(ref("newtask"))
  assert.equal(plan.revision, 2)
  assert.equal(plan.generations.parent, 1)
  assert.equal(plan.generations.newtask, 1)
  assert.equal((await f.plans.admitted(ref("newtask"), "ses_parent")).depth, 2)
  await f.bind("newtask", "ses_newtask", 1, "ses_parent", 2)
  assert.equal((await f.journal.snapshot()).discardedEvents, 0)
})

test("external shared retirement never retains private delegation privilege", async () => {
  const f = fixture()
  await f.seed([task("first")])
  await f.deps.event(missionID, "shared-retire", { type: "mission.revised", requestID: "shared-retire", expectedRevision: 2, actorSessionID: coordinatorID, reason: "External retirement", notesSpecified: false, retiredTasks: [{ taskKey: "first" }], addedTasks: [], dependencyUpdates: [] })
  assert.equal(await f.plans.isCurrent(ref("first")), false)
  await assert.rejects(f.plans.admitted(ref("first"), coordinatorID), /Retired/)
  assert.equal((await f.plans.planFor(ref("first"), { historical: true })).current, false)
  await assert.rejects(f.revise({ retireTasks: [{ taskKey: "first" }] }), /already retired/)
})

test("missing latest request receipt and journal damage fail closed", async () => {
  const f = fixture()
  await f.seed([task("first")])
  f.values.delete(`private/request/${missionID}/seed`)
  await assert.rejects(f.plans.planFor(ref("first")))
  const g = fixture()
  await g.seed([task("first")])
  const entries = [...g.values.keys()].filter(key => key.startsWith("codenomad-missions/v2/"))
  assert.ok(entries.length)
  g.values.set(entries[0], "damaged_entry")
  await assert.rejects(g.plans.planFor(ref("first")), /Damaged mission journal/)
})

test("task and event caps reject bounded mutations without writing native effects", async () => {
  const f = fixture()
  await assert.rejects(f.seed(Array.from({ length: 97 }, (_, index) => task("task-" + index))))
  assert.equal(f.events.length, 0)
  const capped = createNativeContractPlans({ ...f.deps, snapshot: async () => ({ version: 1, projectID: "project_fixture", generatedAt: 1, missions: Array.from({ length: 20 }, (_, index) => ({ revision: 100, id: "msn_" + index })) as Awaited<ReturnType<typeof f.deps.snapshot>>["missions"], discardedEvents: 0 }) })
  await assert.rejects(capped.seed({ missionID, coordinatorID, expectedRevision: 0, objective: "Limit test", tasks: [task("first")] }), /mission limit/)
  const eventsCapped = createNativeContractPlans({ ...f.deps, snapshot: async () => ({ version: 1, projectID: "project_fixture", generatedAt: 1, missions: [{ revision: 2000, id: "msn_other" }] as Awaited<ReturnType<typeof f.deps.snapshot>>["missions"], discardedEvents: 0 }) })
  await assert.rejects(eventsCapped.seed({ missionID, coordinatorID, expectedRevision: 0, objective: "Limit test", tasks: [task("first")] }), /event safety limit/)
  assert.equal(f.events.length, 0)
})
