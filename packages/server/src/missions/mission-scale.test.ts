import assert from "node:assert/strict"
import test from "node:test"
import Ajv from "ajv"
import { MissionControl } from "./control"
import type { MissionInputTransport, NativeMissionSession } from "./control-types"
import { MISSION_JOURNAL_STORAGE_PREFIX, MissionJournal, parseMissionEvent, type MissionStorage } from "./journal"
import { MISSION_CONTROL_CONCURRENCY } from "./lifecycle"
import { MISSION_INSPECT_OUTPUT_LIMIT, boundedInspection } from "./inspect-view"
import { MISSION_MAX_EVENTS, missionLifecycleReserve, type MissionJsonValue, type MissionMap } from "./model"
import { readMissionCatalog } from "./native-catalog"
import { controlResumeAdmissionID } from "./receipt-identity"
import { CODENOMAD_MISSIONS_RPC } from "./rpc"
import { parseReviseInput, setupMissionsPlugin } from "../opencode/missions-plugin"

const PROJECT = { id: "project-1", canonical: "/repo", location: { directory: "/repo" } }
const ACTORS = 40
const TASKS = 500

function fixture() {
  const values = new Map<string, MissionJsonValue>()
  const storage: MissionStorage = {
    get: async key => structuredClone(values.get(key)),
    set: async (key, value) => { values.set(key, structuredClone(value)) },
    scan: async ({ prefix, after, limit = 100 }) => {
      const keys = [...values.keys()].filter(key => key.startsWith(prefix) && (!after || key > after)).sort().slice(0, limit)
      return { entries: keys.map(key => ({ key, value: structuredClone(values.get(key)!) })), next: keys.length === limit ? keys.at(-1) : undefined }
    },
  }
  const native = new Map<string, NativeMissionSession>()
  const calls: Array<{ action: string; sessionID: string }> = []
  const cleaned: string[] = []
  const flight = { now: 0, peak: 0 }
  let now = 1_000
  const transport: MissionInputTransport = {
    prompt: async () => {},
    synthetic: async () => {},
    lifecycle: async (_, input) => {
      flight.peak = Math.max(flight.peak, ++flight.now)
      try {
        // Each target is a slow native family walk in production: let others overlap.
        await new Promise(resolve => setTimeout(resolve, 5))
        const mission = (await control().snapshot()).missions.find(item => item.id === input.missionID)!
        const action = mission.control!.action, identity = { ...input, action }
        calls.push({ action, sessionID: input.sessionID })
        return { nativeAcknowledgement: action === "start" ? { ...identity, disposition: "start-admitted", admission: {
          id: controlResumeAdmissionID(input.operationID, input.sessionID), sessionID: input.sessionID, type: "synthetic", delivery: "queue", time: { created: 100 },
          payload: { text: "Continue existing work", metadata: { "codenomad.mission": { version: 1, missionID: input.missionID, operationID: input.operationID, kind: "lifecycle" } } },
        } } : { ...identity, disposition: "interrupt-observed", interrupt: { interrupted: true }, cancellations: [] } }
      } finally { flight.now-- }
    },
    cleanup: async (_, input) => { cleaned.push(input.sessionID); return { outcome: "removed" } },
  }
  const control = () => new MissionControl({ project: PROJECT, storage, now: () => now++, transport, sessions: {
    get: async ({ sessionID }) => { if (!native.has(sessionID)) throw new Error("missing"); return native.get(sessionID)! },
    create: async input => { const session = { ...input, projectID: PROJECT.id }; native.set(session.id, session); return session },
    prompt: async () => { throw new Error("Transport required") }, synthetic: async () => { throw new Error("Transport required") },
  } })
  const journal = new MissionJournal(storage, PROJECT.id, PROJECT.canonical)
  const range = (missionID: string) => [...values.keys()].filter(key => key.startsWith(`${MISSION_JOURNAL_STORAGE_PREFIX}/${journal.projectToken}/${missionID}/`)).length
  const current = async (missionID: string) => (await control().snapshot()).missions.find(mission => mission.id === missionID)!
  let requests = 0
  const lifecycle = async (mission: MissionMap, action: "start" | "pause" | "stop", graceful?: true) => {
    calls.length = 0; flight.peak = 0
    return (await control().lifecycle({ missionID: mission.id, action, expectedRevision: mission.revision, requestID: `${action}-${++requests}`,
      ...(graceful ? { graceful } : {}) })).mission
  }
  /** Fills the mission's range with valid edits from another writer, leaving `room` entries. */
  const fill = (mission: MissionMap, room: number) => {
    const prefix = `${MISSION_JOURNAL_STORAGE_PREFIX}/${journal.projectToken}/${mission.id}`
    for (let index = 0; range(mission.id) < MISSION_MAX_EVENTS - room; index++) {
      const event = { version: 1, id: `evt_fill_${String(index).padStart(4, "0")}`, type: "mission.updated", missionID: mission.id, projectID: PROJECT.id,
        requestID: `fill-${index}`, expectedRevision: mission.revision + index, notesSpecified: false, objective: "Filled", createdAt: 1_000_000 + index }
      values.set(`${prefix}/${event.id}`, event)
    }
  }
  /** A running mission with `ACTORS` actors: the coordinator and one managed root per independent task. */
  const crowded = async () => {
    let mission = (await control().create({ requestID: "crowded", objective: "Many actors", template: "custom" })).mission
    for (let index = 1; index < ACTORS; index++) {
      mission = (await control().delegate(mission.coordinatorSessionId, { missionID: mission.id, taskKey: `actor-${index}`, title: `Actor ${index}`,
        brief: `Independent work ${index}`, role: "worker", blockedBy: [], delivery: "queue" })).mission
    }
    return mission
  }
  return { values, storage, native, calls, cleaned, flight, control, journal, range, current, lifecycle, fill, crowded }
}

