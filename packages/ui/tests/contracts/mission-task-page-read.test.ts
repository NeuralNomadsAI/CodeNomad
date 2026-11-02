import assert from "node:assert/strict"
import test from "node:test"
import { contentDigest } from "../../../server/src/missions/content-digest"
import { compactMissionMap, missionTaskPage } from "../../../server/src/missions/mission-compact-map"
import { missionPanelPage, MISSION_PANEL_PAGE_BYTES, MISSION_PANEL_REQUEST_BYTES, type MissionPanelPageRequest } from "../../../server/src/missions/mission-panel-page"
import type { MissionMap } from "../../../server/src/missions/model"
import { readMissionTaskPage, taskPageDigest, TASK_PAGE_RESPONSE_BYTES, TASK_PAGE_REQUEST_BYTES } from "../../src/lib/mission-task-page-read"
import { TASK_WINDOW_CHARACTERS, TASK_WINDOW_TOKENS, TASK_WINDOW_DEPTH } from "../../src/lib/mission-task-window-budget"
import { readFileSync } from "node:fs"

const map: MissionMap = { version: 1, id: "wide", projectID: "project", projectCanonical: "/fixture", objective: "Wide", template: "custom", status: "active",
  coordinatorSessionId: "coordinator", actors: [], tasks: Array.from({ length: 151 }, (_, index) => ({ id: `tsk_${index}`, key: `t${index}`, title: "\0".repeat(239) + "x",
    brief: "Brief", role: "worker", blockedBy: [], status: "ready", outstandingExecution: false, createdAt: index, updatedAt: index })),
  reports: [], history: [], historyTruncated: false, frontier: [], claims: [], createdAt: 1, updatedAt: 1, revision: 7 }
const header = { projectID: map.projectID, missionID: map.id, source: "tasks" as const, revision: map.revision,
  discardedEvents: 0, controlUnavailable: false, notificationUnavailable: false, cleanupUnavailable: false }
const answer = (request: MissionPanelPageRequest) => {
  assert.equal(request.source, "tasks")
  if (request.source !== "tasks") throw new Error("Wrong source")
  return missionPanelPage(header, [missionTaskPage(map, request.task)], request.cursor)
}
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } })
const scope = { projectID: "project", current: () => true }

test("task reads traverse exact byte slices of one requested window, with native UTF-16 digests", async t => {
  assert.equal(TASK_PAGE_RESPONSE_BYTES, MISSION_PANEL_PAGE_BYTES); assert.equal(TASK_PAGE_REQUEST_BYTES, MISSION_PANEL_REQUEST_BYTES)
  for (const text of ["", "😀\u0000", "\ud800", "\ud801"]) assert.equal(await taskPageDigest(text), contentDigest(text))
  const seen = new Set<string>(), sizes: number[] = []
  let transfers = 0
  for (let offset = 0; offset < map.tasks.length; offset += 50) {
    const result = await readMissionTaskPage(map.id, { offset }, { ...scope, exchange: async body => {
      assert.ok(Buffer.byteLength(body) <= 16_384)
      const value = answer(JSON.parse(body)); transfers++
      sizes.push(Buffer.byteLength(JSON.stringify(value)))
      return response(value)
    } })
    assert.ok(result.available && "tasks" in result)
    assert.deepEqual(result.tasks, missionTaskPage(map, { offset }).tasks)
    for (const task of result.tasks) seen.add(task.id)
  }
  assert.equal(seen.size, 151); assert.ok(transfers > 4); assert.equal(Math.max(...sizes), 65_536)
  t.diagnostic(`151 tasks in four requested windows: ${transfers} HTTP transfers, max ${Math.max(...sizes)} bytes`)
})

