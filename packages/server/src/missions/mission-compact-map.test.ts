import assert from "node:assert/strict"
import test from "node:test"
import Ajv from "ajv"
import { MISSION_JOURNAL_STORAGE_PREFIX, MissionJournal, parseMissionEvent } from "./journal"
import { describeMissionBodies } from "./mission-body-descriptors"
import { compactMissionMap } from "./mission-compact-map"
import { MISSION_BODY_FIELDS } from "./mission-content-wire"
import { MISSION_BRIEFING_CONTENT, MISSION_EXCERPT_MAX, missionExcerpt, type MissionPanelMap } from "./mission-panel-map"
import { FIXTURE_PROJECT, missionPluginFixture } from "./mission-plugin-fixture"
import { missionObjectiveLabel } from "./mission-summary"
import type { MissionList, MissionMap, MissionRead, MissionSnapshot } from "./model"
import { CODENOMAD_MISSIONS_RPC } from "./rpc"

const ajv = new Ajv({ allErrors: true })
const validList = ajv.compile(CODENOMAD_MISSIONS_RPC.methods.list.output), validRead = ajv.compile(CODENOMAD_MISSIONS_RPC.methods.mission.output)
const validSnapshot = ajv.compile(CODENOMAD_MISSIONS_RPC.methods.snapshot.output)
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

/** A body: its label, whitespace runs, filler, and an end mark past every excerpt bound. */
const body = (label: string, length = 2_000) => `${label}\n\n   ${"word ".repeat(Math.ceil(length / 5)).slice(0, length)} ${label}-END`

/** A mission with a body in each place: objective, notes, briefs, a report's four fields,
 * a plan change's reason, an edit's objective and notes, and a briefing. */
async function markedMission(f: ReturnType<typeof missionPluginFixture>): Promise<MissionMap> {
  const control = () => f.control()
  let mission = (await control().create({ requestID: "compact", objective: body("Objective"), notes: body("Notes"), template: "custom" })).mission
  const coordinator = mission.coordinatorSessionId
  for (const taskKey of ["first", "second"]) {
    mission = (await control().declare(coordinator, { missionID: mission.id, taskKey, title: taskKey, brief: body(`Brief ${taskKey}`), role: "specialist",
      blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } })).mission
  }
  mission = (await control().report(coordinator, { missionID: mission.id, taskKey: "first", outcome: "completed", summary: body("Summary"),
    evidence: [body("Evidence", 300)], next: [body("Next", 300)], artifact: { note: body("Artifact", 300) }, final: false })).mission
  mission = (await control().revise(coordinator, { missionID: mission.id, expectedRevision: mission.revision, requestID: "revise", reason: body("Reason", 1_000),
    retireTasks: [], dependencyUpdates: [{ taskKey: "second", blockedBy: ["first"] }], addTasks: [] })).mission
  mission = (await control().update({ missionID: mission.id, requestID: "edit", expectedRevision: mission.revision,
    objective: body("Edited objective"), notes: body("Edited notes") })).mission
  return (await control().briefing(coordinator, { missionID: mission.id, requestID: "auto", summary: body("Briefing", 800),
    achieved: [{ text: body("Achieved", 400), taskKeys: ["first"] }], ongoing: [], obstacles: [], next: [] })).mission
}

/** The body fields still on a compact map's owners: a briefing's content, a mode's explanation included. */
function bodiesLeft(map: MissionPanelMap): string[] {
  const left: string[] = []
  const check = (owner: object | undefined, fields: readonly string[], label: string) => {
    for (const field of fields) if (owner && field in owner) left.push(`${label} ${field}`)
  }
  check(map, ["objective", "notes", "summary"], "mission")
  check(map.briefing, MISSION_BRIEFING_CONTENT, "briefing")
  for (const task of map.tasks) {
    check(task, ["brief"], `task ${task.key}`)
    check(task.executionMode, ["explanation"], `task ${task.key} mode`)
    for (const report of [...task.report ? [task.report] : [], ...task.lateReports ?? []]) check(report, MISSION_BODY_FIELDS.report, `task ${task.key} report`)
  }
  for (const report of map.reports) check(report, MISSION_BODY_FIELDS.report, `report ${report.id}`)
  for (const change of map.history) check(change, MISSION_BODY_FIELDS.change, `change ${change.revision}`)
  return left
}

