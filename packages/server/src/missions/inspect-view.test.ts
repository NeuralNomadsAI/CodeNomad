import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import type { MissionInspection } from "./control-types"
import { MISSION_INSPECT_OUTPUT_LIMIT, boundedInspection, boundedMissionList, boundedTaskView, inspectionContent, inspectionContentValue,
  type MissionInspectContent } from "./inspect-view"
import type { MissionMap, MissionReport, MissionTask } from "./model"

const size = (value: unknown) => JSON.stringify(value, null, 2).length
/** A content read's digest: SHA-256 (base64url) of the UTF-16 code units of the text its slices are cut from. */
const digest = (text: string) => createHash("sha256").update(text, "utf16le").digest("base64url")
// Accepted control characters serialize as six characters each; emoji are surrogate pairs.
const escaped = (length: number) => "\u0001".repeat(length)
const emoji = (length: number) => "😀".repeat(length / 2)

function task(index: number, brief = "Brief"): MissionTask {
  return { id: `tsk_${index}`, key: `task-${index}`, title: `Task ${index}`, brief, role: "worker", blockedBy: [], status: "ready",
    createdAt: 1, updatedAt: 1, outstandingExecution: false }
}

function report(taskKey: string, summary: string): MissionReport {
  return { id: `rep_${taskKey}`, taskKey, sessionId: "ses_coordinator", outcome: "completed", summary, evidence: [], next: [], createdAt: 2 }
}

function inspection(tasks: MissionTask[], extra: Partial<MissionMap> = {}): MissionInspection {
  const reports = tasks.flatMap(task => [...task.report ? [task.report] : [], ...task.lateReports ?? []])
  return {
    mission: { version: 1, id: "msn_large", projectID: "project", projectCanonical: "/repo", objective: "Objective", template: "custom",
      status: "active", coordinatorSessionId: "ses_coordinator", actors: [], tasks, reports, frontier: tasks.map(task => task.key), claims: [],
      createdAt: 1, updatedAt: 1, revision: 3, history: [], historyTruncated: false, ...extra },
    actor: null, templates: [],
  }
}

type Page = { mission: MissionMap; taskPage?: { offset: number; returned: number; total: number; nextTaskOffset?: number } }
type Slice = { content: { text: string; characters: number; json?: true; next?: { missionID?: string; content: MissionInspectContent } } }

/** Reads every value a result replaced back into place, slice by slice through each `next`. */
function resolve<T>(value: T, full: MissionInspection, reads = { count: 0 },
  lookup = (content: MissionInspectContent) => inspectionContentValue(full, content)): T {
  if (Array.isArray(value)) return value.map(item => resolve(item, full, reads, lookup)) as T
  if (!value || typeof value !== "object") return value
  const record = value as Record<string, unknown>
  if (Object.keys(record).length === 2 && "omittedCharacters" in record && "read" in record) {
    const read = record.read as { missionID: string; content: MissionInspectContent }
    assert.equal(read.missionID, full.mission!.id)
    let content = read.content, text = "", json = false
    for (;;) {
      const slice = inspectionContent(read.missionID, content, lookup(content)) as Slice
      assert.ok(size(slice) <= MISSION_INSPECT_OUTPUT_LIMIT, `slice of ${size(slice)} characters`)
      reads.count++
      text += slice.content.text
      json = slice.content.json === true
      if (!slice.content.next) break
      content = slice.content.next.content
    }
    assert.equal(text.length, record.omittedCharacters)
    return (json ? JSON.parse(text) : text) as T
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, resolve(item, full, reads, lookup)])) as T
}

/** The header and every task through the pages, each replaced value read back. */
function readAll(full: MissionInspection, reads = { count: 0 }) {
  const header = boundedInspection(full) as Page & Record<string, unknown>
  assert.ok(size(header) <= MISSION_INSPECT_OUTPUT_LIMIT, `header of ${size(header)} characters`)
  const tasks: unknown[] = [...header.mission.tasks]
  for (let offset = header.taskPage?.nextTaskOffset; offset !== undefined;) {
    const page = boundedInspection(full, offset) as Page
    assert.ok(size(page) <= MISSION_INSPECT_OUTPUT_LIMIT, `page of ${size(page)} characters`)
    assert.ok(page.mission.tasks.length > 0, "every explicit page progresses")
    assert.deepEqual(Object.keys(page.mission).sort(), ["id", "revision", "tasks"], "pages leave out the reports their tasks carry")
    tasks.push(...page.mission.tasks)
    offset = page.taskPage!.nextTaskOffset
  }
  const { taskPage: _page, mission: { tasks: _tasks, ...fields }, ...outer } = resolve(header, full, reads)
  return { outer, fields, tasks: resolve(tasks, full, reads) }
}

