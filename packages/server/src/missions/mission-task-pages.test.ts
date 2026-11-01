import assert from "node:assert/strict"
import test from "node:test"
import Ajv from "ajv"
import { MISSION_JOURNAL_STORAGE_PREFIX, MissionJournal, parseMissionEvent } from "./journal"
import { contentDigest, contentText, missionContentValue } from "./inspect-view"
import { compactMissionMap, missionTaskPage } from "./mission-compact-map"
import type { MissionContentResult } from "./mission-content-wire"
import { MISSION_LATE_REPORT_ROWS, MISSION_PINNED_REPORTS, MISSION_TASK_PAGE, MISSION_TASK_PINS, MISSION_TASK_REPORT_ROWS, type MissionPanelMap,
  type MissionTaskPageResult } from "./mission-panel-map"
import { FIXTURE_PROJECT, missionPluginFixture } from "./mission-plugin-fixture"
import { missionTaskOrder } from "./mission-task-order"
import { MISSION_MAX_HISTORY, type MissionList, type MissionMap, type MissionRead, type MissionReport, type MissionTask } from "./model"
import { nativeCallObservationID } from "./native-call-reconciliation"
import { CODENOMAD_MISSIONS_RPC } from "./rpc"

const ajv = new Ajv({ allErrors: true })
const validList = ajv.compile(CODENOMAD_MISSIONS_RPC.methods.list.output), validRead = ajv.compile(CODENOMAD_MISSIONS_RPC.methods.mission.output)
const validPage = ajv.compile(CODENOMAD_MISSIONS_RPC.methods.tasks.output)
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value))
/** The documented budgets (MISSIONS.md, Task pages), in UTF-8 bytes of the JSON: a row's
 * widest, then a page (its rows, their report rows and as many named ones) and a map (its
 * rows, their report rows, the taskless ones, its plan changes and a header of at most
 * 40 KiB, actor-scale lists aside). */
const ROW = { task: 32_768, report: 8_192, change: 4_096 }
const withReports = ROW.task + MISSION_TASK_REPORT_ROWS * ROW.report
const BUDGET = { taskRow: ROW.task, reportRow: ROW.report, changeRow: ROW.change, page: MISSION_TASK_PAGE * (withReports + ROW.report),
  map: (MISSION_TASK_PAGE + MISSION_TASK_PINS) * withReports + MISSION_PINNED_REPORTS * ROW.report + MISSION_MAX_HISTORY * ROW.change + 40_960 }

type Fixture = ReturnType<typeof missionPluginFixture>
/** Writes `events` as one mission's journal range, each accepted by the journal's parser. */
function seed(f: Fixture, missionID: string, events: Array<Record<string, unknown>>) {
  const journal = new MissionJournal(f.storage, FIXTURE_PROJECT.id, FIXTURE_PROJECT.canonical)
  for (const event of events) {
    const parsed = parseMissionEvent({ version: 1, missionID, projectID: FIXTURE_PROJECT.id, ...event })
    assert.ok(parsed, String(event.id))
    f.values.set(`${MISSION_JOURNAL_STORAGE_PREFIX}/${journal.projectToken}/${missionID}/${parsed.id}`, parsed as never)
  }
}
const created = (objective: string, coordinator: string) => ({ id: "evt_created", type: "mission.created", projectCanonical: FIXTURE_PROJECT.canonical, objective,
  template: "custom", coordinator: { sessionID: coordinator, title: "Coordinator", location: FIXTURE_PROJECT.location }, createdAt: 1 })

/** The review's 2,400 tasks (100 revisions of 24, 20,000-character briefs); the second half
 * waits on the round before it, then one revision rewires 1,200 tasks to 24 dependencies
 * each (a plan change of thousands of keys) and the last first-half round to the final
 * round, so the display order is not the map's. A blockage is reported far beyond the window. */
