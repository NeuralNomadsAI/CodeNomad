import assert from "node:assert/strict"
import test from "node:test"

import type { MissionListResponse, MissionPanelMap, MissionPanelTask } from "../../../server/src/api-types"
import type { MissionTaskPageResponse, MissionTaskRequest } from "../../../server/src/missions/mission-panel-map"
import { createMissionContentStore } from "./mission-content-store"
import { createMissionStore } from "./mission-store"
import { MissionTaskPageReadError } from "../lib/mission-task-page-read"
import { raceTaskRead } from "../lib/mission-task-read-lifetime"
import { answerTaskRequest, createTaskPageCache, failTaskRequest, mergeTaskPages, missionBodyRevision, taskRequestsOf } from "./mission-task-pages"

/** A plan of independent tasks in display order, at a revision: compact maps and pages of it
 * take the shape the plugin gives them (the first 50 rows and the pinned blockages, then
 * pages of 50 by offset or key). A blocked task carries its blockage report. */
interface Plan { revision: number; keys: string[]; blocked?: string[] }
const plan = (count: number, revision = 1, first: string[] = [], blocked: string[] = []): Plan =>
  ({ revision, keys: [...first, ...Array.from({ length: count }, (_, index) => `task-${String(index).padStart(3, "0")}`)], blocked })
const orderOf = (value: Plan) => `order:${value.keys.length}:${value.keys[0]}`
const row = (value: Plan, key: string): MissionPanelTask => ({ id: `tsk_${key}`, key, title: `Task ${key}`, role: "specialist", blockedBy: [],
  status: value.blocked?.includes(key) ? "needs-input" : "ready", outstandingExecution: false, createdAt: 1, updatedAt: value.revision, bodies: {},
  order: value.keys.indexOf(key), dependents: 0, reportCount: 0,
  ...(value.blocked?.includes(key) ? { report: { id: `rep_${key}`, taskKey: key, sessionId: "session-1", outcome: "blocked", createdAt: value.revision } as MissionPanelTask["report"] } : {}) })
const taskPage = (value: Plan, offset: number, end: number) => ({ order: orderOf(value), offset, end, total: value.keys.length, counts: { ready: value.keys.length }, reports: 0 })
const compact = (value: Plan): MissionPanelMap => ({ version: 1, id: "msn_wide", projectID: "project-1", projectCanonical: "/repo", excerpt: "Wide", template: "custom",
  status: "active", coordinatorSessionId: "session-1", actors: [], reports: [], createdAt: 1, updatedAt: 1, revision: value.revision, history: [], historyTruncated: false,
  bodies: {}, actorEvidence: { reportOwed: [], callOpen: [] },
  tasks: [...new Set([...value.keys.slice(0, 50), ...value.blocked ?? []])].map(key => row(value, key)).sort((left, right) => left.order! - right.order!),
  taskPage: taskPage(value, 0, Math.min(50, value.keys.length)) } as MissionPanelMap)
const listed = (value: Plan): MissionListResponse => ({ available: true, version: 1, projectID: "project-1", generatedAt: 1, discardedEvents: 0,
  activity: { generatedAt: 1, missions: [] }, missions: [compact(value)] })
/** The tasks route over `current()`: its page, or the refusal of another order. */
const pages = (current: () => Plan, calls: MissionTaskRequest[]) => async (_instanceId: string, missionId: string, request: MissionTaskRequest, _scope?: unknown): Promise<MissionTaskPageResponse> => {
  calls.push(request)
  const value = current(), base = { available: true as const, version: 1 as const, projectID: "project-1", missionID: missionId, revision: value.revision }
  if (request.order !== undefined && request.order !== orderOf(value)) return { ...base, refused: "order-changed" }
  const offset = request.offset ?? 0, keys = request.offset !== undefined ? value.keys.slice(offset, offset + 50) : value.keys.filter(key => request.keys?.includes(key))
  return { ...base, taskPage: taskPage(value, offset, request.offset !== undefined ? offset + keys.length : offset), tasks: keys.map(key => row(value, key)), reports: [] }
}
const keys = (store: ReturnType<typeof createMissionStore>) => store.state("instance-1").missions[0].tasks.map(task => task.key)

