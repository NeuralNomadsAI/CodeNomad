import assert from "node:assert/strict"
import test from "node:test"
import Ajv from "ajv"
import { MISSION_INSPECT_OUTPUT_LIMIT } from "./inspect-view"
import { missionContentRequestSchema, type MissionContentResult, type MissionContentSelector } from "./mission-content"
import { missionPluginFixture } from "./mission-plugin-fixture"
import type { MissionMap } from "./model"
import { CODENOMAD_MISSIONS_RPC } from "./rpc"

const size = (value: unknown) => JSON.stringify(value, null, 2).length
// Accepted control characters serialize as six characters each; emoji are surrogate pairs.
const escaped = (length: number, mark: string) => `${mark}${"\u0001".repeat(length - mark.length - 1)}.`
const emoji = (length: number) => "😀".repeat(length / 2)
const validOutput = new Ajv({ allErrors: true }).compile(CODENOMAD_MISSIONS_RPC.methods.content.output)

/** A mission whose bodies are as large as each is accepted: objective, notes, briefs,
 * a failed report superseded by a replacement task's report, a late report, a plan
 * edit and a briefing, in escaped text and emoji. */
async function largeMission(f: ReturnType<typeof missionPluginFixture>, { stop = true } = {}) {
  const control = () => f.control()
  let mission = (await control().create({ requestID: "content", objective: escaped(20_000, "Objective"), notes: emoji(20_000), template: "custom" })).mission
  const coordinator = mission.coordinatorSessionId
  const report = (taskKey: string, outcome: "completed" | "failed", text: (length: number) => string) => ({ missionID: mission.id, taskKey, outcome,
    summary: text(20_000), evidence: Array.from({ length: 12 }, () => text(2_000)), next: Array.from({ length: 12 }, () => text(2_000)),
    artifact: { data: text(8_000), checked: [1, true, null] }, final: false })
  for (const [taskKey, brief] of [["first", escaped(20_000, "First brief")], ["second", emoji(20_000)]] as const) {
    mission = (await control().declare(coordinator, { missionID: mission.id, taskKey, title: taskKey, brief, role: "specialist", blockedBy: [],
      executionMode: { kind: "native", parentTaskKey: null } })).mission
  }
  mission = (await control().report(coordinator, report("first", "failed", length => escaped(length, "Failed")))).mission
  mission = (await control().revise(coordinator, { missionID: mission.id, expectedRevision: mission.revision, requestID: "retry", reason: escaped(2_000, "Retry"),
    retireTasks: [{ taskKey: "first", replacementTaskKey: "first-again" }], dependencyUpdates: [], addTasks: [{ taskKey: "first-again", title: "Again", brief: escaped(20_000, "Again brief"),
      role: "specialist", blockedBy: [], replacesTaskKey: "first", executionMode: { kind: "native", parentTaskKey: null } }] })).mission
  mission = (await control().report(coordinator, report("first-again", "completed", emoji))).mission
  mission = (await control().delegate(coordinator, { missionID: mission.id, taskKey: "actor-task", title: "Actor", brief: escaped(20_000, "Actor brief"),
    role: "worker", blockedBy: [], delivery: "queue" })).mission
  mission = (await control().update({ missionID: mission.id, requestID: "edit", expectedRevision: mission.revision,
    objective: emoji(20_000), notes: escaped(20_000, "Edited notes") })).mission
  mission = (await control().briefing(coordinator, { missionID: mission.id, requestID: "auto", summary: escaped(1_200, "Briefing"),
    achieved: [{ text: escaped(600, "Achieved"), taskKeys: ["first-again"] }], ongoing: [], obstacles: [], next: [{ text: emoji(600), taskKeys: [] }] })).mission
  if (!stop) return mission
  mission = (await control().lifecycle({ missionID: mission.id, action: "stop", expectedRevision: mission.revision, requestID: "stop" })).mission
  const actor = mission.tasks.find(task => task.key === "actor-task")!.actorSessionId!
  mission = (await control().report(actor, { ...report("actor-task", "completed", length => escaped(length, "Late")), missionID: mission.id })).mission
  assert.ok(mission.tasks.find(task => task.key === "actor-task")!.lateReports?.length, "a late report")
  return mission
}

/** Every selector a map has: each map field, each task field, each report field, each plan-change field. */
function selectors(mission: MissionMap): MissionContentSelector[] {
  return [
    ...Object.keys(mission).map(field => ({ kind: "mission" as const, field })),
    ...mission.tasks.flatMap(task => [...Object.keys(task), "reports"].map(field => ({ kind: "task" as const, taskKey: task.key, field }))),
    ...mission.reports.flatMap(report => Object.keys(report).map(field => ({ kind: "report" as const, reportId: report.id, field }))),
    ...mission.history.flatMap(change => Object.keys(change).map(field => ({ kind: "change" as const, change: change.revision, field }))),
  ]
}