function wideMission(f: Fixture) {
  const key = (round: number, index: number) => `task-${round}-${index}`
  const events: Array<Record<string, unknown>> = [created("Wide plan", "ses_wide")]
  for (let round = 0; round < 100; round++) events.push({ id: `evt_rev_${round}`, type: "mission.revised", requestID: `rev-${round}`, expectedRevision: round + 1,
    actorSessionID: "ses_wide", reason: "More tasks", notesSpecified: false, retiredTasks: [], dependencyUpdates: [], createdAt: 10 + round,
    addedTasks: Array.from({ length: 24 }, (_, index) => ({ id: `tsk_${round}_${index}`, key: key(round, index), title: `Work ${round}.${index}`, brief: "b".repeat(20_000),
      role: "specialist", blockedBy: round >= 50 ? [key(round - 1, index)] : [], executionMode: { kind: "native", parentTaskKey: null } })) })
  events.push({ id: "evt_rewire", type: "mission.revised", requestID: "rewire", expectedRevision: 101, actorSessionID: "ses_wide", reason: "Rewire", notesSpecified: false,
    retiredTasks: [], addedTasks: [], createdAt: 200, dependencyUpdates: [...Array.from({ length: 1_200 }, (_, offset) => ({ taskKey: key(50 + Math.floor(offset / 24), offset % 24),
      blockedBy: Array.from({ length: 24 }, (_, index) => key(index, offset % 24)) })),
      ...Array.from({ length: 24 }, (_, index) => ({ taskKey: key(49, index), blockedBy: [key(99, index)] }))] })
  events.push({ id: "evt_blocked", type: "task.reported", createdAt: 201, report: { id: "rep_blocked", taskKey: key(49, 23), sessionId: "ses_wide", outcome: "blocked",
    summary: "Needs a decision", evidence: [], next: [], createdAt: 201, delivery: "coordinator-readout" } })
  seed(f, "msn_wide", events)
}

/** One native task with 1,997 retained observations of wide identifiers (the review's widest row). */
function observedMission(f: Fixture) {
  const binding = { generation: 1, parentSessionID: "ses_observed", parentMessageID: "m".repeat(240), toolCallID: "c".repeat(240) }
  const childSessionID = "s".repeat(240), base = { missionID: "msn_observed", projectID: FIXTURE_PROJECT.id, version: 1 }
  const events: Array<Record<string, unknown>> = [created("Observed", binding.parentSessionID),
    { id: "evt_task", type: "task.created", task: { id: "tsk_observed", key: "work", title: "\u0000".repeat(240), brief: "b", role: "\u0000".repeat(240), blockedBy: [],
      executionMode: { kind: "native", parentTaskKey: null } }, createdAt: 2 },
    { id: "evt_bound", type: "task.native-bound", taskKey: "work", actor: { sessionID: childSessionID, title: "Child", managed: true, location: FIXTURE_PROJECT.location }, binding, createdAt: 3 }]
  for (let index = 1; index <= 1_997; index++) {
    const observation = { kind: "child-uncorrelated", outcome: "interrupted", source: { id: String(index).padEnd(240, "o"), sessionID: childSessionID,
      aggregateID: "a".repeat(240), seq: index, created: index } }
    events.push({ id: nativeCallObservationID({ ...base, taskKey: "work", binding, childSessionID }, observation as never), type: "task.native-call-observed",
      taskKey: "work", binding, childSessionID, observation, createdAt: 3 + index })
  }
  seed(f, "msn_observed", events)
}