test("pre-aborted task work observes a late rejection instead of leaking an unhandled promise", async () => {
  const abort = new AbortController(); abort.abort()
  await assert.rejects(raceTaskRead(Promise.reject(new Error("late response")), abort.signal), { name: "AbortError" })
  await new Promise(resolve => setImmediate(resolve))
})

test("connection and wanted-mission transitions fence task reads without dropping last-good rows or replaying failures", async () => {
  const value = plan(150), calls: MissionTaskRequest[] = [], route = pages(() => value, calls)
  let release!: () => void, entered!: () => void, current!: () => boolean, signal!: AbortSignal
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const store = createMissionStore(async () => listed(value), async (...args) => {
    current = args[3].current; signal = args[3].signal; entered(); await gate; return route(...args)
  })
  await store.ensure("instance-1")
  store.want("instance-1", "selection", "msn_wide")
  const pending = store.loadTasks("instance-1", "msn_wide", { offset: 50 })
  await started
  assert.equal(current(), true)
  store.invalidateTasks("instance-1")
  assert.equal(current(), false); assert.equal(signal.aborted, true)
  assert.equal(keys(store).length, 50)
  release(); assert.equal(await pending, "skipped")
  assert.equal(keys(store).length, 50)
  assert.equal(store.state("instance-1").taskReads, undefined)

  let fail = true, attempts = 0
  const changed = createMissionStore(async () => listed(value), async (...args) => {
    attempts++; if (fail) throw new MissionTaskPageReadError("changed"); return route(...args)
  })
  changed.want("instance-1", "reader", "msn_wide"); await changed.ensure("instance-1")
  assert.equal(await changed.loadTasks("instance-1", "msn_wide", { offset: 50 }), "failed")
  assert.equal(changed.state("instance-1").taskReads?.msn_wide.failure?.reason, "changed")
  await changed.refresh("instance-1"); await changed.refresh("instance-1")
  assert.equal(attempts, 1, "same-revision refresh does not retry a changed cursor")
  fail = false; assert.equal(await changed.loadTasks("instance-1", "msn_wide", { offset: 50 }), "read")
  assert.equal(keys(changed).length, 100)
  fail = true
  await changed.loadTasks("instance-1", "msn_wide", { offset: 100 })
  fail = false; changed.invalidateTasks("instance-1"); await changed.refresh("instance-1")
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(keys(changed).length, 150, "a plugin/connection invalidation re-arms a parked read without discarding shown rows")
})

test("a task read released by its last wanted owner cannot publish", async () => {
  const value = plan(120), calls: MissionTaskRequest[] = [], route = pages(() => value, calls)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const store = createMissionStore(async () => listed(value), async (...args) => { entered(); await gate; return route(...args) })
  await store.ensure("instance-1"); store.want("instance-1", "selection", "msn_wide")
  const pending = store.loadTasks("instance-1", "msn_wide", { offset: 50 })
  await started; store.want("instance-1", "selection", undefined); release()
  assert.equal(await pending, "skipped"); assert.equal(keys(store).length, 50)
})

test("queued reads keep their wanted lifetime and a newer revision does not reread an unselected open mission's task windows", async () => {
  let value = plan(150), sends = 0, release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const route = pages(() => value, [])
  const store = createMissionStore(async () => listed(value), async (...args) => { sends++; entered(); await gate; return route(...args) })
  store.setDemand("instance-1", true); store.want("instance-1", "selection", "msn_wide"); await store.ensure("instance-1")
  const running = store.loadTasks("instance-1", "msn_wide", { offset: 50 })
  await started
  const queued = store.loadTasks("instance-1", "msn_wide", { offset: 100 })
  store.want("instance-1", "selection", "other")
  release()
  assert.deepEqual(await Promise.all([running, queued]), ["skipped", "skipped"])
  assert.equal(sends, 1, "the obsolete queued selector never reaches the fetch boundary")
  value = plan(150, 2); await store.refresh("instance-1"); await new Promise(resolve => setImmediate(resolve))
  assert.equal(sends, 1, "open but unwanted missions receive no task-window revalidation")
})