test("task assembly refuses malformed identity, length, offsets, damage and digests before returning rows", async t => {
  for (const poison of ["digest", "next-digest", "length", "offset", "project", "mission", "revision", "damage", "missing-damage", "extra-header", "wire-bytes", "changed", "unavailable"]) {
    await t.test(poison, async () => {
      let calls = 0
      await assert.rejects(readMissionTaskPage(map.id, { offset: 50 }, { ...scope, exchange: async body => {
        const value = answer(JSON.parse(body))
        assert.ok(value.available); calls++
        if (poison === "changed" && calls === 2) return response({ available: false, reason: "changed" })
        if (poison === "unavailable") return new Response("Unavailable", { status: 503 })
        if (poison === "wire-bytes") return new Response(JSON.stringify(value) + " ".repeat(65_536))
        if (poison === "digest") value.page.digest = "x".repeat(43)
        if (poison === "next-digest" && value.page.next) value.page.next.digest = "x".repeat(43)
        if (poison === "length" && calls === 2) value.page.pieces[0].characters++
        if (poison === "offset") value.page.pieces[0].offset++
        if (poison === "project") value.projectID = "foreign"
        if (poison === "mission") value.missionID = "evil"
        if (poison === "revision" && calls === 2) value.revision!++
        if (poison === "damage") value.controlUnavailable = true
        if (poison === "missing-damage") delete value.notificationUnavailable
        if (poison === "extra-header") Object.assign(value, { unknown: true })
        return response(value)
      } }), error => Boolean(error && typeof error === "object" && "reason" in error && error.reason === (poison === "changed" ? "changed"
        : poison === "unavailable" ? "unavailable" : poison === "damage" ? "damaged" : "invalid")))
      assert.ok(calls <= 3, "a refusal never automatically restarts or falls back")
    })
  }
})

test("the final row digest is checked even with a stable forged envelope, and a stale slice cannot launch its continuation", async () => {
  const row = missionTaskPage(map, { offset: 150 }), bad = missionPanelPage(header, [row])
  assert.ok(bad.available && !bad.page.next)
  bad.page.digest = "x".repeat(43)
  await assert.rejects(readMissionTaskPage(map.id, { offset: 150 }, { ...scope, exchange: async () => response(bad) }), { reason: "invalid" })
  let current = true, calls = 0
  await assert.rejects(readMissionTaskPage(map.id, { offset: 50 }, { ...scope, current: () => current, exchange: async body => {
    calls++; current = false; return response(answer(JSON.parse(body)))
  } }), { name: "AbortError" })
  assert.equal(calls, 1)
})

test("every slice retains the admitted selector even if its caller edits the request", async () => {
  const selector = { offset: 50 }, offsets: number[] = []
  const result = await readMissionTaskPage(map.id, selector, { ...scope, exchange: async body => {
    const request = JSON.parse(body)
    offsets.push(request.task.offset); selector.offset = 100
    return response(answer(request))
  } })
  assert.ok(result.available && "tasks" in result)
  assert.deepEqual(result.tasks, missionTaskPage(map, { offset: 50 }).tasks)
  assert.ok(offsets.length > 1); assert.deepEqual([...new Set(offsets)], [50])
})

for (const mode of ["oversize", "http-error"] as const) test(`deferred ${mode} cancellation cannot retain API queue slots past the task lifetime`, async t => {
  const { serverApi } = await import("../../src/lib/api-client")
  const { backgroundReads } = await import("../../src/lib/background-read-queue")
  const original = globalThis.fetch
  let rejectCancel!: (error: Error) => void, starts = 0, cancels = 0, released = false
  const cancellation = new Promise<void>((_, reject) => { rejectCancel = reject })
  const keepAlive = setTimeout(() => {}, 3000) // native AbortSignal timers are unref'ed in Node
  const deadline = performance.now() + 200
  const dispatched: Array<{ at: number; aborted: boolean }> = []
  globalThis.fetch = async (_input, init) => {
    starts++
    dispatched.push({ at: performance.now(), aborted: init?.signal?.aborted === true })
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(65_537)) },
      cancel() { cancels++; return cancellation },
    }), { status: mode === "http-error" ? 503 : 200 })
  }
  const calls = Array.from({ length: 3 }, () => serverApi.fetchMissionTasks("fixture", map.id, { offset: 0 }, { ...scope, deadline }))
  let markerStarted = false, startedAfterDeadline = false, startedWhileDeferred = false
  const marker = backgroundReads.run(AbortSignal.timeout(1000), async () => {
    markerStarted = true; startedAfterDeadline = performance.now() >= deadline; startedWhileDeferred = !released
  }).then(() => true, () => false)
  try {
    const outcomes = await Promise.allSettled(calls)
    assert.equal(await marker, true, "unrelated queued work starts without resolving the deferred cancels")
    t.diagnostic(JSON.stringify({ deadline, dispatched, starts, cancels }))
    assert.ok(starts >= 2 && starts <= 3)
    assert.equal(cancels, starts)
    assert.ok(dispatched.every(read => !read.aborted && read.at < deadline), "native timer rounding never permits a transfer after its original deadline")
    assert.deepEqual({ markerStarted, startedAfterDeadline, startedWhileDeferred },
      { markerStarted: true, startedAfterDeadline: true, startedWhileDeferred: true })
    assert.ok(outcomes.every(value => value.status === "rejected"), "no stale row is published")
    for (const outcome of outcomes.slice(0, 2)) {
      assert.equal(outcome.status === "rejected" && outcome.reason.reason, mode === "oversize" ? "invalid" : "unavailable", "cleanup preserves the original failure")
    }
  } finally {
    released = true; rejectCancel(new Error("late cancellation rejection"))
    await Promise.allSettled(calls); await marker
    await backgroundReads.run(new AbortController().signal, async () => {})
    clearTimeout(keepAlive); globalThis.fetch = original
  }
})