/** One retired task with 100 late reports of 20,000-character summaries (the review's case). */
function lateMission(f: Fixture) {
  const binding = (index: number) => ({ generation: 1, parentSessionID: "ses_late", parentMessageID: `msg_${index}`.padEnd(240, "x"), toolCallID: `call_${index}`.padEnd(240, "x") })
  const events: Array<Record<string, unknown>> = [created("Late reports", "ses_late"),
    { id: "evt_task", type: "task.created", task: { id: "tsk_late", key: "work", title: "Work", brief: "b", role: "specialist", blockedBy: [],
      executionMode: { kind: "native", parentTaskKey: null } }, createdAt: 2 },
    { id: "evt_bound", type: "task.native-bound", taskKey: "work", actor: { sessionID: "ses_child", title: "Child", managed: true, location: FIXTURE_PROJECT.location },
      binding: binding(0), createdAt: 3 }]
  const add = (event: Record<string, unknown>) => events.push({ ...event, createdAt: events.length + 1 })
  for (let index = 0; index < 100; index++) {
    if (index) add({ id: `evt_started_${index}`, type: "task.native-call-started", taskKey: "work", binding: binding(index), childSessionID: "ses_child" })
    add({ id: `evt_ended_${index}`, type: "task.native-call-ended", taskKey: "work", binding: binding(index), childSessionID: "ses_child", outcome: "returned" })
  }
  add({ id: "evt_retired", type: "mission.revised", requestID: "retire", expectedRevision: events.length, actorSessionID: "ses_late", reason: "Retire",
    notesSpecified: false, retiredTasks: [{ taskKey: "work" }], dependencyUpdates: [], addedTasks: [] })
  for (let index = 0; index < 100; index++) add({ id: `evt_report_${index}`, type: "task.reported", report: { id: `rep_${index}`, taskKey: "work", sessionId: "ses_child",
    outcome: "completed", summary: "??".repeat(10_000), evidence: [], next: [], createdAt: events.length + 1, late: true, delivery: "native-return", nativeCall: binding(index) } })
  seed(f, "msn_late", events)
}

/** One value read whole through the content RPC, slice by slice. */
async function readWhole(rpc: (method: string, input: unknown) => Promise<unknown>, missionID: string, selector: Record<string, unknown>) {
  let offset = 0, digest: string | undefined, text = ""
  for (;;) {
    const result = await rpc("content", { missionID, ...selector, ...(digest ? { digest } : {}), offset }) as MissionContentResult
    assert.ok("content" in result, JSON.stringify(result))
    text += result.content.text; digest = result.content.digest
    if (result.content.next === undefined) return JSON.parse(text)
    offset = result.content.next
  }
}