test("last-owner A→B→A never resurrects a queued or running lifetime; concurrent readers keep ownership", async () => {
  const value = plan(150), route = pages(() => value, [])
  let release!: () => void, entered!: () => void, oldCurrent!: () => boolean, sends = 0
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const store = createMissionStore(async () => listed(value), async (...args) => {
    sends++; if (sends === 1) { oldCurrent = args[3].current; entered(); await gate }
    return route(...args)
  })
  await store.ensure("instance-1")
  assert.equal(await store.loadTasks("instance-1", "msn_wide", { offset: 50 }), "skipped")
  assert.equal(sends, 0, "unowned reads are explicitly not admitted")
  store.want("instance-1", "selection", "msn_wide")
  const running = store.loadTasks("instance-1", "msn_wide", { offset: 50 })
  await started
  const queued = store.loadTasks("instance-1", "msn_wide", { offset: 100 })
  store.want("instance-1", "selection", "other"); assert.equal(oldCurrent(), false)
  store.want("instance-1", "selection", "msn_wide"); assert.equal(oldCurrent(), false)
  assert.deepEqual(await Promise.all([running, queued]), ["skipped", "skipped"])
  release(); assert.equal(keys(store).length, 50); assert.equal(sends, 1)
  store.want("instance-1", "reader", "msn_wide", true)
  assert.equal(await store.loadTasks("instance-1", "msn_wide", { offset: 50 }), "read")
  store.want("instance-1", "selection", "other")
  assert.ok(store.demandedInstanceIds().includes("instance-1"), "the reader owns demand without a panel")
  assert.equal(await store.loadTasks("instance-1", "msn_wide", { offset: 100 }), "read")
  store.want("instance-1", "reader", undefined)
  assert.equal(await store.loadTasks("instance-1", "msn_wide", { offset: 100 }), "skipped")
})

test("releasing one of two applicable owners preserves the existing in-flight read", async () => {
  const value = plan(120), route = pages(() => value, [])
  let release!: () => void, entered!: () => void, current!: () => boolean
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const store = createMissionStore(async () => listed(value), async (...args) => { current = args[3].current; entered(); await gate; return route(...args) })
  store.want("instance-1", "selection", "msn_wide"); store.want("instance-1", "reader", "msn_wide", true); await store.ensure("instance-1")
  const pending = store.loadTasks("instance-1", "msn_wide", { offset: 50 })
  await started; store.want("instance-1", "selection", "other")
  assert.equal(current(), true)
  release(); assert.equal(await pending, "read"); assert.equal(keys(store).length, 100)
})

test("rows read further show in display order beside the base map's, each overriding it only from a later page, never across orders", () => {
  const value = plan(120), map = compact(value)
  const cache = createTaskPageCache(map.taskPage!.order)
  answerTaskRequest(cache, { offset: 50 }, 1, { tasks: value.keys.slice(50, 100).map(key => row(value, key)), reports: [] })
  assert.deepEqual(mergeTaskPages(map, cache).tasks.map(task => task.order), Array.from({ length: 100 }, (_, index) => index))
  // A row the base holds stays unless the page that answered it is later than the base.
  const base = { ...compact(plan(120, 2)), tasks: compact(plan(120, 2)).tasks.map(task => ({ ...task, title: "Base copy" })) }
  answerTaskRequest(cache, { keys: ["task-000"] }, 1, { tasks: [{ ...map.tasks[0], title: "Page copy" }], reports: [] })
  assert.equal(mergeTaskPages(base, cache).tasks[0].title, "Base copy")
  answerTaskRequest(cache, { keys: ["task-000"] }, 3, { tasks: [{ ...map.tasks[0], title: "Later page copy" }], reports: [] })
  assert.equal(mergeTaskPages(base, cache).tasks[0].title, "Later page copy")
  // An unrelated later page vouches for its own rows only.
  answerTaskRequest(cache, { keys: ["task-001"] }, 9, { tasks: [row(value, "task-001")], reports: [] })
  assert.equal(mergeTaskPages(base, cache).tasks[2].title, "Base copy")
  assert.equal(mergeTaskPages(base, cache).tasks.length, 100, "rows the base does not hold show as last read")
  assert.equal(mergeTaskPages({ ...map, taskPage: { ...map.taskPage!, order: "other" } }, cache).tasks.length, 50, "another order shows the base alone")
  // Re-reads: what was answered before the base's revision, except reads parked at it.
  assert.deepEqual(taskRequestsOf(cache, 50, 2), [{ offset: 50 }])
  failTaskRequest(cache, { offset: 50 }, 2, "offline")
  assert.deepEqual([taskRequestsOf(cache, 50, 2), taskRequestsOf(cache, 50, 3)], [[], [{ offset: 50 }]])
})

