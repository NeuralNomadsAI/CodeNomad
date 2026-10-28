import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { setImmediate as tick } from "node:timers/promises"
import { queryRankedHistory } from "./history-ranked-store"
import { historyRankedInputSchema } from "./history-ranked-contract"

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

for (const technical of [false, true]) test(`large ignored tool metadata keeps first yield bounded (technical=${technical})`, async t => {
  const db = database()
  const targetBytes = 12_689_000
  const record = JSON.stringify({ a: {}, b: [] })
  const prefix = '{"content":[{"type":"text","text":"needle"},{"type":"tool","name":"probe","state":{"metadata":{"records":['
  const suffix = '],"padding":""}}}]}'
  const count = Math.floor((targetBytes - prefix.length - suffix.length) / (record.length + 1))
  const records = Array(count).fill(record).join(",")
  const raw = prefix + records + suffix.replace('"padding":""', `"padding":"${"x".repeat(targetBytes - prefix.length - records.length - suffix.length)}"`)
  assert.equal(Buffer.byteLength(raw), targetBytes)
  db.prepare("INSERT INTO session_message VALUES ('large','s','assistant',1,?)").run(raw)
  const parse = JSON.parse
  let largestDecoded = 0
  t.mock.method(JSON, "parse", (value: string, ...args: any[]) => {
    largestDecoded = Math.max(largestDecoded, Buffer.byteLength(value))
    return Reflect.apply(parse, JSON, [value, ...args])
  })
  try {
    const started = performance.now(), firstYield = tick().then(() => performance.now() - started)
    const result = await search(db, undefined, technical)
    const elapsed = await firstYield
    console.log(JSON.stringify({ technical, firstYieldMs: +elapsed.toFixed(2), largestDecoded }))
    assert.equal(result.hits[0]?.messageID, "large")
    assert(elapsed < (technical ? 1800 : 300), `first yield ${elapsed.toFixed(1)} ms (technical=${technical})`)
    if (!technical) assert(largestDecoded < 64 * 1024, `ignored metadata entered JSON.parse: ${largestDecoded} bytes`)
  } finally { db.close() }
})
