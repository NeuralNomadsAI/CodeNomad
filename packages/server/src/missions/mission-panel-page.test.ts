import assert from "node:assert/strict"
import test from "node:test"
import Ajv from "ajv"
import { compactMissionMap, missionTaskPage } from "./mission-compact-map"
import { fixture } from "./journal-history-fixture"
import { missionSummary } from "./mission-summary"
import { missionPluginFixture } from "./mission-plugin-fixture"
import { parseMissionEvent } from "./journal"
import type { MissionJsonValue, MissionMap } from "./model"
import { CODENOMAD_MISSIONS_RPC } from "./rpc"
import { MISSION_PANEL_PAGE_BYTES, MISSION_PANEL_PAGE_ROWS, MISSION_PANEL_REQUEST_BYTES, missionPanelPage,
  isMissionPanelPageResult, missionPanelPageRequestSchema, type MissionPanelCursor, type MissionPanelPageRequest, type MissionPanelPageResult } from "./mission-panel-page"

const valid = new Ajv({ allErrors: true }).compile(CODENOMAD_MISSIONS_RPC.methods.panelPage.output)
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value))
// Independent of the production counter: catch character-counting or omitted envelopes.
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8")

test("native alternatives and the shared HTTP validator require complete strict success/refusal shapes", () => {
  const page = missionPanelPage({ source: "summaries", projectID: "project-1" }, [])
  assert.ok(page.available)
  const invalid: unknown[] = [{ available: true }, { available: true, projectID: "project-1", source: "summaries" },
    { available: false }, { available: false, reason: "unknown" }, { ...page, available: false, reason: "changed" },
    { ...page, reason: "changed" }, { ...page, version: 2 }, { ...page, extra: true },
    { ...page, page: {} }, { ...page, page: { ...page.page, next: {} } },
    { ...page, page: { ...page.page, pieces: [{ index: 0, offset: 0, characters: 1 }] } }]
  for (const missing of ["version", "projectID", "source", "page"]) {
    const copy = { ...page } as Record<string, unknown>
    delete copy[missing]; invalid.push(copy)
  }
  for (const value of invalid) {
    assert.equal(valid(value), false, JSON.stringify(value))
    assert.equal(isMissionPanelPageResult(value), false, JSON.stringify(value))
  }
  for (const value of [page, { available: false, reason: "changed" }, { available: false, reason: "damaged" }]) {
    assert.ok(valid(value), JSON.stringify(valid.errors))
    assert.ok(isMissionPanelPageResult(value))
    assert.ok(bytes(value) <= MISSION_PANEL_PAGE_BYTES)
  }
})

/** Exact bounded traversal, including rows wider than a whole response. A failed read
 * supplies nothing to join; the saved cursor may be retried unchanged. */
async function traverse(read: (cursor?: MissionPanelCursor) => Promise<MissionPanelPageResult>) {
  const texts: string[] = [], sizes: number[] = []
  let cursor: MissionPanelCursor | undefined, digest: string | undefined, total = 0
  for (let calls = 0; ; calls++) {
    assert.ok(calls < 10_000, "each answer must progress")
    const answer = json(await read(cursor))
    assert.ok(valid(answer), JSON.stringify(valid.errors))
    assert.ok(answer.available, JSON.stringify(answer))
    sizes.push(bytes(answer))
    assert.ok(sizes.at(-1)! <= 65_536, `${sizes.at(-1)} bytes`)
    if (digest !== undefined) assert.equal(answer.page.digest, digest)
    digest = answer.page.digest; total = answer.page.total
    for (const piece of answer.page.pieces) {
      assert.equal(piece.offset, texts[piece.index]?.length ?? 0, "no gap or repeat")
      texts[piece.index] = (texts[piece.index] ?? "") + piece.text
      assert.ok(texts[piece.index].length <= piece.characters)
    }
    if (!answer.page.next) break
    assert.notDeepEqual(answer.page.next, cursor)
    cursor = answer.page.next
  }
  assert.equal(texts.length, total)
  return { values: texts.map(text => JSON.parse(text)), sizes }
}