test("a failed reread and an unrelated successful page never let an older row overwrite the map's newer pin", async () => {
  let value = plan(150)
  const calls: MissionTaskRequest[] = []
  let fail = false
  const route = pages(() => value, calls)
  const store = createMissionStore(async () => listed(value), async (...args) => {
    if (fail && args[2].offset === 50) throw new Error("temporary failure")
    return route(...args)
  })
  store.want("instance-1", "reader", "msn_wide")
  await store.ensure("instance-1")
  await store.loadTasks("instance-1", "msn_wide", { offset: 50 })
  const task60 = () => store.state("instance-1").missions[0].tasks.find(task => task.key === "task-060")!
  assert.equal(task60().status, "ready")
  // Revision 2 pins task 60's blockage; the automatic reread of its page fails.
  value = plan(150, 2, [], ["task-060"]); fail = true
  await store.refresh("instance-1")
  assert.equal(await store.loadTasks("instance-1", "msn_wide", { offset: 50 }), "failed")
  assert.deepEqual([task60().status, task60().report?.id], ["needs-input", "rep_task-060"])
  // An unrelated page succeeds at revision 2: the pin stays, and so does the row of task 61 as last read.
  assert.equal(await store.loadTasks("instance-1", "msn_wide", { offset: 100 }), "read")
  assert.deepEqual([task60().status, task60().report?.id], ["needs-input", "rep_task-060"])
  assert.equal(keys(store).length, 150)
  // The parked page is not read again at the same revision.
  const before = calls.length
  await store.refresh("instance-1")
  assert.equal(calls.length, before, "parked at revision 2")
  // The mission moves on before the list is read again: a page answering at revision 3
  // vouches for its own rows, never for task 60's older one over the shown pin.
  value = plan(150, 3, [], ["task-060"])
  assert.equal(await store.loadTasks("instance-1", "msn_wide", { offset: 100 }), "read")
  assert.deepEqual([task60().status, task60().report?.id], ["needs-input", "rep_task-060"])
  // At the next list read the parked page is read again with the others.
  value = plan(150, 4, [], ["task-060"]); fail = false
  await store.refresh("instance-1")
  // The mission's reads run in turn: the later window's settles both rereads.
  await store.loadTasks("instance-1", "msn_wide", { offset: 100 })
  assert.ok(store.state("instance-1").missions[0].tasks.every(task => task.updatedAt === 4), "every row from revision 4")
  assert.equal(task60().status, "needs-input")
})

test("a read further merges its page into the listed map, coalesced, and a failure keeps the rows with its retry", async () => {
  const value = plan(150), calls: MissionTaskRequest[] = []
  let fail = false
  const route = pages(() => value, calls)
  const store = createMissionStore(async () => listed(value), async (...args) => { if (fail) throw new Error("offline"); return route(...args) })
  store.want("instance-1", "reader", "msn_wide")
  await store.ensure("instance-1")
  assert.equal(keys(store).length, 50)
  // The same request twice while queued is one read.
  await Promise.all([store.loadTasks("instance-1", "msn_wide", { offset: 50 }), store.loadTasks("instance-1", "msn_wide", { offset: 50 })])
  assert.deepEqual(calls, [{ offset: 50, order: orderOf(value) }])
  assert.deepEqual(keys(store), value.keys.slice(0, 100))
  assert.equal(store.state("instance-1").taskReads, undefined)
  fail = true
  await store.loadTasks("instance-1", "msn_wide", { offset: 100 })
  assert.equal(keys(store).length, 100, "the rows shown stay")
  assert.deepEqual(store.state("instance-1").taskReads?.msn_wide, { loading: false, failure: { error: "offline", request: { offset: 100 } } })
  fail = false
  await store.loadTasks("instance-1", "msn_wide", { offset: 100 })
  assert.deepEqual(keys(store), value.keys)
  assert.equal(store.state("instance-1").taskReads, undefined)
})