/** What a selector names, looked up here independently of the code under test. */
function expected(mission: MissionMap, selector: MissionContentSelector): unknown {
  const owner = (value: object | undefined) => (value as Record<string, unknown> | undefined)?.[selector.field]
  if (selector.kind === "mission") return owner(mission)
  if (selector.kind === "report") return owner(mission.reports.find(report => report.id === selector.reportId))
  if (selector.kind === "change") return owner(mission.history.find(change => change.revision === selector.change))
  const task = mission.tasks.find(task => task.key === selector.taskKey)!
  return selector.field === "reports" ? mission.reports.filter(report => report.taskKey === task.key) : owner(task)
}

/** Reads one value whole, slice by slice; every answer fits and matches the RPC schema. */
async function readWhole(content: (input: unknown) => Promise<MissionContentResult>, missionID: string, selector: MissionContentSelector,
  between?: () => Promise<void>) {
  let offset = 0, digest: string | undefined, text = "", json = false, slices = 0
  for (;;) {
    const result = await content({ missionID, ...selector, ...(digest ? { digest } : {}), offset })
    assert.ok(size(result) <= MISSION_INSPECT_OUTPUT_LIMIT, `${size(result)} characters`)
    assert.ok(validOutput(result), JSON.stringify(validOutput.errors))
    if (!("content" in result)) return { refused: result.refused, slices }
    assert.equal(result.content.offset, offset)
    assert.ok(digest === undefined || result.content.digest === digest)
    text += result.content.text; json = result.content.json === true; digest = result.content.digest; slices++
    if (result.content.next === undefined) { assert.equal(text.length, result.content.characters); break }
    assert.equal(result.content.next, offset + result.content.text.length, "slices are contiguous")
    offset = result.content.next
    if (slices === 1) await between?.()
  }
  return { value: json ? JSON.parse(text) : text, slices }
}

test("every body of a large mission reads back exactly through the content RPC, each answer within its bound", { timeout: 300_000 }, async () => {
  const f = missionPluginFixture(), plugin = await f.plugin()
  try {
    const mission = await largeMission(f)
    const reference = JSON.parse(JSON.stringify((await f.control().mission(mission.id)).mission)) as MissionMap
    const content = (input: unknown) => plugin.rpc("content", input) as Promise<MissionContentResult>
    let multiSlice = 0
    for (const selector of selectors(reference)) {
      const read = await readWhole(content, mission.id, selector)
      assert.deepEqual(read.value, expected(reference, selector), JSON.stringify(selector))
      if (read.slices > 1) multiSlice++
    }
    assert.ok(multiSlice >= 10, `${multiSlice} values span several slices`)
    // Every report, current, superseded or late, reads by its own ID.
    assert.deepEqual(reference.reports.map(report => [report.taskKey, report.outcome, Boolean(report.late)]),
      [["first", "failed", false], ["first-again", "completed", false], ["actor-task", "completed", true]])
  } finally { await plugin.dispose() }
})

test("a body's slices stay valid across unrelated revisions and refuse a changed value; a historical report is never substituted", { timeout: 120_000 }, async () => {
  const f = missionPluginFixture(), plugin = await f.plugin()
  try {
    let mission = await largeMission(f, { stop: false })
    const content = (input: unknown) => plugin.rpc("content", input) as Promise<MissionContentResult>
    // Escaped notes serialize at six characters each: their read spans slices.
    const notes = { kind: "mission" as const, field: "notes" }, objective = { kind: "mission" as const, field: "objective" }
    // A new revision that leaves the notes alone keeps their slices valid.
    const before = mission.revision
    const unrelated = await readWhole(content, mission.id, notes, async () => {
      mission = (await f.control().update({ missionID: mission.id, requestID: "objective-only", expectedRevision: mission.revision,
        objective: "Changed objective", notes: mission.notes })).mission
    })
    assert.ok(unrelated.slices > 1 && mission.revision > before, "the revision moved between slices")
    assert.equal(unrelated.value, mission.notes)
    // Changed notes refuse the next slice instead of joining two values.
    const changed = await readWhole(content, mission.id, notes, async () => {
      mission = (await f.control().update({ missionID: mission.id, requestID: "notes", expectedRevision: mission.revision,
        objective: mission.objective, notes: escaped(20_000, "Other notes") })).mission
    })
    assert.deepEqual(changed, { refused: "content-changed", slices: 1 })
    // The superseded task's failed report reads as itself, beside its replacement's report.
    const failed = mission.reports.find(report => report.taskKey === "first")!
    assert.deepEqual((await readWhole(content, mission.id, { kind: "report", reportId: failed.id, field: "summary" })).value, failed.summary)
    assert.deepEqual((await readWhole(content, mission.id, { kind: "task", taskKey: "first", field: "report" })).value,
      JSON.parse(JSON.stringify(mission.tasks.find(task => task.key === "first")!.report)))
    // Refusals, and a later slice without its digest is invalid input.
    assert.deepEqual(await content({ missionID: "msn_absent", ...objective, offset: 0 }), { version: 1, projectID: "project-1", missionID: "msn_absent", refused: "mission-not-found" })
    assert.equal(((await content({ missionID: mission.id, kind: "report", reportId: "rep_absent", field: "summary", offset: 0 })) as { refused?: string }).refused, "content-not-found")
    await assert.rejects(content({ missionID: mission.id, ...objective, offset: 5 }), /digest/)
  } finally { await plugin.dispose() }
})