test(`a mission of ${ACTORS} actors and ${TASKS} tasks is planned, reported, controlled, read and deleted with cleanup`, { timeout: 300_000 }, async () => {
  const f = fixture()
  let mission = await f.crowded()
  assert.equal(mission.actors.length, ACTORS)
  const coordinator = mission.coordinatorSessionId
  // The rest of the plan, 24 declared tasks per revision, with briefs that make the full map large.
  for (let added = mission.tasks.length; added < TASKS;) {
    const addTasks = Array.from({ length: Math.min(24, TASKS - added) }, (_, i) => ({ taskKey: `planned-${added + i}`, title: `Planned ${added + i}`,
      brief: `Planned work ${added + i}. ${"Detail ".repeat(200)}`, role: "worker", blockedBy: [] }))
    mission = (await f.control().revise(coordinator, { missionID: mission.id, expectedRevision: mission.revision, requestID: `plan-${added}`,
      reason: "More work", retireTasks: [], addTasks, dependencyUpdates: [] })).mission
    added += addTasks.length
  }
  assert.equal(mission.tasks.length, TASKS)
  // One revision rewires 120 dependents, then retiring their blocker repoints all of them at once.
  const dependents = mission.tasks.filter(task => task.key.startsWith("planned-")).slice(1, 121).map(task => task.key)
  mission = (await f.control().revise(coordinator, { missionID: mission.id, expectedRevision: mission.revision, requestID: "rewire",
    reason: "Order the work", retireTasks: [], addTasks: [], dependencyUpdates: dependents.map(taskKey => ({ taskKey, blockedBy: [`planned-${ACTORS - 1}`] })) })).mission
  assert.equal(mission.history.at(-1)?.dependencyUpdates.length, 120)
  mission = (await f.control().revise(coordinator, { missionID: mission.id, expectedRevision: mission.revision, requestID: "retire-blocker",
    reason: "Merged", retireTasks: [{ taskKey: `planned-${ACTORS - 1}` }], addTasks: [], dependencyUpdates: dependents.map(taskKey => ({ taskKey, blockedBy: [] })) })).mission
  assert.ok(mission.tasks.filter(task => dependents.includes(task.key)).every(task => task.blockedBy.length === 0))
  // Business readouts for many tasks, and independent actors' own reports.
  for (const task of mission.tasks.filter(task => task.key.startsWith("planned-") && task.status === "ready").slice(0, 100)) {
    mission = (await f.control().report(coordinator, { missionID: mission.id, taskKey: task.key, outcome: "completed",
      summary: `Done ${task.key}. ${"Result ".repeat(150)}`, evidence: ["Checked"], next: [], final: false })).mission
  }
  for (const task of mission.tasks.filter(task => task.key.startsWith("actor-")).slice(0, 5)) {
    mission = (await f.control().report(task.actorSessionId!, { missionID: mission.id, taskKey: task.key, outcome: "completed",
      summary: `Actor done ${task.key}`, evidence: [], next: [], final: false })).mission
  }
  assert.equal(mission.reports.length, 105)
  assert.equal((await f.control().snapshot()).discardedEvents, 0)

  // A graceful Pause interrupts nothing and settles at once, whatever the actor count.
  mission = await f.lifecycle(await f.current(mission.id), "pause", true)
  assert.deepEqual([mission.runState, f.calls.length, mission.control?.targets.length, mission.control?.pending.length], ["paused", 0, 0, 0])
  // Interrupt now, Play and Stop reach every root in bounded waves.
  mission = await f.lifecycle(mission, "pause")
  assert.equal(mission.runState, "paused")
  assert.equal(f.calls.filter(call => call.action === "pause").length, ACTORS)
  assert.ok(f.flight.peak > 1 && f.flight.peak <= MISSION_CONTROL_CONCURRENCY, `peak ${f.flight.peak}`)
  assert.deepEqual([mission.control?.pending, mission.control?.receipts?.length], [[], ACTORS])
  // The typed RPC outputs accept a map with that many actors, tasks and receipts.
  const ajv = new Ajv({ allErrors: true })
  const lifecycleOutput = ajv.compile(CODENOMAD_MISSIONS_RPC.methods.lifecycle.output)
  assert.ok(lifecycleOutput(JSON.parse(JSON.stringify({ mission }))), JSON.stringify(lifecycleOutput.errors))
  mission = await f.lifecycle(mission, "start")
  assert.equal(mission.runState, "running")
  assert.equal(f.calls.length, ACTORS - 5, "the coordinator and every actor with unreported work resume")
  assert.ok(f.flight.peak <= MISSION_CONTROL_CONCURRENCY)

  // The panel's reads carry the compact map, every task row, and the mission's row.
  const list = await f.control().list({ include: [mission.id] })
  assert.equal(list.missions.find(item => item.id === mission.id)?.tasks.length, TASKS)
  assert.equal(list.summaries?.find(item => item.id === mission.id)?.actorSessionIds.length, ACTORS)
  assert.equal((await f.control().mission(mission.id)).mission?.tasks.length, TASKS)
  const listOutput = ajv.compile(CODENOMAD_MISSIONS_RPC.methods.list.output)
  assert.ok(listOutput(JSON.parse(JSON.stringify(list))), JSON.stringify(listOutput.errors))

  // mission.inspect stays bounded and pages every task exactly once, in map order.
  const full = await f.control().inspect(coordinator, { missionID: mission.id }, "inspect")
  assert.ok(JSON.stringify(full, null, 2).length > 5 * MISSION_INSPECT_OUTPUT_LIMIT)
  type Page = { mission: MissionMap; taskPage: { offset: number; nextTaskOffset?: number; total: number } }
  const header = boundedInspection(full) as Page & { playbook?: unknown }
  assert.ok(JSON.stringify(header, null, 2).length <= MISSION_INSPECT_OUTPUT_LIMIT)
  assert.deepEqual([header.mission.objective, header.mission.actors.length, header.mission.frontier], [mission.objective, ACTORS, full.mission!.frontier])
  assert.ok(header.playbook)
  const seen = header.mission.tasks.map(task => task.key)
  for (let offset = header.taskPage.nextTaskOffset, pages = 0; offset !== undefined; pages++) {
    assert.ok(pages < TASKS)
    const page = boundedInspection(full, offset) as Page
    assert.ok(JSON.stringify(page, null, 2).length <= MISSION_INSPECT_OUTPUT_LIMIT)
    assert.equal(page.taskPage.total, TASKS)
    assert.ok(page.mission.tasks.length > 1 || page.taskPage.nextTaskOffset === undefined, `page at ${offset}: ${page.mission.tasks.length} task(s)`)
    assert.equal(page.mission.reports, undefined, "tasks carry their reports")
    seen.push(...page.mission.tasks.map(task => task.key))
    offset = page.taskPage.nextTaskOffset
  }
  assert.deepEqual(seen, full.mission!.tasks.map(task => task.key))

  mission = await f.lifecycle(await f.current(mission.id), "stop")
  assert.equal(mission.status, "stopped")
  assert.equal(f.calls.filter(call => call.action === "stop").length, ACTORS)
  assert.ok(f.flight.peak > 1 && f.flight.peak <= MISSION_CONTROL_CONCURRENCY)

  const deleted = await f.control().delete({ missionID: mission.id, requestID: "delete", expectedRevision: mission.revision, deleteManagedSessions: true })
  assert.equal(deleted.cleanup?.removed, ACTORS - 1)
  assert.equal(f.cleaned.length, ACTORS - 1)
  assert.equal((await f.control().snapshot()).missions.length, 0)
  assert.ok(f.range(mission.id) <= MISSION_MAX_EVENTS)
})