test("serialized transfers bound wide nested rows, continuations, escaping and extensions; traversal reaches every byte", async t => {
  const rows = Array.from({ length: 400 }, (_, index) => ({ id: `id_${index}`, title: "\u0001😀\\\"".repeat(120),
    actorSessionIds: Array.from({ length: index === 7 ? 5_000 : 2 }, (_, actor) => `actor_${actor}_${"€".repeat(220)}`),
    control: { receipts: index === 20 ? Array.from({ length: 700 }, (_, item) => ({ item, reason: "\u0000".repeat(200) })) : [] },
    document: { id: "doc_1", revision: 2 }, documentPending: { requestID: "sync_1" }, history: [{ requestID: "revision_1" }] }))
  const header = { source: "summaries" as const, projectID: "€".repeat(240), cleanupUnavailable: true }
  assert.equal(MISSION_PANEL_PAGE_BYTES, 65_536)
  const { values, sizes } = await traverse(async cursor => missionPanelPage(header, rows, cursor))
  assert.deepEqual(values, rows)
  assert.ok(sizes.length > rows.length / MISSION_PANEL_PAGE_ROWS, "wide rows themselves require continuations")
  const first = missionPanelPage(header, rows)
  assert.ok(first.available && first.page.next)
  // Repeated reads are exact, and a failure between pages cannot consume a continuation.
  assert.deepEqual(missionPanelPage(header, rows, first.page.next), missionPanelPage(header, rows, first.page.next))
  assert.deepEqual(missionPanelPage(header, [{ ...rows[0], id: "changed" }, ...rows.slice(1)], first.page.next), { available: false, reason: "changed" })
  assert.deepEqual(missionPanelPage(header, rows, { ...first.page.next, index: rows.length + 1 }), { available: false, reason: "invalid-cursor" })
  assert.deepEqual(missionPanelPage(header, rows, { ...first.page.next, index: 0, offset: 1e9 }), { available: false, reason: "invalid-cursor" })
  t.diagnostic(`wire maximum ${Math.max(...sizes)} bytes, ${sizes.length} transfers, ${rows.length} exact rows including a 5,000-actor row`)
})