test("the list and mission reads return compact maps: descriptors in place of every body, bounded excerpts, the structure kept", { timeout: 120_000 }, async () => {
  const f = missionPluginFixture(), plugin = await f.plugin()
  try {
    const mission = await markedMission(f)
    const listed = await plugin.rpc("list", { include: [mission.id] }) as MissionList, read = await plugin.rpc("mission", { missionID: mission.id }) as MissionRead
    assert.ok(validList(listed), JSON.stringify(validList.errors)); assert.ok(validRead(read), JSON.stringify(validRead.errors))
    const full = (await f.control().snapshot()).missions.find(value => value.id === mission.id)!
    for (const [label, map] of [["list", listed.missions[0]], ["mission", read.mission!]] as const) {
      assert.deepEqual(map, JSON.parse(JSON.stringify(compactMissionMap(full))), `${label}: the snapshot's map, compact`)
      assert.deepEqual(bodiesLeft(map), [], `${label}: no body field`)
      assert.doesNotMatch(JSON.stringify(map), /-END/, `${label}: no body text beyond an excerpt`)
      assert.equal(map.excerpt, missionObjectiveLabel(full.objective))
      const { id, requestID, basedOnRevision, basedOnUpdatedAt, createdAt } = full.briefing!
      assert.deepEqual(map.briefing, { id, requestID, basedOnRevision, basedOnUpdatedAt, createdAt }, `${label}: the briefing's identity`)
      const report = map.reports[0]
      assert.equal(report.excerpt, missionExcerpt(full.reports[0].summary))
      assert.match(report.excerpt!, /^Summary word word .*…$/)
      assert.equal(Array.from(report.excerpt!).length, MISSION_EXCERPT_MAX + 1)
      // A task's report row is the mission's row, without its descriptors.
      const row: Partial<typeof report> = { ...report }
      delete row.bodies
      assert.deepEqual(map.tasks.find(task => task.key === "first")?.report, row)
      assert.deepEqual(map.history.map(change => [change.revision, change.excerpt, Object.keys(change.bodies ?? {}).sort()]),
        full.history.map(change => [change.revision, change.reason && missionExcerpt(change.reason),
          [...MISSION_BODY_FIELDS.change].filter(field => (change as unknown as Record<string, unknown>)[field] !== undefined).sort()]))
      assert.deepEqual(map.tasks.map(task => [task.key, task.blockedBy, task.status, task.executionMode]),
        full.tasks.map(task => [task.key, task.blockedBy, task.status, task.executionMode]))
    }
    // The rows and the response as a whole carry no body either.
    assert.doesNotMatch(JSON.stringify(listed), /-END/)
    // The compact schema refuses a map that carries its bodies.
    assert.equal(validList({ ...listed, missions: [full] }), false)
    assert.equal(validRead({ ...read, mission: full }), false)
  } finally { await plugin.dispose() }
})