test(`a ${ACTORS}-actor mission at its 2,000-entry capacity can still be stopped and deleted with cleanup`, { timeout: 120_000 }, async () => {
  const f = fixture()
  let mission = await f.crowded()
  // Another writer fills the ordinary capacity with valid user edits.
  f.fill(mission, missionLifecycleReserve(ACTORS))
  mission = await f.current(mission.id)
  assert.equal((await f.control().snapshot()).discardedEvents, 0)
  await assert.rejects(f.control().update({ missionID: mission.id, requestID: "refused", expectedRevision: mission.revision, objective: "Refused" }),
    /2000-event safety limit of this mission/)
  mission = await f.lifecycle(mission, "stop")
  assert.equal(mission.status, "stopped")
  assert.deepEqual([f.calls.length, mission.control?.pending.length], [ACTORS, 0])
  const deleted = await f.control().delete({ missionID: mission.id, requestID: "delete", expectedRevision: mission.revision, deleteManagedSessions: true })
  assert.equal(deleted.cleanup?.removed, ACTORS - 1)
  assert.equal(f.range(mission.id), MISSION_MAX_EVENTS - 1, "the coordinator is no cleanup target")
})

test(`a ${ACTORS}-actor mission filled by a graceful Pause and Interrupt now can still be stopped and deleted with cleanup`, { timeout: 120_000 }, async () => {
  const f = fixture()
  let mission = await f.crowded()
  // Room for the graceful Pause (one entry) and Interrupt now (one entry and a receipt per root)
  // but one entry short of keeping the reserve after both.
  f.fill(mission, missionLifecycleReserve(ACTORS) + 1 + (1 + ACTORS) - 1)
  mission = await f.lifecycle(await f.current(mission.id), "pause", true)
  assert.deepEqual([mission.runState, f.calls.length], ["paused", 0])
  await assert.rejects(f.lifecycle(mission, "pause"), /2000-event safety limit of this mission/)
  assert.equal(f.calls.length, 0, "a refused Interrupt now has no native effect")
  // One edit less: Interrupt now fits and keeps the reserve.
  f.values.delete([...f.values.keys()].find(key => key.includes("/evt_fill_"))!)
  mission = await f.lifecycle(await f.current(mission.id), "pause")
  assert.deepEqual([f.calls.length, mission.control?.pending.length, mission.control?.receipts?.length], [ACTORS, 0, ACTORS])
  assert.equal(f.range(mission.id), MISSION_MAX_EVENTS - missionLifecycleReserve(ACTORS), "neither control adds an actor or spends the reserve")
  await assert.rejects(f.control().update({ missionID: mission.id, requestID: "refused", expectedRevision: mission.revision, objective: "Refused" }),
    /2000-event safety limit of this mission/)
  mission = await f.lifecycle(mission, "stop")
  assert.deepEqual([mission.status, f.calls.length, mission.control?.pending.length], ["stopped", ACTORS, 0])
  const deleted = await f.control().delete({ missionID: mission.id, requestID: "delete", expectedRevision: mission.revision, deleteManagedSessions: true })
  assert.equal(deleted.cleanup?.removed, ACTORS - 1)
  assert.equal(f.range(mission.id), MISSION_MAX_EVENTS - 1)
})