test("a map that moves on reads its recorded pages again, and another order refuses a read, which the next list read repeats", async () => {
  let value = plan(120)
  const calls: MissionTaskRequest[] = []
  let lists = 0
  const store = createMissionStore(async () => { lists++; return listed(value) }, pages(() => value, calls))
  store.want("instance-1", "reader", "msn_wide")
  await store.ensure("instance-1")
  await store.loadTasks("instance-1", "msn_wide", { keys: ["task-119"] })
  assert.deepEqual(keys(store).at(-1), "task-119", "a task by key joins in its place")
  await store.loadTasks("instance-1", "msn_wide", { offset: 50 })
  assert.equal(calls.length, 2)
  // The same revision reads nothing again.
  await store.refresh("instance-1")
  assert.equal(calls.length, 2)
  // A later revision of the same order reads the recorded reads again.
  value = plan(120, 2)
  await store.refresh("instance-1")
  // An explicit read joins the same re-read while it waits, or follows it once it runs; the
  // mission's reads run in turn, so the last one settles them all.
  await store.loadTasks("instance-1", "msn_wide", { offset: 50 })
  await store.loadTasks("instance-1", "msn_wide", { keys: ["task-119"] })
  assert.ok(calls.slice(2).some(call => call.offset === 50) && calls.slice(2).some(call => call.keys?.[0] === "task-119"), JSON.stringify(calls))
  assert.equal(keys(store).length, 101)
  assert.ok(store.state("instance-1").missions[0].tasks.every(task => task.updatedAt === 2), "every row from the later revision")
  // A plan change moves the order: the read the server refuses lists again, which reads it again in the new order.
  const before = lists
  value = plan(120, 3, ["aaa-first"])
  await store.loadTasks("instance-1", "msn_wide", { offset: 100 })
  for (let attempt = 0; attempt < 5 && keys(store).length < 121; attempt++) await store.loadTasks("instance-1", "msn_wide", { offset: 100 })
  assert.ok(lists > before, "the refusal read the list again")
  assert.ok(calls.some(call => call.order === orderOf(value)))
  assert.deepEqual(keys(store), value.keys, "every task once, in the new order")
})

test("a failed read stays shown through unrelated successes until a read answers it", async () => {
  const value = plan(200), failing = new Set([100])
  const route = pages(() => value, [])
  const store = createMissionStore(async () => listed(value), async (...args) => {
    if (args[2].offset !== undefined && failing.has(args[2].offset)) throw new Error("offline")
    return route(...args)
  })
  store.want("instance-1", "reader", "msn_wide")
  await store.ensure("instance-1")
  assert.equal(await store.loadTasks("instance-1", "msn_wide", { offset: 100 }), "failed")
  assert.equal(await store.loadTasks("instance-1", "msn_wide", { offset: 50 }), "read")
  assert.equal(await store.loadTasks("instance-1", "msn_wide", { keys: ["task-150"] }), "read")
  assert.deepEqual(store.state("instance-1").taskReads?.msn_wide, { loading: false, failure: { error: "offline", request: { offset: 100 } } }, "unrelated reads keep it")
  failing.clear()
  assert.equal(await store.loadTasks("instance-1", "msn_wide", { offset: 100 }), "read")
  assert.equal(store.state("instance-1").taskReads, undefined)
})

