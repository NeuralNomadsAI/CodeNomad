import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"

// Completions carry the project's finish numbers; a project holds any number of them.
const completion = (index: number) => ({ id: `msn_${index.toString(16).padStart(24, "0")}`, finishSequence: 1 + index })
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => completion(from + index))
const reload = process.env.MISSION_SEEN_STORAGE
const storage = new Map<string, string>(JSON.parse(reload ?? "[]"))
Object.assign(globalThis, { window: {
  localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key) },
  electronAPI: { claimClientStateAccess: async () => true,
    loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: null }), saveClientState: async () => true },
} })
const { initializeClientState } = await import("./client-state")
await initializeClientState()
const { markMissionsFinishedSeen, seedMissionFinishedSeen, missionDisclosureOpen, missionFinishedSeen, missionProjectView, setMissionDisclosureOpen, updateMissionProjectView } = await import("./mission-view-state")
const playbookReader = { missionId: "debug", kind: "playbook", taskMode: "independent" } as const

// The completions a project lists at the end, with whether each reads as seen.
const listed = range(1_000, 6_000)
const seen = (from: readonly ReturnType<typeof completion>[]) => from.map(item => missionFinishedSeen("project", item))

/** A fresh window over this window's saved layout runs this file's checks named in `checks`. */
function reloadWith(checks: Record<string, string>) {
  const { NODE_TEST_CONTEXT: _parent, ...env } = process.env
  const output = execFileSync(process.execPath, ["--conditions=browser", "--import", "tsx", fileURLToPath(import.meta.url)],
    { env: { ...env, MISSION_SEEN_STORAGE: JSON.stringify([...storage]), ...checks }, encoding: "utf8" })
  assert.match(output, /pass 1\b/)
  assert.match(output, /fail 0\b/)
}

type Finished = { id: string; revision: number; updatedAt: number; finishSequence?: number; coordinatorSessionId: string; status: string }
interface Control {
  create(input: Record<string, unknown>): Promise<{ mission: Finished }>
  report(sessionID: string, input: Record<string, unknown>): Promise<{ mission: Finished }>
  delete(input: Record<string, unknown>): Promise<unknown>
  list(input: Record<string, unknown>): Promise<{ summaries?: Finished[] }>
}

/** Real controls over one project's native storage, each new, as after a plugin reload.
 * Loaded by path: the server modules stay out of this package's type program. */
async function projectControls() {
  const server = "../../../server/src/missions"
  const { MissionControl } = await import(`${server}/control`) as { MissionControl: new (options: unknown) => Control }
  const { MissionJournal } = await import(`${server}/journal`) as { MissionJournal: new (...args: unknown[]) => { purgeDeleted(options: { all: boolean }): Promise<number> } }
  const values = new Map<string, unknown>(), sessions = new Map<string, Record<string, unknown>>()
  const missionStorage = {
    get: async (key: string) => structuredClone(values.get(key)), set: async (key: string, value: unknown) => { values.set(key, structuredClone(value)) },
    remove: async (key: string) => { values.delete(key) },
    scan: async ({ prefix, after, limit = 100 }: { prefix: string; after?: string; limit?: number }) => {
      const keys = [...values.keys()].filter(key => key.startsWith(prefix) && (!after || key > after)).sort().slice(0, limit)
      return { entries: keys.map(key => ({ key, value: structuredClone(values.get(key)) })), next: keys.length === limit ? keys.at(-1) : undefined }
    },
  }
  const project = { id: "project", canonical: "/repo", location: { directory: "/repo" } }
  let now = 1_000_000
  const control = () => new MissionControl({ project, storage: missionStorage as never, now: () => now, sessions: {
    get: async ({ sessionID }: { sessionID: string }) => { if (!sessions.has(sessionID)) throw new Error("missing"); return sessions.get(sessionID) },
    create: async (input: Record<string, unknown>) => { const session = { ...input, projectID: project.id }; sessions.set(input.id as string, session); return session },
    prompt: async () => {}, synthetic: async () => {},
  } as never })
  return {
    control, setNow: (value: number) => { now = value },
    finish: async (requestID: string) => {
      const created = (await control().create({ requestID, objective: requestID, template: "custom" })).mission
      return (await control().report(created.coordinatorSessionId, { missionID: created.id, outcome: "completed", summary: "Done",
        evidence: [], next: [], final: true })).mission
    },
    completed: async () => ((await control().list({})).summaries ?? []).filter(row => row.status === "completed"),
    purge: () => new MissionJournal(missionStorage as never, project.id, project.canonical).purgeDeleted({ all: true }),
  }
}