test("a revision rewrites at most one dependency list per live task, however many tasks there are", async () => {
  const dependencyUpdates = Array.from({ length: 1_500 }, (_, index) => ({ taskKey: `task-${index}`, blockedBy: ["task-root"] }))
  assert.equal(parseReviseInput({ expectedRevision: 2, requestID: "wide", reason: "Rewire", dependencyUpdates }).dependencyUpdates.length, 1_500)
  const event = { version: 1, id: "evt_wide", type: "mission.revised", missionID: "msn_wide", projectID: PROJECT.id, requestID: "wide",
    expectedRevision: 2, actorSessionID: "ses_coordinator", reason: "Rewire", notesSpecified: false, retiredTasks: [], addedTasks: [], dependencyUpdates, createdAt: 1 }
  assert.equal(parseMissionEvent(event)?.type, "mission.revised")
  assert.equal(parseMissionEvent({ ...event, dependencyUpdates: [...dependencyUpdates, dependencyUpdates[0]] }), undefined, "one update per task")
  // The map refuses an update naming a task twice or one it does not hold.
  const f = fixture()
  let mission = (await f.control().create({ requestID: "deps", objective: "Dependencies", template: "custom" })).mission
  mission = (await f.control().revise(mission.coordinatorSessionId, { missionID: mission.id, expectedRevision: mission.revision, requestID: "plan",
    reason: "Plan", retireTasks: [], dependencyUpdates: [], addTasks: ["root", "leaf"].map(taskKey => ({ taskKey, title: taskKey, brief: "Work", role: "worker", blockedBy: [] })) })).mission
  for (const updates of [[{ taskKey: "leaf", blockedBy: ["root"] }, { taskKey: "leaf", blockedBy: [] }], [{ taskKey: "absent", blockedBy: [] }]]) {
    await assert.rejects(f.control().revise(mission.coordinatorSessionId, { missionID: mission.id, expectedRevision: mission.revision, requestID: `deps-${updates.length}`,
      reason: "Rewire", retireTasks: [], addTasks: [], dependencyUpdates: updates }), /Invalid or duplicate dependency update/)
  }
})

