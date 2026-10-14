import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { Context, Effect } from "effect"
import { MAX_CONTROL_FAMILY_SESSIONS } from "../../missions/native-session-family"
import { acquireNativePassageObservation } from "./native-passage-observation"
import { passageFixture } from "./native-passage-test-fixture"
import { observeNativePassageSettlement } from "./native-recurrence-settlement"

type Fixture = Awaited<ReturnType<typeof passageFixture>>

/** Finished ordinary descendants: `fanout` children per parent, breadth-first. */
function addFamily(f: Fixture, size: number, fanout = size) {
  const coordinator = f.passage.coordinatorSessionID, parents = [coordinator], ids: string[] = []
  for (let i = 0; i < size; i++) {
    const parentID = parents[Math.floor(i / fanout)], id = `ses_child_${String(i).padStart(5, "0")}`
    f.sessions.set(id, { id, parentID, projectID: "project", location: { directory: f.root } })
    f.states.set(id, { ...f.states.get(coordinator)!, id, parentID, active: false, messagePresent: false })
    parents.push(id); ids.push(id)
  }
  return ids
}

/** The fixture lists children by scanning every session; index them once for large families. */
function indexChildren(f: Fixture) {
  const byParent = new Map<string, string[]>()
  for (const session of f.sessions.values()) if (session.parentID)
    byParent.set(session.parentID, [...byParent.get(session.parentID) ?? [], session.id])
  f.observation.children = async id => [...byParent.get(id) ?? []]
}

const observe = async (f: Fixture) => observeNativePassageSettlement({ document: (await f.calendar.read("schedule"))!,
  storage: f.storage, native: f.observation, directory: f.root, current: () => true, signal: new AbortController().signal })

async function settle(f: Fixture) {
  const settled = (await observe(f))!
  return f.calendar.finish("schedule", settled.result, 30, () => true, settled.expectedRevision)
}

// Gatekeeper R8: a quiescent family of 33 (coordinator + 32 descendants) used to throw
// "Passage family capacity" on every wake and wedge the schedule.
for (const [size, fanout] of [[31, 31], [32, 32], [33, 33], [200, 4]] as const)
  test(`a quiescent completed family of ${size + 1} sessions archives completed`, async () => {
    const f = await passageFixture()
    try {
      await f.start(); await f.finish()
      addFamily(f, size, fanout)
      const archived = await settle(f)
      assert.equal(archived.pending, null)
      assert.equal(archived.history.at(-1)?.result.outcome, "completed")
    } finally { await f.dispose() }
  })

test("one active, inbox-holding or tool-running descendant deep in a large family keeps the passage pending", async () => {
  const f = await passageFixture()
  try {
    await f.start(); await f.finish()
    const deepest = addFamily(f, 120, 3).at(-1)!
    for (const field of ["active", "inbox", "pending", "runningTools"] as const) {
      const state = f.states.get(deepest)! as unknown as Record<string, unknown>
      const before = state[field]
      state[field] = field === "active" ? true : 1
      assert.equal(await observe(f), undefined, `${field} descendant blocks`)
      state[field] = before
    }
    f.pendingForm = true
    assert.equal(await observe(f), undefined, "an applicable Form/permission/Shell blocks the large family")
    f.pendingForm = false
    assert.ok((await f.calendar.read("schedule"))!.pending, "still pending")
    assert.equal((await settle(f)).history.at(-1)?.result.outcome, "completed")
  } finally { await f.dispose() }
})

test("an unobservable descendant fails closed: no archive and no cursor advance", async () => {
  const f = await passageFixture()
  try {
    await f.start(); await f.finish()
    const ids = addFamily(f, 40, 5)
    f.states.delete(ids[37]) // listed as a child, but its native row cannot be read
    const before = (await f.calendar.read("schedule"))!
    await assert.rejects(observe(f), /Missing session/)
    const after = (await f.calendar.read("schedule"))!
    assert.equal(after.revision, before.revision)
    assert.equal(after.pending?.passage.id, before.pending?.passage.id)
    assert.equal(after.history.length, before.history.length)
  } finally { await f.dispose() }
})