test("warm directory traversal reads no mission ranges; a requested mission reads only its own, with actors and cleanup identities intact", async t => {
  const f = fixture(1241), count = 600, actorCount = 300
  const seed = (value: Record<string, unknown>) => {
    const event = parseMissionEvent({ version: 1, projectID: f.project.id, ...value })
    assert.ok(event, String(value.id))
    f.tamper(`${f.prefix}/${event.missionID}/${event.id}`, event as unknown as MissionJsonValue)
  }
  for (let index = 0; index < count; index++) {
    const missionID = `msn_panel_${index}`
    seed({ id: "evt_created", missionID, type: "mission.created", projectCanonical: "/repo", objective: `Open mission ${index}`, template: "custom",
      coordinator: { sessionID: `ses_coordinator_${index}`, title: "Coordinator", location: f.project.location }, createdAt: index + 1 })
    // Pending tombstones, each with its original explicit-retry identity, exceed a page.
    if (index >= count / 2) seed({ id: "evt_deleted", missionID, type: "mission.deleted", requestID: `delete_${index}`, expectedRevision: 1,
      deleteManagedSessions: true, cleanupTargets: [{ sessionID: `ses_pending_${index}`, location: f.project.location }], createdAt: count + index })
  }
  for (let index = 0; index < actorCount; index++) {
    const taskKey = `task-${index}`, binding = { generation: 1, parentSessionID: "ses_coordinator_0", parentMessageID: `msg_${index}`, toolCallID: `call_${index}` }
    seed({ id: `evt_task_${index}`, missionID: "msn_panel_0", type: "task.created", task: { id: `tsk_${index}`, key: taskKey, title: "Actor task", brief: "Brief",
      role: "specialist", blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } }, createdAt: 10_000 + index * 2 })
    seed({ id: `evt_bound_${index}`, missionID: "msn_panel_0", type: "task.native-bound", taskKey, binding,
      actor: { sessionID: `ses_${index}_${"€".repeat(220)}`, title: "Actor", managed: true, location: f.project.location }, createdAt: 10_001 + index * 2 })
  }
  const full = await f.journal.snapshot()
  assert.equal(full.discardedEvents, 0)
  assert.equal(full.missions.length, 300)
  assert.equal(full.cleanups?.length, 300)
  const control = f.control()
  // One permitted hint-index build, then zero source scans throughout directory paging.
  await control.panelPage({ source: "summaries" })
  const scanned = f.scannedEntries(), scans = f.fullScans()
  const summaries = await traverse(cursor => control.panelPage({ source: "summaries", ...(cursor ? { cursor } : {}) }))
  const cleanups = await traverse(cursor => control.panelPage({ source: "cleanups", ...(cursor ? { cursor } : {}) }))
  assert.deepEqual(summaries.values, json(full.missions.map(missionSummary)))
  assert.deepEqual(cleanups.values, json(full.cleanups))
  assert.deepEqual([f.scannedEntries(), f.fullScans()], [scanned, scans], "no open-mission maps reread just to list rows")
  const target = full.missions.find(mission => mission.id === "msn_panel_0")!
  const before = f.scannedEntries()
  const actors = await traverse(cursor => control.panelPage({ source: "mission", missionID: target.id, field: "actors", ...(cursor ? { cursor } : {}) }))
  assert.deepEqual(actors.values, json(target.actors))
  assert.equal(f.fullScans(), scans)
  assert.equal(f.scannedEntries() - before, (1 + actorCount * 2) * actors.sizes.length, "only that mission's range, once per transfer")
  const task = await traverse(cursor => control.panelPage({ source: "tasks", task: { missionID: target.id, keys: ["task-299"] }, ...(cursor ? { cursor } : {}) }))
  assert.deepEqual(task.values, json([missionTaskPage(target, { keys: ["task-299"] })]))
  const own = await traverse(cursor => control.panelPage({ source: "mission", missionID: target.id, ...(cursor ? { cursor } : {}) }))
  assert.deepEqual(own.values, json([compactMissionMap(target)]))
  assert.deepEqual({ ...await f.journal.snapshot(), generatedAt: full.generatedAt }, full, "display reads never mutate authoritative maps")
  // A foreign write remains a hint until the 60-second rebuild.
  seed({ id: "evt_created", missionID: "msn_foreign", type: "mission.created", projectCanonical: "/repo", objective: "Foreign", template: "custom",
    coordinator: { sessionID: "ses_foreign", title: "Foreign", location: f.project.location }, createdAt: 99_999 })
  const stale = await control.panelPage({ source: "summaries" })
  assert.ok(stale.available); assert.equal(stale.page.total, 300)
  f.advanceIndexClock(60_000)
  const healed = await control.panelPage({ source: "summaries" })
  assert.ok(healed.available); assert.equal(healed.page.total, 301)
  t.diagnostic(`directory: ${summaries.sizes.length} summary + ${cleanups.sizes.length} cleanup transfers; 0 warm source reads; actor maximum ${Math.max(...actors.sizes)} bytes`)
})

test("real plugin registers the bounded opt-in contract and refuses oversized or mixed selectors with fixed-size results", async () => {
  const f = missionPluginFixture(), plugin = await f.plugin()
  try {
    const mission = (await f.control().create({ requestID: "panel", objective: "Panel", template: "custom" })).mission
    const page = await plugin.rpc("panelPage", { source: "mission", missionID: mission.id }) as MissionPanelPageResult
    assert.ok(valid(page), JSON.stringify(valid.errors)); assert.ok(page.available)
    assert.ok(bytes(page) <= MISSION_PANEL_PAGE_BYTES)
    assert.deepEqual(JSON.parse(page.page.pieces[0].text), json(compactMissionMap(mission)))
    const invalid = [null, { source: "summaries", missionID: mission.id }, { source: "mission", missionID: mission.id, field: "__proto__" },
      { source: "tasks", task: { missionID: mission.id, offset: 0, keys: ["work"] } },
      { source: "tasks", task: { missionID: mission.id, ids: Array(50).fill("€".repeat(240)) } }]
    assert.ok(bytes(invalid.at(-1)) > MISSION_PANEL_REQUEST_BYTES)
    for (const request of invalid) {
      assert.equal(missionPanelPageRequestSchema.safeParse(request).success, false)
      const result = await plugin.rpc("panelPage", request)
      assert.deepEqual(result, { available: false, reason: "invalid-request" })
      assert.ok(bytes(result) < 100)
    }
    assert.deepEqual(await plugin.rpc("panelPage", { source: "mission", missionID: "msn_absent" }), { available: false, reason: "mission-not-found" })
    assert.deepEqual(await plugin.rpc("panelPage", { source: "mission", missionID: mission.id, field: "absent" }), { available: false, reason: "field-not-found" })
  } finally { await plugin.dispose() }
})