/** Native sources the executor reads afresh on every call. */
interface NativeSources {
  catalog?: () => { agents: unknown[]; models: unknown[] }
  observeTask?: () => Promise<unknown>
  discover?: (request: { contract: unknown; parentSessionID: string }) => Promise<unknown>
}

/** The real plugin's mission.inspect executor over the fixture's storage; every result stays within its bound. */
async function inspectTool(f: ReturnType<typeof fixture>, native: NativeSources = {}) {
  const tools = new Map<string, { execute(input: unknown, context: unknown): Promise<{ content: string }> }>()
  const registration = () => ({ dispose: async () => {} })
  await setupMissionsPlugin({
    location: { directory: "/repo", project: { id: PROJECT.id, canonical: PROJECT.canonical } },
    storage: f.storage,
    session: {
      get: async ({ sessionID }: { sessionID: string }) => f.native.get(sessionID),
      create: async () => { throw new Error("not used") }, prompt: async () => {}, synthetic: async () => {},
      hook: async () => registration(),
    },
    agent: { list: async () => ({ data: native.catalog?.().agents ?? [] }) },
    model: { list: async () => ({ data: native.catalog?.().models ?? [] }) },
    tool: { transform: async (callback: (draft: unknown) => void) => {
      callback({ namespace: () => {}, add: (tool: { name: string } & Parameters<typeof tools.set>[1]) => tools.set(tool.name, tool) })
      return registration()
    } },
    rpc: { register: async () => ({ ...registration(), events: { emit: async () => {} } }) },
  } as never, native.observeTask ? { prompt: async () => {}, synthetic: async () => {}, observeTask: native.observeTask } : undefined, undefined, undefined,
  native.discover ? Object.assign(async () => { throw new Error("Inspection never verifies a report") }, { discover: native.discover }) as never : undefined)
  return async (input: Record<string, unknown>, sessionID: string) => {
    const content = (await tools.get("inspect")!.execute(input, { sessionID, messageID: "msg_inspect", id: "call_inspect", progress: async () => {} })).content
    assert.ok(content.length <= MISSION_INSPECT_OUTPUT_LIMIT, `inspect result of ${content.length} characters`)
    return { content, value: JSON.parse(content) }
  }
}

test("the mission.inspect tool pages a large map and keeps a small one whole", { timeout: 120_000 }, async () => {
  const f = fixture()
  let mission = (await f.control().create({ requestID: "plugin", objective: "Large map", template: "custom" })).mission
  const coordinator = mission.coordinatorSessionId
  const tool = await inspectTool(f)
  const inspect = (input: Record<string, unknown>) => tool(input, coordinator)
  const small = await inspect({})
  assert.equal(small.value.taskPage, undefined)
  assert.deepEqual(small.value, JSON.parse(JSON.stringify(await f.control().inspect(coordinator, {}, "small"))))
  for (let added = 0; added < 240; added += 24) {
    mission = (await f.control().revise(coordinator, { missionID: mission.id, expectedRevision: mission.revision, requestID: `plan-${added}`, reason: "More",
      retireTasks: [], addTasks: Array.from({ length: 24 }, (_, i) => ({ taskKey: `task-${added + i}`, title: `Task ${added + i}`,
        brief: "Brief ".repeat(400), role: "worker", blockedBy: [] })), dependencyUpdates: [] })).mission
  }
  const first = await inspect({})
  assert.ok(first.content.length <= MISSION_INSPECT_OUTPUT_LIMIT)
  assert.equal(first.value.mission.objective, mission.objective)
  const keys: string[] = first.value.mission.tasks.map((task: { key: string }) => task.key)
  for (let offset: number | undefined = first.value.taskPage.nextTaskOffset; offset !== undefined;) {
    const page = await inspect({ taskOffset: offset })
    assert.ok(page.content.length <= MISSION_INSPECT_OUTPUT_LIMIT)
    keys.push(...page.value.mission.tasks.map((task: { key: string }) => task.key))
    offset = page.value.taskPage.nextTaskOffset
  }
  assert.deepEqual(keys, mission.tasks.map(task => task.key))
  await assert.rejects(inspect({ taskOffset: 0, taskKey: "task-0" }), /taskOffset/)
  await assert.rejects(inspect({ taskOffset: -1 }), /non-negative/)
})