test("every panel read of a 2,400-task mission with a wide history fits its budget, and traversal reaches every task exactly once, in display order", { timeout: 300_000 }, async t => {
  const f = missionPluginFixture(), plugin = await f.plugin()
  try {
    wideMission(f)
    const listed = await plugin.rpc("list", { include: ["msn_wide"] }) as MissionList, read = await plugin.rpc("mission", { missionID: "msn_wide" }) as MissionRead
    assert.ok(validList(listed), JSON.stringify(validList.errors)); assert.ok(validRead(read), JSON.stringify(validRead.errors))
    const full = (await f.control().snapshot()).missions.find(value => value.id === "msn_wide")!
    assert.equal(full.tasks.length, 2_400)
    const map = read.mission!
    assert.deepEqual(listed.missions.find(value => value.id === "msn_wide"), map)
    const order = missionTaskOrder(full.tasks).map(task => task.key)
    assert.notDeepEqual(order, full.tasks.map(task => task.key), "pages follow the display order, not the map's")
    assert.ok(order.slice(-24).every(key => key.startsWith("task-49-")), "the round waiting on the last round ends the order")
    // The map: the window, then pinned rows; the order's totals and the blockage far beyond the window.
    assert.deepEqual([map.taskPage?.offset, map.taskPage?.end, map.taskPage?.total, map.taskPage?.counts], [0, MISSION_TASK_PAGE, 2_400,
      { ready: 1_176, "needs-input": 1, blocked: 1_223 }])
    assert.deepEqual(map.tasks.slice(0, MISSION_TASK_PAGE).map(task => task.key), order.slice(0, MISSION_TASK_PAGE))
    assert.ok(map.tasks.some(task => task.key === "task-49-23" && task.status === "needs-input" && task.order === order.indexOf("task-49-23")), "the blockage is pinned")
    assert.ok(map.tasks.length <= MISSION_TASK_PAGE + MISSION_TASK_PINS)
    assert.deepEqual(map.reports.map(report => report.id), ["rep_blocked"])
    assert.deepEqual(map.actorEvidence, { reportOwed: ["ses_wide"], callOpen: [] }, "the running coordinator owes its report")
    // The wide plan change is a row of descriptors: its lists are read whole through the content route.
    const rewire = map.history.find(change => change.excerpt === "Rewire")!
    assert.ok(bytes(rewire) < 2_048, `${bytes(rewire)} bytes`)
    assert.deepEqual(await readWhole(plugin.rpc, "msn_wide", { kind: "change", change: rewire.revision, field: "dependencyUpdates" }),
      json(full.history.find(change => change.revision === rewire.revision)!.dependencyUpdates))
    // Traversal: each page continues the order the map names, until its end.
    const seen: string[] = [], sizes: number[] = []
    for (let offset = 0; offset < map.taskPage!.total;) {
      const page = await plugin.rpc("tasks", { missionID: "msn_wide", order: map.taskPage!.order, offset }) as MissionTaskPageResult
      assert.ok(validPage(page), JSON.stringify(validPage.errors))
      assert.ok("tasks" in page, JSON.stringify(page))
      assert.equal(page.taskPage.offset, offset)
      seen.push(...page.tasks.map(task => task.key)); sizes.push(bytes(page))
      assert.ok(page.tasks.every(task => task.order === order.indexOf(task.key)))
      offset = page.taskPage.end
    }
    assert.deepEqual(seen, order, "every task once, in display order")
    const rows = [...map.tasks.map(bytes)]
    t.diagnostic(`snapshot ${bytes(full)} bytes; list ${bytes(listed)}; map ${bytes(map)}; pages ${sizes.length} of at most ${Math.max(...sizes)} bytes; row at most ${Math.max(...rows)}`)
    assert.ok(bytes(listed) <= BUDGET.map && bytes(read) <= BUDGET.map && Math.max(...sizes) <= BUDGET.page)
    // Tasks by key, ID or report; a changed order refuses its continuation.
    const named = await plugin.rpc("tasks", { missionID: "msn_wide", order: map.taskPage!.order, keys: ["task-99-23"], ids: ["tsk_0_0"], reportIds: ["rep_blocked"] }) as MissionTaskPageResult
    assert.ok("tasks" in named && validPage(named))
    assert.deepEqual(named.tasks.map(task => task.key), ["task-0-0", "task-49-23", "task-99-23"].sort((left, right) => order.indexOf(left) - order.indexOf(right)),
      "in display order")
    assert.deepEqual(named.reports.map(report => report.id), ["rep_blocked"])
    seed(f, "msn_wide", [{ id: "evt_one_more", type: "mission.revised", requestID: "one-more", expectedRevision: full.revision, actorSessionID: "ses_wide",
      reason: "One more", notesSpecified: false, retiredTasks: [], dependencyUpdates: [], createdAt: 300, addedTasks: [{ id: "tsk_late_root", key: "late-root",
        title: "Late root", brief: "Late", role: "specialist", blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } }] }])
    const stale = await plugin.rpc("tasks", { missionID: "msn_wide", order: map.taskPage!.order, offset: MISSION_TASK_PAGE }) as MissionTaskPageResult
    assert.deepEqual(stale, { version: 1, projectID: FIXTURE_PROJECT.id, missionID: "msn_wide", revision: full.revision + 1, refused: "order-changed" })
    assert.deepEqual(await plugin.rpc("tasks", { missionID: "msn_absent", offset: 0 }), { version: 1, projectID: FIXTURE_PROJECT.id, missionID: "msn_absent", refused: "mission-not-found" })
    await assert.rejects(plugin.rpc("tasks", { missionID: "msn_wide", offset: 0, keys: ["task-0-0"] }), /window or tasks/)
    await assert.rejects(plugin.rpc("tasks", { missionID: "msn_wide", offset: 0, attention: 0 }), /window or tasks/)
    // A named read answers every task it names: at most 50 names in all, of any kinds.
    const keys = order.slice(0, 30), ids = full.tasks.filter(task => !keys.includes(task.key) && task.key !== "task-49-23").slice(0, 30).map(task => task.id)
    await assert.rejects(plugin.rpc("tasks", { missionID: "msn_wide", keys, ids }), /At most 50 names in all/)
    const mixed = await plugin.rpc("tasks", { missionID: "msn_wide", keys: keys.slice(0, 25), ids: ids.slice(0, 24), reportIds: ["rep_blocked"] }) as MissionTaskPageResult
    assert.ok("tasks" in mixed && validPage(mixed), JSON.stringify(validPage.errors))
    assert.deepEqual(new Set(mixed.tasks.map(task => task.key)), new Set([...keys.slice(0, 25), ...full.tasks.filter(task => ids.slice(0, 24).includes(task.id)).map(task => task.key),
      "task-49-23"]), "every named task")
  } finally { await plugin.dispose() }
})