test("compaction keeps every field but the bodies, unknown ones included, and leaves the map it reads whole", { timeout: 120_000 }, async () => {
  const f = missionPluginFixture(), plugin = await f.plugin()
  try {
    const full = await markedMission(f)
    // Fields this build does not know (a later build's), a Wayfinder decision readout, an independent mode and a late report.
    const readout = { ...full.tasks[0].report!, delivery: "coordinator-readout" as const, futureReportField: true,
      artifact: { kind: "decision", decidedBy: "coordinator", question: "Which?", decision: "This", rationale: "Because" } }
    const late = { ...readout, id: "rep_late", taskKey: "second", late: true, summary: body("Late") }
    const map = { ...structuredClone(full), template: "wayfinder" as const, document: { id: "doc_1", revision: 4 }, futureScalar: 7,
      tasks: [{ ...full.tasks[0], role: "decision", report: readout, futureTaskField: "kept" },
        { ...full.tasks[1], executionMode: { kind: "independent" as const, reason: "playbook" as const, explanation: body("Explanation", 1_000) }, lateReports: [late] }],
      reports: [readout, late], history: full.history.map(change => ({ ...change, requestID: `req_${change.revision}` })) } as MissionMap
    const before = structuredClone(map)
    const compact = compactMissionMap(map)
    assert.deepEqual(map, before, "the map passed keeps every body")
    assert.equal(compactMissionMap(compact), compact, "a compact map is returned as it is")
    assert.deepEqual(bodiesLeft(compact), [])
    const kept = (owner: object, compactOwner: object, dropped: readonly string[], label: string) => {
      for (const [key, value] of Object.entries(owner)) if (!dropped.includes(key)) assert.deepEqual((compactOwner as Record<string, unknown>)[key], value, `${label} ${key}`)
    }
    kept(map, compact, [...MISSION_BODY_FIELDS.mission, "tasks", "reports", "history"], "mission")
    kept(map.briefing!, compact.briefing!, MISSION_BRIEFING_CONTENT, "briefing")
    map.tasks.forEach((task, index) => kept(task, compact.tasks[index], MISSION_BODY_FIELDS.task, `task ${task.key}`))
    map.reports.forEach((report, index) => kept(report, compact.reports[index], MISSION_BODY_FIELDS.report, `report ${report.id}`))
    map.history.forEach((change, index) => kept(change, compact.history[index], MISSION_BODY_FIELDS.change, `change ${change.revision}`))
    assert.deepEqual([(compact as unknown as { document: unknown }).document, compact.history.map(change => (change as unknown as { requestID: string }).requestID)],
      [{ id: "doc_1", revision: 4 }, map.history.map(change => `req_${change.revision}`)])
    // Rows in place of the mixed bodies.
    assert.deepEqual(compact.tasks[1].executionMode, { kind: "independent", reason: "playbook", excerpt: missionExcerpt(body("Explanation", 1_000)) })
    // Only the decision task's readout is a decision; the late report belongs to a specialist task.
    assert.deepEqual([compact.tasks[0].report?.decidedBy, compact.reports.map(report => report.decidedBy)], ["coordinator", ["coordinator", undefined]])
    assert.deepEqual(compact.tasks[1].lateReports?.map(report => [report.id, report.excerpt]), [["rep_late", missionExcerpt(body("Late"))]])
    // Described when the map has none, kept when it has them.
    assert.deepEqual(compact.bodies, describeMissionBodies(map).bodies)
    assert.deepEqual(compactMissionMap(describeMissionBodies(map)), compact)
  } finally { await plugin.dispose() }
})

test("an excerpt is one line of at most its bound, a cut ending in an ellipsis", () => {
  assert.equal(missionExcerpt("  a\n\n b\tc  "), "a b c")
  assert.equal(missionExcerpt("😀".repeat(300)), `${"😀".repeat(MISSION_EXCERPT_MAX)}…`)
  assert.equal(missionExcerpt("abc def", 4), "abc…")
  assert.equal(missionExcerpt("abcd", 4), "abcd")
  assert.equal(missionExcerpt(" ".repeat(20_000)), "")
})