/** The paged reading recovers the whole inspection, every field exact. */
function assertComplete(full: MissionInspection) {
  if (boundedInspection(full) === full) return 0
  const reads = { count: 0 }, { outer, fields, tasks } = readAll(full, reads)
  const { mission, ...rest } = full
  const { tasks: original, reports: _reports, ...header } = mission!
  assert.deepEqual(outer, rest)
  assert.deepEqual(fields, header)
  assert.deepEqual(tasks, original)
  return reads.count
}

function hugeReport(id: string, taskKey: string, text: (length: number) => string, extra: Partial<MissionReport> = {}): MissionReport {
  return { ...report(taskKey, text(20_000)), id, evidence: Array.from({ length: 12 }, () => text(2_000)),
    next: Array.from({ length: 12 }, () => text(2_000)), artifact: { data: text(8_000), items: [text(100), 1, null] }, ...extra }
}

function hugeTask(index: number, text: (length: number) => string): MissionTask {
  const current = hugeReport(`rep_task-${index}`, `task-${index}`, text)
  return { ...task(index, text(20_000)), status: "completed", report: current,
    lateReports: [hugeReport(`rep_late_${index}`, `task-${index}`, text, { late: true, outcome: "failed" })] }
}

test("a map within the limit is returned unchanged", () => {
  const value = inspection([task(0), task(1)])
  assert.equal(boundedInspection(value), value)
  assert.equal(boundedInspection(value, 1), value)
})

test("a large map pages whole tasks in map order, each with its reports once, and every page fits", () => {
  const tasks = Array.from({ length: 300 }, (_, index) => {
    const value = task(index, "x".repeat(1_500))
    return index % 3 ? value : { ...value, status: "completed" as const, report: report(value.key, "y".repeat(1_000)) }
  })
  const value = inspection(tasks)
  assert.equal(assertComplete(value), 0, "whole tasks need no content read")
  const page = boundedInspection(value, 3) as Page
  assert.deepEqual(page.mission.tasks, tasks.slice(3, 3 + page.mission.tasks.length), "whole tasks, in map order")
  const past = boundedInspection(value, 10_000) as Page
  assert.deepEqual([past.mission.tasks, past.taskPage!.nextTaskOffset], [[], undefined])
})

test("the whole envelope fits when printable header text reaches the page boundary", () => {
  // The header alone just fits; its page metadata and empty lists must still count.
  const actors = Array.from({ length: 80 }, (_, index) => ({ sessionId: `ses_${index}`, kind: "specialist" as const, managed: false,
    title: "A".repeat(200), roles: ["specialist"], location: { directory: "/repo" }, joinedAt: 1 }))
  const build = (notes: number, pad: number) => ({ ...inspection([task(0, "b".repeat(20_000))],
    { objective: "o".repeat(20_000), notes: "n".repeat(notes), summary: "s".repeat(20_000), actors }),
  playbook: { id: "custom", instructions: "p".repeat(pad) } }) as unknown as MissionInspection
  // Pad the header so that, alone, it crosses the limit halfway through the sweep.
  const headerSize = (value: MissionInspection) => size({ ...value, mission: { ...value.mission!, tasks: [], reports: [] } })
  const pad = MISSION_INSPECT_OUTPUT_LIMIT - headerSize(build(10_000, 0))
  let crossed = 0
  for (let notes = 0; notes <= 20_000; notes += 25) {
    const value = build(notes, pad), header = boundedInspection(value) as Page
    assert.ok(size(header) <= MISSION_INSPECT_OUTPUT_LIMIT, `notes ${notes}: ${size(header)} characters`)
    if (Math.abs(headerSize(value) - MISSION_INSPECT_OUTPUT_LIMIT) < 500) crossed++
    if (notes % 2_500 === 0) assertComplete(value)
  }
  assert.ok(crossed > 10, "the sweep reaches headers within a page envelope of the limit")
})