test("a body a page's row describes is expected at that page's revision: an older answer held meanwhile is read again", async () => {
  const value = plan(120, 20), later = plan(120, 21), map = compact(value)
  const cache = createTaskPageCache(map.taskPage!.order)
  const described = (key: string, digest: string) => ({ ...row(later, key), bodies: { reports: { characters: 2, digest } } })
  answerTaskRequest(cache, { keys: ["task-000"] }, 21, { tasks: [described("task-000", "six")], reports: [] })
  answerTaskRequest(cache, { keys: ["task-060"] }, 19, { tasks: [row(value, "task-060")], reports: [] })
  const merged = mergeTaskPages(map, cache), selector = (taskKey: string) => ({ kind: "task" as const, taskKey, field: "reports" })
  assert.deepEqual([missionBodyRevision(merged, selector("task-000")), missionBodyRevision(merged, selector("task-001")),
    missionBodyRevision(merged, selector("task-060")), missionBodyRevision(merged, { kind: "mission", field: "objective" })], [21, 20, 20, 20],
    "the later page's row, the base's rows, an older off-page row, the map's own field")
  // The history read before that page answers at revision 20 with five reports: not the six the row describes.
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let reads = 0
  const contents = createMissionContentStore(async () => {
    const old = ++reads === 1
    if (old) await gate
    const text = JSON.stringify(old ? [1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 6])
    return { available: true, version: 1, projectID: "project-1", missionID: "msn_wide", revision: old ? 20 : 21,
      content: { kind: "task", field: "reports", taskKey: "task-000", digest: old ? "five" : "six", offset: 0, characters: text.length, json: true, text } }
  })
  const consumer = contents.use({ instanceId: "instance-1", projectID: "project-1", missionID: "msn_wide", selector: selector("task-000") }, "connection")
  consumer.need(Infinity)
  consumer.expect(merged.tasks[0].bodies?.reports, missionBodyRevision(merged, selector("task-000")))
  release()
  for (let attempt = 0; attempt < 20 && consumer.state().body?.digest !== "six"; attempt++) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual([consumer.state().body?.digest, JSON.parse(consumer.state().body!.text).length, reads], ["six", 6, 2])
  consumer.release()
})

test("clearing an instance fences a read further still running", async () => {
  const value = plan(120)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const route = pages(() => value, [])
  const store = createMissionStore(async () => listed(value), async (...args) => { await gate; return route(...args) })
  store.want("instance-1", "reader", "msn_wide")
  await store.ensure("instance-1")
  const read = store.loadTasks("instance-1", "msn_wide", { offset: 50 })
  await Promise.resolve()
  store.clear("instance-1")
  await store.ensure("instance-1")
  release()
  await read
  assert.equal(keys(store).length, 50, "the earlier read never publishes")
})

test("task pages retain whole document, original editor request and document-only cleanup metadata", async () => {
  const value = plan(120), response = listed(value)
  assert.ok(response.available)
  const map = response.missions[0]
  map.document = { revision: 4, configurationGeneration: 2, timeGeneration: 1, state: "paused", firstPlayedAt: null,
    launchedCount: 0, everCreatedTask: false, firstPlay: null, scheduleActivation: null,
    launch: { timing: { kind: "immediate" }, condition: null, ends: { at: null, afterMs: null, maxLaunches: null } } }
  map.history = [{ revision: 2, source: "user", requestID: "original_edit", createdAt: 2,
    bodies: { objective: { characters: 20, digest: "original_digest" } } }]
  response.cleanups = [{ missionID: "msn_deleted", deletionID: "evt_deleted", requestID: "original_delete", expectedRevision: 3,
    deleteManagedSessions: false, objective: "Deleted", removed: 0, retained: 0, pending: 0, documentPending: true, reasons: [], createdAt: 3 }]
  const before = structuredClone(response), store = createMissionStore(async () => response, pages(() => value, []))
  store.want("instance-1", "reader", map.id)
  await store.ensure("instance-1")
  assert.equal(await store.loadTasks("instance-1", map.id, { offset: 50 }), "read")
  const shown = store.state("instance-1")
  assert.equal(shown.missions[0].tasks.length, 100)
  assert.deepEqual(shown.missions[0].document, before.missions[0].document)
  assert.deepEqual(shown.missions[0].history, before.missions[0].history)
  assert.deepEqual(shown.cleanups, before.cleanups)
  assert.deepEqual(response, before, "display merging leaves the source map intact")
})