test("correctly hashed wrong selectors, inconsistent counters, foreign reports and invalid nested rows are refused", async t => {
  const full = structuredClone(map)
  full.reports = [120, 121].map(index => ({ id: `rep${index}`, taskKey: `t${index}`, sessionId: "coordinator", outcome: "completed", summary: "Result", evidence: [], next: [], createdAt: 1 }))
  const cases = [
    { name: "key", request: { keys: ["t120"] }, row: missionTaskPage(full, { keys: ["t121"] }) },
    { name: "id", request: { ids: ["tsk_120"] }, row: missionTaskPage(full, { ids: ["tsk_121"] }) },
    { name: "report ID", request: { reportIds: ["rep120"] }, row: missionTaskPage(full, { reportIds: ["rep121"] }) },
  ]
  for (const poison of ["counters", "foreign report", "nested report", "late reports", "late cardinality", "bodies", "body count", "execution", "native execution"]) {
    const row = missionTaskPage(full, { keys: ["t120"] })
    if (poison === "counters") row.taskPage.counts.ready = 999
    if (poison === "foreign report") row.reports[0].taskKey = "unrequested"
    if (poison === "nested report") row.tasks[0].report = { ...row.reports[0], taskKey: "unrequested" }
    if (poison === "late reports") row.tasks[0].lateReports = Array(1000).fill({ bogus: true })
    if (poison === "late cardinality") {
      row.tasks[0].lateReports = Array(2).fill(row.reports[0]); row.tasks[0].lateReportCount = 2; row.tasks[0].reportCount = 2
    }
    if (poison === "bodies") row.tasks[0].bodies = { brief: { characters: -1, digest: "x".repeat(43) } }
    if (poison === "body count") row.tasks[0].bodies = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`field${i}`, { characters: 0, digest: contentDigest("") }]))
    if (poison === "execution") Object.assign(row.tasks[0], { execution: { agent: 42 } })
    if (poison === "native execution") Object.assign(row.tasks[0], { nativeExecution: { binding: "invalid" } })
    cases.push({ name: poison, request: { keys: ["t120"] }, row })
  }
  for (const value of cases) await t.test(value.name, async () => {
    await assert.rejects(readMissionTaskPage(map.id, value.request, { ...scope, exchange: async body =>
      response(missionPanelPage(header, [value.row], JSON.parse(body).cursor)) }), { reason: "invalid" })
  })
})

test("named absence, explicit taskless reports and ready tasks that legitimately need report recovery remain valid", async () => {
  const full = structuredClone(map)
  full.tasks = full.tasks.map(task => ({ ...task, actorSessionId: "worker", admissionId: "admitted", outstandingExecution: true }))
  full.reports.push({ id: "taskless", taskKey: "removed-task", sessionId: "coordinator", outcome: "completed", summary: "History", evidence: [], next: [], createdAt: 1 })
  for (const request of [{ keys: ["absent"] }, { reportIds: ["taskless"] }, { attention: 0 }]) {
    const expected = missionTaskPage(full, request)
    const result = await readMissionTaskPage(map.id, request, { ...scope, exchange: async body => response(missionPanelPage(header, [expected], JSON.parse(body).cursor)) })
    assert.ok(result.available && "tasks" in result)
    assert.deepEqual(result.tasks, expected.tasks); assert.deepEqual(result.reports, expected.reports)
  }
  const base = compactMissionMap(full), context = { revision: full.revision, order: base.taskPage!.order, total: base.taskPage!.total,
    counts: base.taskPage!.counts, reports: base.taskPage!.reports,
    excludedKeys: base.tasks.map(task => task.key), attention: base.taskPage!.attention }
  const selected = missionTaskPage(full, { attention: 0 })
  const sameRevision = await readMissionTaskPage(map.id, { attention: 0 }, { ...scope, context,
    exchange: async body => response(missionPanelPage(header, [selected], JSON.parse(body).cursor)) })
  assert.ok(sameRevision.available)
  for (const offset of [50, 100]) { // pins, then eligible tasks from the wrong omitted window
    const forged = missionTaskPage(full, { attention: 0 })
    forged.tasks = missionTaskPage(full, { offset }).tasks
    if (forged.tasks.length !== selected.tasks.length) continue
    await assert.rejects(readMissionTaskPage(map.id, { attention: 0 }, { ...scope, context,
      exchange: async body => response(missionPanelPage(header, [forged], JSON.parse(body).cursor)) }), { reason: "invalid" })
  }
  const falseAttention = missionTaskPage(full, { attention: 0 })
  falseAttention.tasks = missionTaskPage(map, { offset: 100 }).tasks
  // Same lengths, positions, status counters and hashes; these ready rows have no
  // admitted/outstanding work or pending notification that could make them attention.
  await assert.rejects(readMissionTaskPage(map.id, { attention: 0 }, { ...scope, exchange: async body =>
    response(missionPanelPage(header, [falseAttention], JSON.parse(body).cursor)) }), { reason: "invalid" })
  const badCounts = missionTaskPage(full, { attention: 0 })
  badCounts.taskPage.attention!.counts.recovery = 0
  await assert.rejects(readMissionTaskPage(map.id, { attention: 0 }, { ...scope, exchange: async body =>
    response(missionPanelPage(header, [badCounts], JSON.parse(body).cursor)) }), { reason: "invalid" })
})