test("heavily escaped accepted strings stay within the bound and read back exactly", () => {
  for (const text of [escaped, emoji]) {
    const history = Array.from({ length: 50 }, (_, index) => ({ revision: index + 2, source: "coordinator" as const, reason: text(2_000),
      objective: { before: text(20_000), after: text(20_000) }, addedTaskKeys: ["task-0"], retiredTasks: [], dependencyUpdates: [], createdAt: 1 }))
    const targets = Array.from({ length: 600 }, (_, index) => ({ sessionID: `ses_${index}`, location: { directory: `/repo/${text(40)}` } }))
    const value = inspection([hugeTask(0, text), task(1, text(20_000)), hugeTask(2, text)], {
      objective: text(20_000), notes: text(20_000), summary: text(20_000), history,
      control: { id: "evt_stop", missionID: "msn_large", requestID: "stop", expectedRevision: 2, action: "stop", targets, pending: ["ses_0"] },
    })
    assert.ok(size(value) > 10 * MISSION_INSPECT_OUTPUT_LIMIT)
    assert.ok(assertComplete(value) > 20)
  }
})

test("unpaired high and low surrogates and U+FFFD, alike in UTF-8, keep distinct digests and refuse each other's reads", () => {
  // Each value's lead differs only in a character UTF-8 would encode as U+FFFD.
  const leads = ["\ud800", "\udbff", "\udc00", "\udfff", "�"]
  const notes = (lead: string) => `${lead}${"n".repeat(MISSION_INSPECT_OUTPUT_LIMIT)}`
  const reads = leads.map(lead => {
    const page = boundedInspection(inspection([], { notes: notes(lead) })) as { mission: { notes: { read: { content: MissionInspectContent } } } }
    return page.mission.notes.read.content
  })
  assert.equal(new Set(reads.map(read => read.digest)).size, leads.length, "one digest per string")
  for (const [index, read] of reads.entries()) {
    assert.ok(inspectionContent("msn_large", read, notes(leads[index])), "its own value reads")
    for (const other of leads.filter((_, at) => at !== index)) {
      assert.throws(() => inspectionContent("msn_large", read, notes(other)), /changed since its first slice/)
    }
  }
})

test("a task too large for a page alone has exact continuations and the reading advances", () => {
  const huge = hugeTask(1, length => "b".repeat(length))
  const value = inspection([task(0), huge, task(2)])
  const page = boundedInspection(value, 1) as Page & { mission: { tasks: Array<Record<string, unknown>> } }
  assert.ok(size(page) <= MISSION_INSPECT_OUTPUT_LIMIT)
  assert.deepEqual([page.mission.tasks.length, page.mission.tasks[0].key, page.taskPage!.nextTaskOffset], [1, "task-1", 2])
  // The report keeps its identity and outcome in place, with a read for each value it cannot hold.
  const report = page.mission.tasks[0].report as unknown as Record<string, { read?: { content: MissionInspectContent } }>
  assert.deepEqual([report.id, report.outcome], [huge.report!.id, "completed"])
  assert.deepEqual(report.evidence.read?.content, { kind: "report", reportId: huge.report!.id, field: "evidence", revision: 3,
    digest: digest(JSON.stringify(huge.report!.evidence)), offset: 0 })
  assert.deepEqual(resolve(page.mission.tasks[0], value), huge)
  assertComplete(value)
})

test("the task view carries every report of its task once and fits", () => {
  const huge = hugeTask(1, escaped)
  const value = inspection([huge])
  const view = { missionID: "msn_large", revision: 3, status: "active", frontier: [], task: { key: "task-1" },
    assignmentPrompt: escaped(60_000), reports: value.mission!.reports }
  const bounded = boundedTaskView(view, value.mission!, "task-1") as Record<string, unknown>
  assert.ok(size(bounded) <= MISSION_INSPECT_OUTPUT_LIMIT)
  // The plugin answers the view's own fields; the map answers the rest.
  const { note: _note, ...read } = resolve(bounded, value, { count: 0 }, content => content.kind === "task" && content.field === "assignmentPrompt"
    ? view.assignmentPrompt : inspectionContentValue(value, content)) as Record<string, unknown>
  assert.deepEqual(read, view)
  const small = { ...view, assignmentPrompt: "short", reports: [] }
  assert.equal(boundedTaskView(small, value.mission!, "task-1"), small)
})

test("a report list that gives way after values in it names the list as read, quickly", () => {
  // Hundreds of late reports (long IDs keep them large) and one whose values give way first.
  const late = Array.from({ length: 1_500 }, (_, index) => ({ ...report("task-1", "Done"), id: `rep_late_${index}`.padEnd(200, "x"),
    late: true, outcome: "failed" as const }))
  const value = inspection([{ ...task(1), status: "completed", report: hugeReport("rep_task-1", "task-1", escaped), lateReports: late }])
  const view = { missionID: "msn_large", revision: 3, status: "active", frontier: [], task: { key: "task-1" }, reports: value.mission!.reports }
  const started = performance.now()
  const bounded = boundedTaskView(view, value.mission!, "task-1") as Record<string, { read?: unknown }>
  assert.ok(performance.now() - started < 5_000, `fitted in ${Math.round(performance.now() - started)} ms`)
  assert.ok(size(bounded) <= MISSION_INSPECT_OUTPUT_LIMIT)
  assert.ok(bounded.reports.read, "the list gave way after its items' values")
  const { note: _note, ...read } = resolve(bounded, value) as Record<string, unknown>
  assert.deepEqual(read, view)
})