if (reload) {
  if (process.env.MISSION_COLLISION_CHECK) test("legacy collision positives survive reload before the originally viewed row is discovered", () => {
    const { folder, scope, rows } = JSON.parse(process.env.MISSION_COLLISION_CHECK!)
    assert.deepEqual(rows.map((row: ReturnType<typeof completion>) => missionFinishedSeen(scope, row)), [true, false, true, true])
    seedMissionFinishedSeen(scope, 100, folder, [rows[3]])
    assert.equal(missionFinishedSeen(scope, rows[2]), true)
    seedMissionFinishedSeen(scope, 101, folder, [rows[2]])
    assert.deepEqual(rows.map((row: ReturnType<typeof completion>) => missionFinishedSeen(scope, row)), [true, false, true, true])
    assert.equal(missionFinishedSeen(scope, { id: "later", finishSequence: 5 }), false)
  })
  if (process.env.MISSION_UPGRADE_CHECK) test("a partial folder upgrade retains undiscovered positive exceptions across reload", () => {
    const { folder, scope, rows } = JSON.parse(process.env.MISSION_UPGRADE_CHECK!)
    assert.deepEqual(rows.map((row: ReturnType<typeof completion>) => missionFinishedSeen(scope, row)), [true, false, true])
    seedMissionFinishedSeen(scope, 99, folder, rows.slice(1))
    assert.deepEqual(rows.map((row: ReturnType<typeof completion>) => missionFinishedSeen(scope, row)), [true, false, true])
    seedMissionFinishedSeen(scope, 100, folder, rows)
    assert.equal(missionFinishedSeen(scope, { id: "later", finishSequence: 4 }), false)
  })
  if (process.env.MISSION_SEEN_EXPECTED) test("a fresh window keeps every seen completion and every unseen one, and the newest toggled sections", () => {
    assert.deepEqual(seen(listed), JSON.parse(process.env.MISSION_SEEN_EXPECTED!))
    assert.equal(missionFinishedSeen("project", completion(6_000)), false, "a later completion starts unseen")
    assert.equal(missionDisclosureOpen("msn_sections", "task-399"), false)
    assert.equal(missionDisclosureOpen("msn_sections", "task-85"), false)
    assert.equal(missionDisclosureOpen("msn_sections", "task-0"), true, "the oldest toggles fall back to their default")
  })
  if (process.env.MISSION_ORDER_CHECKS) test("a fresh window keeps the mark of a completion finished after a deletion and an earlier clock", () => {
    for (const check of JSON.parse(process.env.MISSION_ORDER_CHECKS!)) assert.equal(missionFinishedSeen("ordered", check.completion), check.seen)
  })
  if (process.env.MISSION_PLAYBOOK_CHECK) test("a fresh window restores a playbook reader and drops one naming no playbook", () => {
    assert.deepEqual(missionProjectView("project").reader, playbookReader)
    assert.equal(missionProjectView("unknown-playbook").reader, undefined)
  })
} else {
  test("discovering a colliding legacy positive first preserves the original seen mission and unopened boundary", () => {
    const folder = "/legacy-collision", scope = JSON.stringify([folder, "project"])
    const rows = [{ id: "historical", finishSequence: 1 }, { id: "unopened", finishSequence: 2 },
      { id: "msn_6afe5522b1991b38a5536702", finishSequence: 3 }, { id: "msn_25cb5286530d0229edc48088", finishSequence: 4 }]
    markMissionsFinishedSeen(folder, [], rows.slice(0, 1)); markMissionsFinishedSeen(folder, [rows[2].id], rows)
    seedMissionFinishedSeen(scope, 4, folder, rows.slice(0, 1))
    assert.equal(missionFinishedSeen(scope, rows[2]), true)
    seedMissionFinishedSeen(scope, 99, folder, [rows[3]])
    assert.deepEqual(rows.map(row => missionFinishedSeen(scope, row)), [true, false, true, true])
    reloadWith({ MISSION_COLLISION_CHECK: JSON.stringify({ folder, scope, rows }) })
  })
  test("folder completion upgrade keeps boundary and pending positives through partial discovery and reload", () => {
    const folder = "old-folder-upgrade", scope = JSON.stringify([folder, "project"]), rows = range(0, 3)
    markMissionsFinishedSeen(folder, [], rows.slice(0, 1))
    markMissionsFinishedSeen(folder, [rows[2].id], rows)
    seedMissionFinishedSeen(scope, 3, folder, rows.slice(0, 1))
    assert.equal(missionFinishedSeen(scope, rows[1]), false, "new key must inherit the old unopened boundary")
    assert.equal(missionFinishedSeen(scope, rows[2]), true, "pending ID evidence stays seen before its exact row is discovered")
    reloadWith({ MISSION_UPGRADE_CHECK: JSON.stringify({ folder, scope, rows }) })
    seedMissionFinishedSeen(scope, 30, folder, rows.slice(1))
    assert.deepEqual(rows.map(row => missionFinishedSeen(scope, row)), [true, false, true])
    reloadWith({ MISSION_UPGRADE_CHECK: JSON.stringify({ folder, scope, rows }) })
    const same = "same-key-positive-upgrade"
    markMissionsFinishedSeen(same, [], rows.slice(0, 1)); markMissionsFinishedSeen(same, [rows[2].id], rows)
    seedMissionFinishedSeen(same, 3, undefined, rows)
    assert.deepEqual(rows.map(row => missionFinishedSeen(same, row)), [true, false, true])
  })
  test("partial inventory seeds once from the durable finish boundary and never marks an undiscovered new finish seen", () => {
    const old = { id: "old", finishSequence: 1 }, deleted = { id: "deleted", finishSequence: 2 }, fresh = { id: "fresh", finishSequence: 3 }, shown = { id: "shown", finishSequence: 4 }
    seedMissionFinishedSeen("partial", 2)
    markMissionsFinishedSeen("partial", [], [old], true)
    assert.equal(missionFinishedSeen("partial", deleted), true, "later discovered historical completion is already seen")
    assert.equal(missionFinishedSeen("partial", fresh), false)
    markMissionsFinishedSeen("partial", [shown.id], [shown], true)
    assert.equal(missionFinishedSeen("partial", fresh), false, "a later shown page cannot cover the missing new completion")
    seedMissionFinishedSeen("partial", 4)
    markMissionsFinishedSeen("partial", [], [old, deleted], true)
    assert.equal(missionFinishedSeen("partial", fresh), false, "later traversal/refresh never reseeds")
    assert.equal(missionFinishedSeen("partial", shown), true, "partial pages retain explicitly shown IDs")
  })
  test("a stored whole-inventory watermark keeps unseen finishes while partial views record exact seen sequences", () => {
    const historical = { id: "historical", finishSequence: 2 }, fresh = { id: "fresh", finishSequence: 3 }
    markMissionsFinishedSeen("migration", [], [historical])
    seedMissionFinishedSeen("migration", 9)
    assert.equal(missionFinishedSeen("migration", historical), true)
    assert.equal(missionFinishedSeen("migration", fresh), false)
    markMissionsFinishedSeen("migration", [fresh.id], [fresh], true)
    assert.equal(missionFinishedSeen("migration", fresh), true)
    assert.equal(missionFinishedSeen("migration", { id: "unloaded", finishSequence: 4 }), false)
  })
  test("a playbook reader survives a reload, and one naming no playbook does not", () => {
    updateMissionProjectView("project", { reader: playbookReader })
    updateMissionProjectView("unknown-playbook", { reader: { missionId: "toString", kind: "playbook" } })
    reloadWith({ MISSION_PLAYBOOK_CHECK: "1" })
  })
  test("seen completions scale with thousands of completed Missions and survive a reload", scale)
  test("a completion after a deletion, a purge and a new control with an earlier clock starts unseen and keeps its mark across reloads", async () => {
    const project = await projectControls()
    const first = await project.finish("first")
    markMissionsFinishedSeen("ordered", [], await project.completed())
    assert.equal(missionFinishedSeen("ordered", { id: first.id, finishSequence: first.finishSequence }), true, "the first read counts it as seen")
    await project.control().delete({ missionID: first.id, requestID: "delete-first", expectedRevision: first.revision })
    assert.ok(await project.purge() > 0, "its events left the journal")
    markMissionsFinishedSeen("ordered", [], await project.completed())
    project.setNow(1_000)
    const second = await project.finish("second")
    assert.ok(second.updatedAt < first.updatedAt, "the new control's clock runs earlier")
    const row = (await project.completed()).find(item => item.id === second.id)!
    assert.ok(row.finishSequence! > first.finishSequence!, `finish ${row.finishSequence} after ${first.finishSequence}`)
    markMissionsFinishedSeen("ordered", [], await project.completed())
    assert.equal(missionFinishedSeen("ordered", row), false, "never shown, it starts unseen")
    reloadWith({ MISSION_ORDER_CHECKS: JSON.stringify([{ completion: row, seen: false }]) })
    markMissionsFinishedSeen("ordered", [row.id], await project.completed())
    assert.equal(missionFinishedSeen("ordered", row), true)
    reloadWith({ MISSION_ORDER_CHECKS: JSON.stringify([{ completion: row, seen: true }]) })
  })
}

