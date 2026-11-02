import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { setImmediate as tick } from "node:timers/promises"
import { queryRankedHistory } from "./history-ranked-store"
import { historyRankedInputSchema } from "./history-ranked-contract"
import { HISTORY_SLICE_MS } from "./history-content"

function database(count = 0) {
  const db = new DatabaseSync(":memory:")
  db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT,workspace_id TEXT,project_id TEXT,title TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,time_created INTEGER,data TEXT);
    INSERT INTO session_v2 VALUES ('s','/repo',NULL,'p','Synthetic'); BEGIN;`)
  const insert = db.prepare("INSERT INTO session_message VALUES (?, 's', 'user', 1, ?)")
  for (let n = 0; n < count; n++) insert.run(`m-${n}`, '{"text":"needle"}')
  db.exec("COMMIT")
  return db
}
const search = (db: DatabaseSync, cursor?: string, includeTechnical = false) => queryRankedHistory(db,
  { directory: "/repo", projectID: "p" }, historyRankedInputSchema.parse({ version: 1, query: "needle", cursor, includeTechnical }),
  new AbortController().signal, async () => "owned")

for (const change of ["deleted", "replaced", "during-read"]) test(`horizon sentinel requires a fresh search when ${change}, excluding reused rowids`, async () => {
  const db = database(17_000)
  try {
    const first = await search(db); assert(first.cursor)
    const mutate = () => {
      db.exec("DELETE FROM session_message WHERE rowid > 500")
      db.exec(`INSERT INTO session_message VALUES ('appended','s','user',2,'{"text":"needle"}')`)
      assert.equal(db.prepare("SELECT rowid FROM session_message WHERE id='appended'").get()!.rowid, 501)
      if (change === "replaced") db.exec(`INSERT INTO session_message(rowid,id,session_id,type,time_created,data)
        VALUES (17000,'replacement','s','user',2,'{"text":"needle"}')`)
    }
    if (change !== "during-read") mutate()
    else {
      const prepare = db.prepare.bind(db)
      let changed = false
      db.prepare = ((sql: string) => {
        const statement = prepare(sql)
        if (sql.includes("AS mask")) {
          const iterate = statement.iterate.bind(statement)
          statement.iterate = function* (...params) {
            for (const row of Reflect.apply(iterate, statement, params)) {
              if (!changed) { changed = true; mutate() }
              yield row
            }
          }
        }
        return statement
      }) as typeof db.prepare
    }
    await assert.rejects(search(db, first.cursor!), { name: "RankedHistoryRestartError" })
    const fresh = await search(db)
    assert(fresh.hits.some(hit => hit.messageID === "appended"))
  } finally { db.close() }
})

for (const technical of [false, true]) test(`large ignored tool metadata preserves bounded work between yields (technical=${technical})`, async t => {
  const db = database()
  const targetBytes = 12_689_000
  const record = JSON.stringify({ a: {}, b: [] })
  const prefix = '{"content":[{"type":"text","text":"needle"},{"type":"tool","name":"probe","state":{"metadata":{"records":['
  const suffix = '],"padding":""}}}]}'
  const count = Math.floor((targetBytes - prefix.length - suffix.length) / (record.length + 1))
  const records = Array(count).fill(record).join(",")
  const raw = prefix + records + suffix.replace('"padding":""', `"padding":"${"x".repeat(targetBytes - prefix.length - records.length - suffix.length)}"`)
  assert.equal(Buffer.byteLength(raw), targetBytes)
  const insert = db.prepare("INSERT INTO session_message VALUES (?, 's','assistant',1,?)")
  for (const id of ["large-1", "large-2"]) insert.run(id, raw)
  // A synchronous SQLite step/JSON parse finishes before yielding. Advance the
  // slice clock by one expired slice per real row, independently of CPU scheduling.
  let now = 0
  t.mock.method(performance, "now", () => now)
  const events: string[] = [], turns: Promise<void>[] = []
  const completed = (phase: string) => {
    events.push(phase)
    now += HISTORY_SLICE_MS + 1
    turns.push(tick().then(() => { events.push("turn") }))
  }
  const define = db.function.bind(db), prepare = db.prepare.bind(db)
  t.mock.method(db, "function", (name: string, options: any, callback: any) => define(name, options, (data: any, role: any) => {
    const result = callback(data, role)
    completed("scan")
    return result
  }))
  t.mock.method(db, "prepare", (sql: string) => {
    const statement = prepare(sql)
    if (sql.includes("AS data")) {
      const get = statement.get.bind(statement)
      statement.get = (...params) => {
        const row = Reflect.apply(get, statement, params)
        completed("body")
        return row
      }
    }
    return statement
  })
  const parse = JSON.parse
  let largestDecoded = 0
  t.mock.method(JSON, "parse", (value: string, ...args: any[]) => {
    largestDecoded = Math.max(largestDecoded, Buffer.byteLength(value))
    return Reflect.apply(parse, JSON, [value, ...args])
  })
  try {
    const result = await search(db, undefined, technical)
    await Promise.all(turns)
    assert.deepEqual(events, ["scan", "turn", "scan", "turn", "body", "turn", "body", "turn"],
      "each expired slice must let an event-loop turn run before another row, including inside a chunk and while judging")
    assert.equal(result.scanned, 2)
    assert.equal(result.judged, 2)
    assert.deepEqual(result.hits.map(hit => hit.messageID).sort(), ["large-1", "large-2"])
    if (!technical) assert(largestDecoded < 64 * 1024, `ignored metadata entered JSON.parse: ${largestDecoded} bytes`)
    else assert.equal(largestDecoded, targetBytes, "technical search retains the bounded native body")
  } finally { db.close() }
})