test("fitting stays linear: a thousand 20,000-character reports give way as one list, named as read", () => {
  const reports = Array.from({ length: 1_000 }, (_, index) => ({ id: `rpt_${String(index).padStart(28, "0")}`, taskKey: "task-1",
    sessionId: "ses_01234567890123456789012345", outcome: "completed" as const, summary: "s".repeat(20_000), evidence: [], next: [],
    createdAt: index + 1, late: true }))
  const value = inspection([{ ...task(1), status: "completed", lateReports: reports }], { status: "stopped" })
  const view = { missionID: "msn_large", revision: 3, status: "stopped", task: { key: "task-1" }, reports }
  const started = performance.now()
  const bounded = boundedTaskView(view, value.mission!, "task-1") as { reports: { omittedCharacters: number; read: { content: MissionInspectContent } } }
  const elapsed = performance.now() - started
  // The quadratic fit re-serialized the remaining envelope after each of the 1,000 summaries.
  assert.ok(elapsed < 4_000, `fitted in ${Math.round(elapsed)} ms`)
  assert.ok(size(bounded) <= MISSION_INSPECT_OUTPUT_LIMIT)
  const text = JSON.stringify(reports)
  assert.deepEqual([bounded.reports.omittedCharacters, bounded.reports.read.content.digest], [text.length, digest(text)],
    "the list as read, before its summaries gave way")
})

test("fitting stops as soon as the result fits: its running size is exact at every indentation", () => {
  // Many values that each save a few hundred characters: the result lands just under the limit.
  const medium = Array.from({ length: 100 }, (_, index) => ({ ...report("task-1", "x".repeat(1_000)), id: `rep_${index}`, late: true, outcome: "failed" as const }))
  const value = inspection([task(0), { ...task(1), status: "completed", lateReports: medium }])
  const view = { missionID: "msn_large", revision: 3, status: "active", task: { key: "task-1" }, reports: value.mission!.reports }
  // Reports two levels deep in the task view, late reports five levels deep in a task page.
  for (const [shape, bounded] of [["task view", boundedTaskView(view, value.mission!, "task-1")], ["task page", boundedInspection(value, 1)]] as const) {
    assert.ok(size(bounded) <= MISSION_INSPECT_OUTPUT_LIMIT, `${shape}: ${size(bounded)} characters`)
    assert.ok(size(bounded) > MISSION_INSPECT_OUTPUT_LIMIT - 1_500, `${shape}: no value gave way past the limit, ${size(bounded)} characters`)
  }
  assert.deepEqual(resolve(boundedTaskView(view, value.mission!, "task-1"), value), { ...view, note: (boundedTaskView(view, value.mission!, "task-1") as { note: string }).note })
})

test("the mission list pages entries and replaces a summary too large for one result", () => {
  const entries = Array.from({ length: 300 }, (_, index) => ({ missionID: `msn_${index}`, relation: "member", template: "custom",
    status: "completed", revision: 2, createdAt: 300 - index, summary: index === 7 ? escaped(20_000) : "s".repeat(2_000) }))
  const seen: string[] = []
  for (let offset: number | undefined = 0; offset !== undefined;) {
    const page = boundedMissionList(entries, offset) as { missions: Array<Record<string, unknown>>; listPage: { nextListOffset?: number } }
    assert.ok(size(page) <= MISSION_INSPECT_OUTPUT_LIMIT)
    for (const entry of page.missions) {
      seen.push(entry.missionID as string)
      if (entry.missionID !== "msn_7") continue
      const owner = inspection([], { id: "msn_7", revision: 2, summary: entries[7].summary })
      assert.equal(resolve(entry, owner).summary, entries[7].summary)
    }
    offset = page.listPage.nextListOffset
  }
  assert.deepEqual(seen, entries.map(entry => entry.missionID))
  assert.deepEqual(boundedMissionList(entries.slice(0, 2)), { missions: entries.slice(0, 2) })
})