/** A full map of 80 independent tasks: the first 50 the window; beyond it, in turn,
 * `notified` tasks whose report's notification is pending, `blocked` and `failed` ones
 * (newer as they go) and `recovery` ones admitted without a report; one recovery task
 * sits in the window. */
function crowded(notified: number, blocked: number, failed: number, recovery: number): MissionMap {
  const report = (key: string, outcome: MissionReport["outcome"], index: number, pending: boolean): MissionReport => ({ id: `rep_${key}`, taskKey: key,
    sessionId: "ses_crowd", outcome, summary: `Result of ${key}`, evidence: [], next: [], createdAt: index, delivery: "coordinator-readout",
    ...(pending ? { notificationStatus: "pending" as const } : {}) })
  const kinds = [...Array(notified).fill("notified"), ...Array(blocked).fill("blocked"), ...Array(failed).fill("failed"), ...Array(recovery).fill("recovery")]
  const tasks: MissionTask[] = Array.from({ length: 50 + kinds.length }, (_, index) => {
    const key = `t${String(index).padStart(3, "0")}`, kind = index === 10 ? "recovery" : kinds[index - 50]
    const base: MissionTask = { id: `tsk_${key}`, key, title: `Task ${key}`, brief: "Brief", role: "specialist", blockedBy: [], status: "ready",
      outstandingExecution: false, createdAt: 1, updatedAt: index }
    if (kind === "notified") return { ...base, status: "completed", report: report(key, "completed", index, true) }
    if (kind === "blocked") return { ...base, status: "needs-input", report: report(key, "blocked", index, false) }
    if (kind === "failed") return { ...base, status: "failed", report: report(key, "failed", index, false) }
    if (kind === "recovery") return { ...base, status: "queued", actorSessionId: `ses_${key}`, admissionId: `adm_${key}` }
    return base
  })
  return { version: 1, id: "msn_crowd", projectID: FIXTURE_PROJECT.id, projectCanonical: FIXTURE_PROJECT.canonical, objective: "Crowd", template: "custom",
    status: "active", coordinatorSessionId: "ses_crowd", actors: [], tasks, reports: tasks.flatMap(task => task.report ? [task.report] : []), frontier: [], claims: [],
    createdAt: 1, updatedAt: 1, revision: 2, history: [], historyTruncated: false } as MissionMap
}