test("every stored plan change reads by its revision beyond the map's last 50, human and coordinator, never as another change", { timeout: 120_000 }, async () => {
  const f = missionPluginFixture(), plugin = await f.plugin()
  try {
    const content = (input: unknown) => plugin.rpc("content", input) as Promise<MissionContentResult>
    let mission = (await f.control().create({ requestID: "changes", objective: "Initial", notes: "Initial notes", template: "custom" })).mission
    const coordinator = mission.coordinatorSessionId
    // What each change records, written down here as the test makes it.
    const expectedChanges = new Map<number, Record<string, unknown>>()
    let objective = "Initial", notes = "Initial notes"
    const edit = async (next: string, nextNotes: string) => {
      const revision = mission.revision + 1
      mission = (await f.control().update({ missionID: mission.id, requestID: `edit-${revision}`, expectedRevision: mission.revision, objective: next, notes: nextNotes })).mission
      expectedChanges.set(revision, { revision, source: "user", objective: { before: objective, after: next }, notes: { before: notes, after: nextNotes } })
      objective = next; notes = nextNotes
    }
    const revise = async (reason: string, nextNotes: string) => {
      const revision = mission.revision + 1
      mission = (await f.control().revise(coordinator, { missionID: mission.id, expectedRevision: mission.revision, requestID: `revise-${revision}`, reason,
        notes: nextNotes, retireTasks: [], addTasks: [], dependencyUpdates: [] })).mission
      expectedChanges.set(revision, { revision, source: "coordinator", reason, notes: { before: notes, after: nextNotes } })
      notes = nextNotes
    }
    await edit(escaped(20_000, "Long objective"), "Edited notes")
    await revise(escaped(2_000, "First reason"), "Coordinator notes")
    for (let index = 0; index < 30; index++) { await edit(`Objective ${index}`, `Notes ${index}`); await revise(`Reason ${index}`, `Coordinator notes ${index}`) }
    assert.ok(mission.historyTruncated && mission.history.length === 50 && mission.history[0].revision === 14, "the first twelve changes left the map")
    for (const [revision, values] of expectedChanges) {
      for (const [field, value] of Object.entries(values)) {
        assert.deepEqual((await readWhole(content, mission.id, { kind: "change", change: revision, field })).value, value, `revision ${revision} ${field}`)
      }
    }
    assert.ok((await readWhole(content, mission.id, { kind: "change", change: 2, field: "objective" })).slices > 1, "an old change still spans slices")
    // A revision that records no plan change names none: never the nearest or a newer one.
    for (const revision of [1, mission.revision + 1]) {
      assert.equal(((await content({ missionID: mission.id, kind: "change", change: revision, field: "revision", offset: 0 })) as { refused?: string }).refused, "content-not-found")
    }
    // Within the map's window the same changes read as the map shows them.
    for (const change of mission.history) assert.deepEqual((await readWhole(content, mission.id, { kind: "change", change: change.revision, field: "createdAt" })).value, change.createdAt)
  } finally { await plugin.dispose() }
})

test("content requests name exactly their kind's identity and a later slice's digest", () => {
  const ok = (input: Record<string, unknown>) => missionContentRequestSchema.safeParse({ missionID: "msn_1", field: "summary", offset: 0, ...input }).success
  assert.ok(ok({ kind: "mission" }) && ok({ kind: "task", taskKey: "task-1" }) && ok({ kind: "report", reportId: "rep_1" }) && ok({ kind: "change", change: 2 }))
  assert.ok(!ok({ kind: "task" }) && !ok({ kind: "mission", taskKey: "task-1" }) && !ok({ kind: "report", reportId: "rep_1", change: 2 }))
  assert.ok(!ok({ kind: "mission", offset: 10 }), "a later slice repeats its digest")
  assert.ok(ok({ kind: "mission", offset: 10, digest: "a".repeat(43) }))
  assert.ok(!ok({ kind: "inspection" }) && !ok({ kind: "catalog" }) && !ok({ kind: "mission", extra: true }))
})