function scale() {
  const value = () => storage.get([...storage.keys()].find(key => key.startsWith("mission-seen-"))!)!
  // The first read takes the 3,000 completions it lists as seen.
  markMissionsFinishedSeen("project", [], range(0, 3_000))
  assert.equal(seen(range(0, 3_000)).every(Boolean), true)
  // 1,000 more finish; every other one is shown, out of order.
  const shownFirst = range(3_000, 4_000).filter((_, index) => index % 2).reverse()
  for (const item of shownFirst) markMissionsFinishedSeen("project", [item.id], range(0, 4_000))
  assert.equal(seen(shownFirst).every(Boolean), true)
  assert.equal(missionFinishedSeen("project", completion(3_000)), false, "the oldest unseen completion keeps its mark")
  assert.equal(seen(range(3_000, 4_000)).filter(Boolean).length, 500)
  // 2,000 more finish and two in three are shown: more completions finished after the
  // oldest unseen one were shown than one layout value lists.
  const shownLater = range(4_000, 6_000).filter((_, index) => index % 3)
  markMissionsFinishedSeen("project", shownLater.map(item => item.id), range(0, 6_000))
  assert.ok(value().length <= 4096, `one layout value: ${value().length}`)
  assert.equal(seen([...range(0, 3_000), ...shownFirst, ...shownLater]).every(Boolean), true, "a shown completion is never unseen again")
  assert.equal(missionFinishedSeen("project", completion(3_000)), true, "the oldest unseen completions gave way")
  assert.equal(missionFinishedSeen("project", completion(5_998)), false, "the newest unseen completions keep their mark")
  assert.equal(missionFinishedSeen("project", completion(6_000)), false, "a later completion starts unseen")
  // Deleted missions leave the record.
  const before = value().length
  markMissionsFinishedSeen("project", [], listed)
  assert.ok(value().length <= before)
  assert.deepEqual(seen(range(0, 1_000)), Array(1_000).fill(true), "listed or not, history below the watermark stays seen")
  // More toggled sections than one layout value holds: the newest persist.
  for (let index = 0; index < 400; index++) setMissionDisclosureOpen("msn_sections", `task-${index}`, false)
  assert.equal(missionDisclosureOpen("msn_sections", "task-0"), false, "this window keeps every toggle")
  reloadWith({ MISSION_SEEN_EXPECTED: JSON.stringify(seen(listed)) })
}