test("tasks needing action compete for the pins in priority, the rest are counted over the whole map and read by attention window", () => {
  const page = (map: MissionMap, request: Parameters<typeof missionTaskPage>[1]) => {
    const result = { version: 1, projectID: FIXTURE_PROJECT.id, missionID: map.id, revision: map.revision, ...missionTaskPage(map, request) }
    assert.ok(validPage(json(result)), JSON.stringify(validPage.errors))
    return result
  }
  const keys = (tasks: readonly { key: string }[]) => tasks.map(task => task.key)
  // The sequence names the omitted keys in priority: the same in a map and its pages.
  const sequence = (tasks: readonly { key: string }[]) => contentDigest(JSON.stringify(keys(tasks)))
  // Notifications and blockages take every pin; the reports to recover beyond the window wait.
  const recover = crowded(8, 10, 2, 6), map = compactMissionMap(recover)
  assert.deepEqual(keys(map.tasks.slice(MISSION_TASK_PAGE)), keys(recover.tasks.slice(50, 70)), "the 8 notifications, 10 blockages and 2 failures")
  assert.deepEqual([map.taskPage?.pinsOmitted, map.taskPage?.attention], [6, { counts: { notifications: 8, blocked: 10, failed: 2, recovery: 7 }, omitted: 6,
    sequence: sequence(recover.tasks.slice(70, 76)), keys: keys(recover.tasks.slice(70, 76)) }])
  const omitted = page(recover, { attention: 0 })
  assert.deepEqual([keys(omitted.tasks), omitted.taskPage.attention], [keys(recover.tasks.slice(70, 76)),
    { counts: { notifications: 8, blocked: 10, failed: 2, recovery: 7 }, omitted: 6, sequence: sequence(recover.tasks.slice(70, 76)), offset: 0, end: 6 }])
  // Another task needing action changes the sequence, the display order staying the same.
  const more = { ...recover, revision: 3, tasks: recover.tasks.map((task, index) => index === 75 ? { ...task, status: "failed" as const, updatedAt: 999 } : task) }
  assert.equal(compactMissionMap(more).taskPage?.order, map.taskPage?.order)
  assert.notEqual(compactMissionMap(more).taskPage?.attention?.sequence, map.taskPage?.attention?.sequence)
  assert.deepEqual([keys(page(recover, { attention: 4 }).tasks), page(recover, { attention: 4 }).taskPage.attention?.end], [keys(recover.tasks.slice(74, 76)), 6])
  // Notifications first, then the newest blockages: the older ones and every recovery are omitted, and read in that priority.
  const blocked = crowded(15, 10, 0, 6), crowd = compactMissionMap(blocked)
  assert.deepEqual(keys(crowd.tasks.slice(MISSION_TASK_PAGE)), [...keys(blocked.tasks.slice(50, 65)), ...keys(blocked.tasks.slice(70, 75))])
  const priority = [...blocked.tasks.slice(65, 70).reverse(), ...blocked.tasks.slice(75, 81)]
  assert.deepEqual(crowd.taskPage?.attention, { counts: { notifications: 15, blocked: 10, failed: 0, recovery: 7 }, omitted: 11,
    sequence: sequence(priority), keys: keys(priority) }, "in priority: the newest blockage first")
  // Beyond the first page of them, keys stop: an attention read reaches the rest.
  const many = compactMissionMap(crowded(0, 20, 0, 60))
  assert.deepEqual([many.taskPage?.attention?.omitted, many.taskPage?.attention?.keys?.length], [60, MISSION_TASK_PAGE])
  assert.deepEqual(keys(page(crowded(0, 20, 0, 60), { attention: MISSION_TASK_PAGE }).tasks), keys(crowded(0, 20, 0, 60).tasks.slice(120, 130)))
  assert.deepEqual(keys(page(blocked, { attention: 0 }).tasks), [...keys(blocked.tasks.slice(65, 70)), ...keys(blocked.tasks.slice(75, 81))], "in display order")
  assert.deepEqual(keys(page(blocked, { attention: 5 }).tasks), keys(blocked.tasks.slice(75, 81)), "after the omitted blockages, the recoveries")
  // Nothing omitted: the attention window is empty.
  const calm = crowded(2, 1, 0, 1)
  assert.deepEqual([compactMissionMap(calm).taskPage?.attention?.omitted, compactMissionMap(calm).taskPage?.attention?.keys, page(calm, { attention: 0 }).tasks.length],
    [0, [], 0])
})