test("logical text and unknown metadata structure are bounded before hash allocation", async () => {
  for (const poison of ["characters", "tokens", "depth"]) {
    const row = missionTaskPage(map, { offset: 150 })
    Object.assign(row.tasks[0], { extension: poison === "characters" ? "x".repeat(TASK_WINDOW_CHARACTERS)
      : poison === "tokens" ? Array(TASK_WINDOW_TOKENS + 1).fill(null)
        : Array.from({ length: TASK_WINDOW_DEPTH + 1 }).reduce<unknown>(value => ({ nested: value }), null) })
    let calls = 0, hashes = 0
    const original = crypto.subtle.digest.bind(crypto.subtle)
    crypto.subtle.digest = (...args) => { hashes++; return original(...args) }
    try {
      await assert.rejects(readMissionTaskPage(map.id, { offset: 150 }, { ...scope, exchange: async body => {
        calls++; return response(missionPanelPage(header, [row], JSON.parse(body).cursor))
      } }), { reason: "too-large" })
      assert.equal(hashes, 0)
      if (poison === "characters") assert.equal(calls, 1, "advertised logical length refuses before assembly")
    } finally { crypto.subtle.digest = original }
  }
  const row = missionTaskPage(map, { offset: 150 }), metadata = { document: { label: "😀\ud800", unknown: Array(10).fill("preserved") } }
  Object.assign(row.tasks[0], { extension: metadata })
  const result = await readMissionTaskPage(map.id, { offset: 150 }, { ...scope, exchange: async body => response(missionPanelPage(header, [row], JSON.parse(body).cursor)) })
  assert.ok(result.available && "tasks" in result)
  assert.deepEqual((result.tasks[0] as unknown as { extension: unknown }).extension, metadata)
})

test("refusal alternatives are strict and preserve damaged / changed classifications", async () => {
  for (const [value, reason] of [
    [{ available: false, reason: "damaged" }, "damaged"], [{ available: false, reason: "changed" }, "changed"],
    [{ available: false, reason: "changed", unexpected: true }, "invalid"], [{ available: false, reason: "unknown" }, "invalid"],
    [{ available: false, reason: "invalid-cursor" }, "invalid"], [{ available: false, reason: "plugin-unavailable", missions: [] }, "unavailable"],
  ] as const) await assert.rejects(readMissionTaskPage(map.id, { offset: 0 }, { ...scope, exchange: async () => response(value) }), { reason })
})

test("a digest delayed beyond the logical deadline cannot parse or return a row", async () => {
  const original = crypto.subtle.digest.bind(crypto.subtle)
  let release!: () => void, entered!: () => void, work!: Promise<ArrayBuffer>, released = false
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const timer = setTimeout(() => { released = true; release() }, 500) // keep Node alive while its native AbortSignal timer is unref'ed
  crypto.subtle.digest = (...args) => { entered(); return work = gate.then(() => original(...args)) }
  try {
    const pending = readMissionTaskPage(map.id, { offset: 151 }, { ...scope, deadline: performance.now() + 100,
      exchange: async body => response(answer(JSON.parse(body))) })
    const rejected = assert.rejects(pending, { name: "TimeoutError" })
    await started; await rejected
    assert.equal(released, false, "the deadline settles without waiting for the late digest")
    release(); await work
  } finally { clearTimeout(timer); release?.(); crypto.subtle.digest = original }
})