test("content reads name exact values and refuse a changed map", () => {
  const value = inspection([hugeTask(0, length => "c".repeat(length))])
  const read = { kind: "report", reportId: "rep_late_0", field: "next", revision: 3, digest: digest("short"), offset: 0 } as const
  assert.deepEqual(inspectionContentValue(value, read), value.mission!.tasks[0].lateReports![0].next)
  assert.throws(() => inspectionContentValue(value, { ...read, revision: 2 }), /changed since this page/)
  assert.throws(() => inspectionContentValue(value, { ...read, field: "constructor" }), /unavailable/)
  assert.throws(() => inspectionContentValue(value, { kind: "inspection", field: "mission", revision: 3, digest: read.digest, offset: 0 }), /unavailable/)
  assert.throws(() => inspectionContentValue(value, { kind: "catalog", digest: read.digest, offset: 0 }), /unavailable/)
  assert.throws(() => inspectionContent("msn_large", { ...read, offset: 10_000_000 }, "short"), /past its end/)
})

test("a slice of a value read differently than its first slice is refused, whatever its length", () => {
  const before = { models: Array.from({ length: 2_000 }, (_, index) => ({ id: `a${index}`.padEnd(40, "m") })) }
  const after = { models: before.models.map(model => ({ id: model.id.replace(/^a/, "b") })) }
  assert.equal(JSON.stringify(after).length, JSON.stringify(before).length, "the same length")
  const first = inspectionContent(undefined, { kind: "catalog", digest: digest(JSON.stringify(before)), offset: 0 }, before) as Slice
  assert.ok(first.content.next && !("missionID" in first.content.next), "a catalog read names no mission")
  assert.throws(() => inspectionContent(undefined, first.content.next!.content, after), /changed since its first slice/)
  assert.ok(inspectionContent(undefined, first.content.next!.content, before))
  // A map value too: its revision alone does not version a value read afresh.
  const read = { kind: "task", taskKey: "task-0", field: "native", revision: 3, digest: digest(JSON.stringify(before)), offset: 0 } as const
  const slice = inspectionContent("msn_large", read, before) as Slice
  assert.throws(() => inspectionContent("msn_large", slice.content.next!.content, after), /changed since its first slice/)
})

test("an inspection without a mission replaces a catalog too large for one result by its read", () => {
  const catalog = { agents: [{ id: "build", mode: "all" }], models: Array.from({ length: 2_500 }, (_, index) =>
    ({ providerID: "fixture", id: `model-${index}`.padEnd(100, "m"), variants: ["high"] })) }
  const value = { mission: null, actor: null, templates: [], catalog } as unknown as MissionInspection
  const bounded = boundedInspection(value) as { catalog: { omittedCharacters: number; read: { content: MissionInspectContent } } }
  assert.ok(size(bounded) <= MISSION_INSPECT_OUTPUT_LIMIT)
  assert.deepEqual(Object.keys(bounded.catalog.read), ["content"])
  let content = bounded.catalog.read.content, text = ""
  for (;;) {
    const slice = inspectionContent(undefined, content, catalog) as Slice
    assert.ok(size(slice) <= MISSION_INSPECT_OUTPUT_LIMIT)
    text += slice.content.text
    if (!slice.content.next) break
    content = slice.content.next.content
  }
  assert.deepEqual(JSON.parse(text), catalog)
})

test("actors and the lifecycle control that give way are read back exactly", () => {
  const actors = Array.from({ length: 600 }, (_, index) => ({ sessionId: `ses_actor_${index}`, kind: "specialist" as const, managed: true,
    title: "Actor ".repeat(20), roles: ["worker"], location: { directory: "/repo" }, joinedAt: 1 }))
  const receipts = Array.from({ length: 600 }, (_, index) => ({ receiptID: `rcp_${index}`, sessionID: `ses_actor_${index}`, acknowledgementState: "unknown" as const }))
  const tasks = Array.from({ length: 200 }, (_, index) => ({ ...task(index, "d".repeat(1_000)), actorSessionId: `ses_actor_${3 * index}` }))
  const value = inspection(tasks, { actors, control: { id: "evt_stop", missionID: "msn_large", requestID: "stop", expectedRevision: 2, action: "stop",
    targets: actors.map(actor => ({ sessionID: actor.sessionId, location: actor.location })), pending: actors.map(actor => actor.sessionId), receipts } })
  const header = boundedInspection(value) as { mission: Record<string, { read?: unknown }> }
  assert.ok(header.mission.actors.read && header.mission.control.read)
  assertComplete(value)
})