test("through its executor, mission.inspect returns every value of a large map, its reports and late reports exactly", { timeout: 300_000 }, async () => {
  const f = fixture()
  // Accepted control characters serialize as six characters each.
  const text = (length: number, mark: string) => `${mark}${"\u0001".repeat(length - mark.length - 1)}.`
  let mission = (await f.control().create({ requestID: "exact", objective: text(20_000, "Objective"), notes: text(20_000, "Notes"), template: "custom" })).mission
  const coordinator = mission.coordinatorSessionId
  const reportInput = (mark: string) => ({ missionID: mission.id, outcome: "completed" as const, summary: text(20_000, `${mark} summary`),
    evidence: Array.from({ length: 12 }, (_, index) => text(2_000, `${mark} evidence ${index}`)),
    next: Array.from({ length: 12 }, (_, index) => text(2_000, `${mark} next ${index}`)), artifact: { data: text(8_000, `${mark} artifact`), checked: [1, true, null] }, final: false })
  // A native task with a coordinator readout, and an independent root whose report arrives after Stop.
  mission = (await f.control().declare(coordinator, { missionID: mission.id, taskKey: "big-task", title: "Big", brief: text(20_000, "Brief"), role: "specialist",
    blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } })).mission
  mission = (await f.control().report(coordinator, { ...reportInput("Readout"), taskKey: "big-task" })).mission
  mission = (await f.control().delegate(coordinator, { missionID: mission.id, taskKey: "actor-task", title: "Actor", brief: text(20_000, "Actor brief"),
    role: "worker", blockedBy: [], delivery: "queue" })).mission
  for (let added = 0; added < 48; added += 24) {
    mission = (await f.control().revise(coordinator, { missionID: mission.id, expectedRevision: mission.revision, requestID: `plan-${added}`, reason: text(2_000, "Reason"),
      retireTasks: [], dependencyUpdates: [], addTasks: Array.from({ length: 24 }, (_, i) => ({ taskKey: `task-${added + i}`, title: `Task ${added + i}`,
        brief: text(5_000, `Planned ${added + i}`), role: "worker", blockedBy: [] })) })).mission
  }
  mission = await f.lifecycle(await f.current(mission.id), "stop")
  const actor = mission.tasks.find(task => task.key === "actor-task")!.actorSessionId!
  mission = (await f.control().report(actor, { ...reportInput("Late"), taskKey: "actor-task" })).mission
  const late = mission.tasks.find(task => task.key === "actor-task")!.lateReports
  assert.equal(late?.length, 1)
  const full = JSON.parse(JSON.stringify(await f.control().inspect(coordinator, { missionID: mission.id }, "full")))
  assert.ok(JSON.stringify(full, null, 2).length > 10 * MISSION_INSPECT_OUTPUT_LIMIT)

  const tool = await inspectTool(f), inspect = (input: Record<string, unknown>) => tool(input, coordinator)
  let reads = 0
  /** Every replaced value read back through the executor, slice by slice. */
  const resolve = async (value: unknown): Promise<unknown> => {
    if (Array.isArray(value)) { const items = []; for (const item of value) items.push(await resolve(item)); return items }
    if (!value || typeof value !== "object") return value
    const record = value as Record<string, unknown>
    if (Object.keys(record).length === 2 && "omittedCharacters" in record && "read" in record) {
      let input = record.read as Record<string, unknown>, joined = "", json = false
      for (;;) {
        const slice = (await inspect(input)).value as { content: { text: string; json?: true; next?: Record<string, unknown> } }
        reads++
        joined += slice.content.text
        json = slice.content.json === true
        if (!slice.content.next) break
        input = slice.content.next
      }
      assert.equal(joined.length, record.omittedCharacters)
      return json ? JSON.parse(joined) : joined
    }
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(record)) result[key] = await resolve(item)
    return result
  }
  const header = (await inspect({ missionID: mission.id })).value
  const tasks = [...header.mission.tasks]
  for (let offset: number | undefined = header.taskPage.nextTaskOffset; offset !== undefined;) {
    const page = (await inspect({ missionID: mission.id, taskOffset: offset })).value
    assert.ok(page.mission.tasks.length > 0)
    tasks.push(...page.mission.tasks)
    offset = page.taskPage.nextTaskOffset
  }
  const { taskPage: _page, mission: { tasks: _tasks, ...fields }, ...outer } = await resolve(header) as Record<string, any>
  const { mission: map, ...rest } = full
  const { tasks: original, reports, ...headerFields } = map
  assert.deepEqual(outer, rest)
  assert.deepEqual(fields, headerFields)
  // The readout and the late report did not fit whole: each keeps its identity with exact reads.
  const paged = (key: string) => tasks.find((task: { key: string }) => task.key === key)
  assert.equal(paged("big-task").report.id, original.find((task: { key: string }) => task.key === "big-task").report.id)
  assert.ok(paged("big-task").report.evidence.read && paged("big-task").brief.read)
  assert.ok(paged("actor-task").lateReports.read || paged("actor-task").lateReports[0].evidence.read)
  assert.deepEqual(await resolve(tasks), original, "every task, its brief, report and late reports, field for field")
  assert.ok(reads >= 10, `${reads} content reads`)
  // The task view serves complete stored reports, the late one included.
  for (const taskKey of ["big-task", "actor-task"]) {
    const view = await resolve((await inspect({ missionID: mission.id, taskKey })).value) as { reports: unknown[] }
    assert.deepEqual(view.reports, reports.filter((report: { taskKey: string }) => report.taskKey === taskKey))
  }
  assert.equal((await resolve((await inspect({ missionID: mission.id, taskKey: "actor-task" })).value) as { reports: Array<{ late?: boolean }> }).reports[0].late, true)
  // A content read of another revision is refused.
  const objective = header.mission.objective.read as { missionID: string; content: Record<string, unknown> }
  await assert.rejects(inspect({ ...objective, content: { ...objective.content, revision: mission.revision - 1 } }), /changed since this page/)
})