test("the snapshot, mission.inspect, mutations and the maps they read keep every body after compact reads", { timeout: 120_000 }, async () => {
  const f = missionPluginFixture(), plugin = await f.plugin()
  try {
    const mission = await markedMission(f)
    const before = await f.control().snapshot()
    for (let round = 0; round < 2; round++) { await plugin.rpc("list", { include: [mission.id] }); await plugin.rpc("mission", { missionID: mission.id }) }
    const after = await f.control().snapshot()
    assert.deepEqual([after.missions, after.cleanups], [before.missions, before.cleanups], "the snapshot's maps are unchanged, every body in them")
    assert.ok(validSnapshot(after), JSON.stringify(validSnapshot.errors))
    assert.deepEqual((await plugin.rpc("snapshot", {}) as MissionSnapshot).missions, JSON.parse(JSON.stringify(after.missions)), "the snapshot RPC's maps are full")
    const full = after.missions.find(value => value.id === mission.id)!
    assert.deepEqual([full.objective, full.notes, full.tasks.map(task => task.brief), full.reports[0].summary, full.briefing?.summary],
      [mission.objective, mission.notes, mission.tasks.map(task => task.brief), mission.reports[0].summary, mission.briefing?.summary])
    // mission.inspect reads full maps.
    const inspected = (await plugin.tool("inspect", { missionID: mission.id }, mission.coordinatorSessionId)).value as { mission: MissionMap }
    assert.deepEqual([inspected.mission.objective, inspected.mission.notes, inspected.mission.tasks.map(task => task.brief)],
      [full.objective, full.notes, full.tasks.map(task => task.brief)])
    // A mutation reads the full map, and returns one: the plan change records the notes it replaced.
    const edited = (await f.control().update({ missionID: mission.id, requestID: "after-reads", expectedRevision: full.revision,
      objective: full.objective, notes: "Changed notes" })).mission
    assert.deepEqual([edited.objective, edited.tasks.map(task => task.brief), edited.history.at(-1)?.notes],
      [full.objective, full.tasks.map(task => task.brief), { before: full.notes, after: "Changed notes" }])
  } finally { await plugin.dispose() }
})

test("a 2,400-task mission with maximum briefs lists in a bounded response", { timeout: 300_000 }, async t => {
  const f = missionPluginFixture(), journal = new MissionJournal(f.storage, FIXTURE_PROJECT.id, FIXTURE_PROJECT.canonical)
  const missionID = "msn_payload", base = { version: 1, missionID, projectID: FIXTURE_PROJECT.id }
  // The review's probe: one creation, then 100 revisions of 24 tasks, each brief at its 20,000-character maximum.
  const events: unknown[] = [{ ...base, id: "evt_created", type: "mission.created", projectCanonical: FIXTURE_PROJECT.canonical, objective: "Payload",
    template: "custom", coordinator: { sessionID: "ses_payload", title: "Coordinator", location: FIXTURE_PROJECT.location }, createdAt: 10_000 }]
  for (let revision = 0; revision < 100; revision++) events.push({ ...base, id: `evt_rev_${revision}`, type: "mission.revised", requestID: `rev-${revision}`,
    expectedRevision: revision + 1, actorSessionID: "ses_payload", reason: "More tasks", notesSpecified: false, retiredTasks: [], dependencyUpdates: [],
    addedTasks: Array.from({ length: 24 }, (_, index) => ({ id: `tsk_${revision}_${index}`, key: `task-${revision}-${index}`, title: "Work",
      brief: "b".repeat(20_000), role: "specialist", blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } })), createdAt: 10_001 + revision })
  for (const event of events) {
    const parsed = parseMissionEvent(event)
    assert.ok(parsed)
    f.values.set(`${MISSION_JOURNAL_STORAGE_PREFIX}/${journal.projectToken}/${missionID}/${parsed.id}`, parsed as never)
  }
  const list = await f.control().list({ include: [missionID] }), read = await f.control().mission(missionID)
  const snapshot = await f.control().snapshot()
  assert.equal(list.missions[0].tasks.length, 2_400)
  assert.ok(validList(JSON.parse(JSON.stringify(list))), JSON.stringify(validList.errors))
  const full = bytes(snapshot), listed = bytes(list), single = bytes(read)
  const row = Math.max(...list.missions[0].tasks.map(bytes))
  t.diagnostic(`snapshot ${full} bytes; list ${listed} bytes; mission ${single} bytes; largest task row ${row} bytes`)
  assert.ok(full > 48_000_000, "the full map: what the list returned with its bodies")
  // A row holds its scalars and keys, and descriptors in place of its brief and mode.
  assert.ok(row <= 512, `a task row is ${row} bytes`)
  assert.ok(listed < 2_400 * 512 && single < 2_400 * 512, `${listed} and ${single} bytes`)
})