test("the logical budget admits maximal journal-width dependencies and compact native/report rows", async t => {
  const full = structuredClone(map), wide = "\0".repeat(239) + "x", native = '"'.repeat(239) + "x"
  full.tasks = full.tasks.slice(0, 50).map((task, index) => {
    const binding = { generation: 1, parentSessionID: native, parentMessageID: native, toolCallID: native }
    const reports = Array.from({ length: 4 }, (_, part) => ({ id: `rep_${index}_${part}`, taskKey: task.key, sessionId: wide, outcome: "completed" as const,
      summary: wide.repeat(80), evidence: [], next: [], nativeCall: binding, createdAt: index * 4 + part + 1, ...(part === 1 ? { late: true } : {}) }))
    full.reports.push(...reports)
    return { ...task, blockedBy: Array(24).fill(wide), actorSessionId: native, nativeBinding: binding, nativeExecution: { binding, ended: "returned" as const, observations: [] },
      execution: { agent: native, model: { providerID: native, id: native, variant: native } }, report: reports[0], lateReports: [reports[1]] }
  })
  const request = { reportIds: full.tasks.map((_, index) => `rep_${index}_2`) }
  const expected = missionTaskPage(full, request), text = JSON.stringify(expected)
  assert.equal(expected.reports.length, 200)
  assert.ok(text.length < TASK_WINDOW_CHARACTERS)
  let transfers = 0
  const result = await readMissionTaskPage(map.id, request, { ...scope, exchange: async body => {
    transfers++; return response(missionPanelPage(header, [expected], JSON.parse(body).cursor))
  } })
  assert.ok(result.available && "tasks" in result)
  assert.deepEqual(result.tasks, expected.tasks)
  t.diagnostic(`max-width 50-task/200-report window: ${text.length} JSON units, ${transfers} transfers`)
})

test("the store's serialized wait shares the same real 30-second API deadline", { timeout: 45_000 }, async () => {
  const { createMissionStore } = await import("../../src/stores/mission-store")
  const { serverApi } = await import("../../src/lib/api-client")
  const full = structuredClone(map); full.tasks = full.tasks.map(task => ({ ...task, title: task.key }))
  const listed = { available: true as const, version: 1 as const, projectID: map.projectID, missions: [(await import("../../../server/src/missions/mission-compact-map")).compactMissionMap(full)], generatedAt: 1,
    discardedEvents: 0, activity: { generatedAt: 1, missions: [] } }
  const original = globalThis.fetch, starts: number[] = [], start = performance.now()
  globalThis.fetch = async (_url, init) => {
    starts.push(performance.now() - start)
    await new Promise<void>((resolve, reject) => {
      const signal = init!.signal!, done = () => { signal.removeEventListener("abort", abort); resolve() }
      const timer = setTimeout(done, 20_000), abort = () => { clearTimeout(timer); reject(signal.reason) }
      signal.addEventListener("abort", abort, { once: true })
    })
    const request = JSON.parse(init!.body as string)
    return response(missionPanelPage(header, [missionTaskPage(full, request.task)], request.cursor))
  }
  try {
    const store = createMissionStore(async () => listed, (id, mission, task, scope) => serverApi.fetchMissionTasks(id, mission, task, scope))
    store.want("fixture", "reader", map.id, true); await store.ensure("fixture")
    assert.deepEqual(await Promise.all([store.loadTasks("fixture", map.id, { offset: 50 }), store.loadTasks("fixture", map.id, { offset: 100 })]), ["read", "failed"])
    assert.equal(store.state("fixture").taskReads?.[map.id]?.failure?.reason, "deadline")
    assert.ok(performance.now() - start < 35_000); assert.equal(starts.length, 2)
    assert.equal(store.state("fixture").missions[0].tasks.length, 100)
  } finally { globalThis.fetch = original }
})

test("Spanish and Hebrew task help use their exact Retry labels", () => {
  for (const [locale, wrong] of [["es", "Volver a intentar"], ["he", "ניסיון חוזר"]]) {
    const ui = readFileSync(new URL(`../../src/lib/i18n/messages/${locale}/missions.ts`, import.meta.url), "utf8")
    const label = /"missions\.control\.retry": "([^"]+)"/.exec(ui)?.[1]
    assert.ok(label)
    const help = readFileSync(new URL(`../../../../docs/help/${locale}/missions.md`, import.meta.url), "utf8").split("{#status-colours}")[0]
    assert.ok(help.includes(`**${label}**`)); assert.ok(!help.includes(`**${wrong}**`))
  }
})