/** Follows a content read's slices through the executor; `between` runs after the first one. */
async function readContent(inspect: (input: Record<string, unknown>) => Promise<{ value: any }>, read: Record<string, unknown>, between?: () => void) {
  let input = read, text = "", json = false, slices = 0
  for (;;) {
    const { content } = (await inspect(input)).value as { content: { text: string; json?: true; next?: Record<string, unknown> } }
    text += content.text
    json = content.json === true
    if (!content.next) break
    if (!slices++) between?.()
    input = content.next
  }
  return json ? JSON.parse(text) : text
}

test("through its executor, an owned root without a mission reads a catalog too large for one result, and a changed one is refused", { timeout: 30_000 }, async () => {
  const f = fixture()
  f.native.set("ses_reader", { id: "ses_reader", projectID: PROJECT.id, title: "Reader", location: { directory: "/repo" } })
  let stage = "a"
  const source = () => ({
    agents: [{ id: "build", mode: "all", description: "Builder" }, { id: "explore", mode: "subagent" }, { id: "internal", mode: "all", hidden: true }],
    models: Array.from({ length: 2_500 }, (_, index) => ({ providerID: "fixture", id: `${stage}${String(index).padStart(5, "0")}`.padEnd(96, "m"),
      enabled: index !== 7, capabilities: { tools: true }, variants: index % 2 ? [{ id: "high" }, { id: "max" }] : [] })),
  })
  const expected = async () => JSON.parse(JSON.stringify(await readMissionCatalog({ agent: { list: async () => ({ data: source().agents }) },
    model: { list: async () => ({ data: source().models }) } } as never, "/repo")))
  const tool = await inspectTool(f, { catalog: source }), inspect = (input: Record<string, unknown>) => tool(input, "ses_reader")
  const result = (await inspect({ catalog: true })).value
  assert.equal(result.mission, null)
  assert.ok(JSON.stringify(await expected(), null, 2).length > 4 * MISSION_INSPECT_OUTPUT_LIMIT)
  assert.deepEqual(Object.keys(result.catalog.read), ["content"], "the catalog's read names no mission")
  // Every continuation, and every agent and model descriptor.
  const catalog = await readContent(inspect, result.catalog.read)
  assert.deepEqual(catalog, await expected())
  assert.deepEqual([catalog.agents.length, catalog.models.length], [2, 2_499])
  // The catalog changes between slices, at the same length: the next slice is refused, never joined.
  await assert.rejects(readContent(inspect, result.catalog.read, () => { stage = "b" }), /changed since its first slice/)
  const again = (await inspect({ catalog: true })).value.catalog
  assert.deepEqual(await readContent(inspect, again.read), await expected(), "read again, the current catalog is whole")
  await assert.rejects(inspect({ missionID: "msn_other", ...again.read }), /names no mission/)
  // Catalog slices read no mission storage. The reader joins an unrelated mission, a
  // write any mission lookup would re-read; then, with every journal read failing, the
  // owned root and its catalog still serve the slices, and a child session is still refused.
  const joined = (await f.control().create({ requestID: "joined", objective: "Unrelated", template: "custom", coordinatorSessionID: "ses_reader" })).mission
  const { get, scan } = f.storage
  const trapped = async () => { throw new Error("Mission storage trapped") }
  Object.assign(f.storage, { get: trapped, scan: trapped })
  try {
    assert.deepEqual(await readContent(inspect, again.read), await expected())
    f.native.set("ses_reader_child", { id: "ses_reader_child", parentID: "ses_reader", projectID: PROJECT.id, title: "Child", location: { directory: "/repo" } })
    await assert.rejects(tool(again.read, "ses_reader_child"), /root sessions only/)
    // A mission read fails closed at once, and leaves no exclusion or index state held.
    await assert.rejects(inspect({}), /Mission storage trapped/)
    assert.deepEqual(await readContent(inspect, again.read), await expected())
  } finally { Object.assign(f.storage, { get, scan }) }
  assert.equal((await inspect({})).value.mission.id, joined.id, "once storage recovers, mission reads resume")
})