test(`the whole-family ceiling is ${MAX_CONTROL_FAMILY_SESSIONS} sessions; beyond it coverage is unknown, never complete`, async () => {
  const f = await passageFixture()
  try {
    await f.start(); await f.finish()
    addFamily(f, MAX_CONTROL_FAMILY_SESSIONS - 1, 64)
    indexChildren(f)
    const exact = (await observe(f))!
    assert.equal(exact.result.outcome, "completed", "exactly the ceiling settles")
    addFamily(f, MAX_CONTROL_FAMILY_SESSIONS, 64) // ids overwrite; one more descendant
    indexChildren(f)
    const before = (await f.calendar.read("schedule"))!
    for (let wake = 0; wake < 2; wake++) await assert.rejects(observe(f), /Passage family capacity/)
    const after = (await f.calendar.read("schedule"))!
    assert.equal(after.revision, before.revision, "nothing archived; watched cursors unchanged")
    assert.ok(after.pending)
  } finally { await f.dispose() }
})

test("real native SQL observation walks a 41-session family and bounds one parent's children", async () => {
  const f = await passageFixture(), db = new DatabaseSync(":memory:")
  try {
    await f.start(); await f.finish()
    db.exec(`CREATE TABLE session_v2(id TEXT,parent_id TEXT,project_id TEXT,directory TEXT,workspace_id TEXT,time_suspended INTEGER);
      CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,data TEXT);
      CREATE TABLE session_inbox(id TEXT,session_id TEXT);
      CREATE TABLE session_pending(session_id TEXT);`)
    const coordinator = f.passage.coordinatorSessionID, insert = db.prepare("INSERT INTO session_v2 VALUES(?,?,'project',?,NULL,NULL)")
    insert.run(coordinator, null, f.root)
    db.prepare("INSERT INTO session_message VALUES(?,?,'synthetic','{}')").run(f.passage.messageID, coordinator)
    for (let i = 0; i < 40; i++) insert.run(`ses_sql_${String(i).padStart(2, "0")}`, i < 8 ? coordinator : `ses_sql_${String(i % 8).padStart(2, "0")}`, f.root)
    const running = new Set<string>(), tag = (name: string) => Context.Service<never, unknown>(name)
    let graph = Context.empty() as Context.Context<never>
    for (const [name, value] of [
      ["@opencode/storage/Database", { db: { $client: { unsafe: (sql: string, params: readonly unknown[]) => ({
        withoutTransform: Effect.promise(async () => db.prepare(sql).all(...params as [])) }) } } }],
      ["@opencode/Location", {}], ["@opencode/Session", { active: Effect.sync(() => new Set(running)) }],
      ["@opencode/Form", { list: () => Effect.succeed([]) }], ["@opencode/Permission", { list: () => Effect.succeed([]) }],
      ["@opencode/Shell", { list: () => Effect.succeed([]) }],
    ] as const) graph = Context.add(graph, tag(name), value)
    const native = await Effect.runPromise(acquireNativePassageObservation().pipe(Effect.provide(graph)))
    const sqlObserve = async () => observeNativePassageSettlement({ document: (await f.calendar.read("schedule"))!, storage: f.storage,
      native, directory: f.root, current: () => true, signal: new AbortController().signal })
    running.add("ses_sql_39")
    assert.equal(await sqlObserve(), undefined, "a natively running grandchild blocks")
    running.clear()
    assert.equal((await sqlObserve())?.result.outcome, "completed", "41 quiescent sessions settle")
    const many = db.prepare("INSERT INTO session_v2 VALUES(?,'ses_sql_00','project',?,NULL,NULL)")
    db.exec("BEGIN")
    for (let i = 0; i < MAX_CONTROL_FAMILY_SESSIONS; i++) many.run(`ses_wide_${String(i).padStart(5, "0")}`, f.root)
    db.exec("COMMIT")
    await assert.rejects(native.children("ses_sql_00"), /family capacity/, "one bounded read beyond the ceiling is unknown")
    await assert.rejects(sqlObserve(), /family capacity/)
  } finally { db.close(); await f.dispose() }
})