test("rows of maximal width keep the map, a page and each row within their documented budgets", t => {
  // Free text escapes to six JSON characters a character; native identifiers allow no control character, so three bytes.
  const text = (length: number) => "\u0001".repeat(length), id = (prefix: string) => prefix + "€".repeat(240 - prefix.length)
  const key = (index: number) => `k${String(index).padStart(3, "0")}`.padEnd(64, "k")
  const binding = (index: number) => ({ generation: 1, parentSessionID: id(`p${index}`), parentMessageID: id(`m${index}`), toolCallID: id(`t${index}`) })
  const report = (index: number, task: number, late: boolean): MissionMap["reports"][number] => ({ id: id(`r${index}${late ? "l" : ""}`), taskKey: key(task), sessionId: id("s"),
    outcome: late ? "completed" : task >= 100 ? "failed" : "completed", summary: text(20_000), evidence: [text(2_000)], next: [text(2_000)], artifact: { note: text(8_000) },
    ...(late ? { late: true } : {}), nativeCall: binding(index), delivery: "native-return", notificationStatus: "admitted", createdAt: index })
  const tasks: MissionMap["tasks"] = Array.from({ length: 120 }, (_, index) => ({ id: id(`task${index}`), key: key(index), title: text(240), brief: text(20_000),
    role: text(240), execution: { agent: text(240), model: { providerID: text(240), id: text(240), variant: text(240) } },
    executionMode: { kind: "independent", reason: "lifetime", explanation: text(2_000) },
    blockedBy: index ? Array.from({ length: Math.min(24, index) }, (_, offset) => key(index - offset - 1)) : [],
    status: index >= 100 ? "failed" : "completed", actorSessionId: id("s"), admissionId: id("a"), delivery: "queue", nativeBinding: binding(index),
    nativeExecution: { binding: binding(index), ended: "returned" }, contractGeneration: 1, createdAt: 1, updatedAt: index, outstandingExecution: false,
    report: report(index, index, false), lateReports: Array.from({ length: 5 }, (_, late) => report(1_000 + index * 5 + late, index, true)) }))
  const history: MissionMap["history"] = Array.from({ length: 50 }, (_, index) => ({ revision: index + 2, source: "coordinator", actorSessionId: id("s"), reason: text(2_000),
    objective: { before: text(20_000), after: text(20_000) }, notes: { before: text(20_000), after: text(20_000) }, addedTaskKeys: tasks.slice(0, 24).map(task => task.key),
    retiredTasks: tasks.slice(0, 24).map(task => ({ taskKey: task.key, replacementTaskKey: task.key })),
    dependencyUpdates: tasks.slice(0, 24).map(task => ({ taskKey: task.key, before: task.blockedBy, after: task.blockedBy })), createdAt: index }))
  const full = { version: 1, id: "msn_widest", projectID: FIXTURE_PROJECT.id, projectCanonical: FIXTURE_PROJECT.canonical, title: text(240), objective: text(20_000),
    notes: text(20_000), template: "custom", status: "active", coordinatorSessionId: id("s"), actors: [], tasks,
    // Reports of a task the map no longer has: a map holds the newest.
    reports: [...tasks.flatMap(task => [task.report!, ...task.lateReports!]), ...Array.from({ length: 10 }, (_, index) => ({ ...report(2_000 + index, 0, false), taskKey: "gone" }))],
    frontier: [], claims: [], createdAt: 1, updatedAt: 1, revision: 52, history, historyTruncated: true } as MissionMap
  const map = compactMissionMap(full), page = missionTaskPage(full, { offset: 0 })
  const widest = (values: readonly unknown[]) => Math.max(...values.map(bytes))
  t.diagnostic(`task row ${widest(map.tasks)}; report row ${widest(map.reports)}; change row ${widest(map.history)}; map ${bytes(map)}; page ${bytes(page)} bytes`)
  assert.equal(map.tasks.length, MISSION_TASK_PAGE + MISSION_TASK_PINS, "the window and every pin")
  const taskless = map.reports.filter(report => report.taskKey === "gone")
  assert.ok(map.tasks.every(task => task.reportCount === 6) && map.reports.length === map.tasks.length * MISSION_TASK_REPORT_ROWS + MISSION_PINNED_REPORTS, `${map.reports.length} reports`)
  assert.deepEqual(taskless.map(report => report.createdAt), Array.from({ length: MISSION_PINNED_REPORTS }, (_, index) => 2_010 - MISSION_PINNED_REPORTS + index))
  assert.equal(page.reports.length, page.tasks.length * MISSION_TASK_REPORT_ROWS, "a page holds its rows' reports only")
  assert.ok(widest(map.tasks) <= BUDGET.taskRow && widest(map.reports) <= BUDGET.reportRow && widest(map.history) <= BUDGET.changeRow)
  assert.ok(bytes(map) <= BUDGET.map && bytes(page) <= BUDGET.page, `${bytes(map)} and ${bytes(page)} bytes`)
})