test("through its executor, slices of native conversations and human answers refuse a change between them at the same revision", { timeout: 120_000 }, async () => {
  const f = fixture()
  let stage = "A"
  // Quotes double in JSON, so a bounded observation still spans slices.
  const observation = () => ({ sessions: Array.from({ length: 200 }, (_, index) => ({ sessionID: `ses_${stage}${String(index).padStart(3, "0")}`.padEnd(240, "\""),
    active: index % 2 === 0 })), complete: true })
  const discover = async (request: { contract: unknown; parentSessionID: string }) => ({ complete: true, candidates: Array.from({ length: 6 }, (_, index) => {
    const question = `Q${index}${stage.repeat(19_998)}`, answer = stage.repeat(20_000)
    return { question, answer, artifact: { kind: "decision", question, answer, provenance: { contract: request.contract, sessionID: `ses_${stage}_child_${index}`,
      formID: `form_${stage}_${index}`, nativeCall: { generation: 1, parentSessionID: request.parentSessionID, toolCallID: `call_${stage}_${index}`, parentMessageID: `msg_${stage}_${index}` } } } }
  }) })
  const tool = await inspectTool(f, { observeTask: async () => observation(), discover })
  let mission = (await f.control().create({ requestID: "wayfinder", objective: "Ask the human", template: "wayfinder" })).mission
  mission = (await f.control().declare(mission.coordinatorSessionId, { missionID: mission.id, taskKey: "decision-one", title: "Decision",
    brief: "\u0001".repeat(9_000), role: "decision", blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } })).mission
  const inspect = (input: Record<string, unknown>) => tool(input, mission.coordinatorSessionId)
  const view = async () => (await inspect({ missionID: mission.id, taskKey: "decision-one" })).value
  /** The value is one whole observation at the current stage. */
  const current = (field: "native" | "humanAnswers", value: any) => field === "native" ? assert.deepEqual(value, observation())
    : assert.ok(value.candidates.length === 6 && value.candidates.every((candidate: { answer: string }) => candidate.answer === stage.repeat(20_000)))
  for (const field of ["native", "humanAnswers"] as const) {
    stage = "A"
    const marker = (await view())[field]
    assert.ok(marker.read, `${field} is read in slices`)
    current(field, await readContent(inspect, marker.read))
    // The source changes between slices while the map stays at its revision.
    await assert.rejects(readContent(inspect, marker.read, () => { stage = "B" }), /changed since its first slice/)
    const fresh = await view()
    assert.equal(fresh.revision, mission.revision, "no mission event versions the change")
    current(field, await readContent(inspect, fresh[field].read))
  }
})