test("a task row stays within its budget whatever its observations and late reports, and the content route reads them all", { timeout: 300_000 }, async t => {
  const f = missionPluginFixture(), plugin = await f.plugin()
  try {
    observedMission(f); lateMission(f)
    const listed = await plugin.rpc("list", { include: ["msn_observed", "msn_late"] }) as MissionList
    assert.ok(validList(listed), JSON.stringify(validList.errors))
    const row = (id: string) => listed.missions.find(value => value.id === id)!.tasks[0]
    const observed = row("msn_observed"), late = row("msn_late")
    t.diagnostic(`observed row ${bytes(observed)} bytes; late row ${bytes(late)} bytes; list ${bytes(listed)} bytes`)
    assert.ok(bytes(observed) <= BUDGET.taskRow && bytes(late) <= BUDGET.taskRow, `${bytes(observed)} and ${bytes(late)} bytes`)
    assert.equal(observed.nativeExecution && "observations" in observed.nativeExecution, false, "a row holds no observation")
    assert.equal((await readWhole(plugin.rpc, "msn_observed", { kind: "task", taskKey: "work", field: "nativeExecution" })).observations.length, 1_997)
    assert.deepEqual([late.lateReports?.map(report => report.id), late.lateReportCount], [["rep_99"].slice(0, MISSION_LATE_REPORT_ROWS), 100])
    const all = Array.from({ length: 100 }, (_, index) => `rep_${index}`)
    assert.deepEqual((await readWhole(plugin.rpc, "msn_late", { kind: "task", taskKey: "work", field: "lateReports" })).map((report: { id: string }) => report.id), all)
    // The row's reports: its newest, with the count of all of them, which the content route reads.
    assert.deepEqual([listed.missions.find(value => value.id === "msn_late")!.reports.map(report => report.id), late.reportCount],
      [["rep_97", "rep_98", "rep_99"].slice(-MISSION_TASK_REPORT_ROWS), 100])
    assert.deepEqual((await readWhole(plugin.rpc, "msn_late", { kind: "task", taskKey: "work", field: "reports" })).map((report: { id: string }) => report.id), all)
    // The row describes that whole history exactly as the content route answers it, and a
    // new report describes another one: a reader of the history reads it again.
    const first = await plugin.rpc("content", { missionID: "msn_late", kind: "task", taskKey: "work", field: "reports", offset: 0 }) as MissionContentResult
    assert.ok("content" in first)
    assert.deepEqual(late.bodies?.reports, { characters: first.content.characters, digest: first.content.digest })
    const before = (await f.control().snapshot()).missions.find(value => value.id === "msn_late") as MissionMap
    const after = { ...before, reports: [...before.reports, { ...before.reports.at(-1)!, id: "rep_new", createdAt: 1_000 }] }
    const text = contentText(missionContentValue(after, { kind: "task", taskKey: "work", field: "reports" }))
    assert.deepEqual(compactMissionMap(after).tasks[0].bodies?.reports, { characters: text.length, digest: contentDigest(text) })
    assert.notEqual(contentDigest(text), first.content.digest)
    // A report named by a read is in its page, beside its task's newest.
    const named = await plugin.rpc("tasks", { missionID: "msn_late", reportIds: ["rep_0"] }) as MissionTaskPageResult
    assert.ok("tasks" in named && validPage(named), JSON.stringify(validPage.errors))
    assert.deepEqual([named.tasks.map(task => task.key), named.reports.map(report => report.id)], [["work"], ["rep_0", "rep_97", "rep_98", "rep_99"]])
    // A map of either is the same read again: compaction is idempotent on its own output.
    const map = listed.missions.find(value => value.id === "msn_late") as MissionPanelMap
    assert.equal(compactMissionMap(map), map)
    const full = (await f.control().snapshot()).missions.find(value => value.id === "msn_late") as MissionMap
    assert.deepEqual(json(compactMissionMap(full)), map)
  } finally { await plugin.dispose() }
})
