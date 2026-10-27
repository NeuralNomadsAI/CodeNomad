import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { setImmediate as tick } from "node:timers/promises"
import { queryRankedHistory } from "./history-ranked-store"
import { historyRankedInputSchema } from "./history-ranked-contract"
import { diverseHits, idfWeights } from "./history-ranking"

function database() {
  const db = new DatabaseSync(":memory:")
  db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT,workspace_id TEXT,project_id TEXT,title TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,time_created INTEGER,data TEXT);
    INSERT INTO session_v2 VALUES ('s','/repo',NULL,'p','Fixture');`)
  return db
}
const search = (db: DatabaseSync, query: string, includeTechnical = false) => queryRankedHistory(db, { directory: "/repo", projectID: "p" },
  historyRankedInputSchema.parse({ version: 1, query, includeTechnical, limit: 1 }), new AbortController().signal, async () => "owned")

for (const includeTechnical of [false, true]) test(`old rare prose outranks 700 newer tool-heavy rows (technical=${includeTechnical})`, async t => {
  const db = database()
  t.mock.method(performance, "now", () => 0)
  try {
    const insert = db.prepare("INSERT INTO session_message VALUES (?, 's', 'assistant', ?, ?)")
    insert.run("old", 0, JSON.stringify({ content: [{ type: "text", text: "singularity" }] }))
    const noisy = JSON.stringify({ content: [{ type: "tool", name: "shell", state: { content: [{ type: "text", text: "\u001b[32m" + "x".repeat(70 * 1024) }] } },
      { type: "text", text: "common" }] })
    for (let n = 0; n < 700; n++) insert.run(`new-${n}`, n + 1, noisy)
    const result = await search(db, "singularity common", includeTechnical)
    assert.deepEqual(result.hits.map(hit => hit.messageID), ["old"])
    assert.equal(result.judged, 600)
    assert.equal(result.prefilterBypassed, includeTechnical ? 700 : 0)
    assert(result.caps.includes("judge_limit"))
  } finally { db.close() }
})

test("ANSI/Unicode JSON escapes preserve exact term presence, including surrogate pairs", async () => {
  const db = database()
  try {
    const insert = db.prepare("INSERT INTO session_message VALUES (?, 's', 'user', 1, ?)")
    insert.run("ansi", '{"text":"\\u001b[32m ordinary"}')
    insert.run("accent", '{"text":"caf\\u00e9"}')
    insert.run("surrogates", '{"text":"\\ud801\\udc00\\ud801\\udc01"}')
    insert.run("literal", JSON.stringify({ text: String.raw`caf\u00e9` }))
    assert.equal((await search(db, "absent")).candidates, 0)
    const accent = await search(db, "café")
    assert.equal(accent.candidates, 1)
    assert.deepEqual(accent.hits.map(hit => hit.messageID), ["accent"])
    const surrogates = await search(db, "𐐨𐐩")
    assert.equal(surrogates.candidates, 1)
    assert.deepEqual(surrogates.hits.map(hit => hit.messageID), ["surrogates"])
  } finally { db.close() }
})

test("unknown rows cannot alter IDF or outrank known candidates", () => {
  const known = [[true, false], [true, true]]
  assert.deepEqual(idfWeights([...known, ...Array(700).fill(undefined)], 2), idfWeights(known, 2))
  const knownHit = { sessionID: "known", messageID: "known", score: 1, prose: false, createdAt: 1 }
  const unknownHit = { sessionID: "unknown", messageID: "unknown", score: 99, prose: true, createdAt: 99, unknown: true }
  assert.equal(diverseHits([unknownHit, knownHit], 1)[0].messageID, "known")
})

test("16 MiB projection cost preserves bounded first-yield time and reports unknown text", async () => {
  for (const query of ["bcdefg".split("").map(c => "a".repeat(28) + "Éé" + c).join(" "),
    "bcdefg".split("").map(c => "a".repeat(30) + c).join(" ")]) {
    const db = database()
    try {
      const define = db.function.bind(db)
      let calls = 0
      db.function = ((name: string, options: any, callback: any) => {
        const wrapped = (...args: any[]) => { calls++; return callback(...args) }
        Object.defineProperty(wrapped, "length", { value: callback.length })
        return define(name, options, wrapped)
      }) as typeof db.function
      db.prepare("INSERT INTO session_message VALUES ('large','s','user',1,?)").run(JSON.stringify({ text: "a".repeat(16_777_000) }))
      const started = performance.now(), firstYield = tick().then(() => performance.now() - started)
      const result = await search(db, query)
      const elapsed = await firstYield
      console.log(`projected ${query.includes("É") ? "accent" : "ASCII"} adversary: first yield ${elapsed.toFixed(0)} ms`)
      assert(elapsed < 900, `first yield took ${elapsed.toFixed(0)} ms`)
      assert.equal(result.prefilterBypassed, 1)
      assert.equal(calls, 1, "classify readable projection before marking oversized text unknown")
    } finally { db.close() }
  }
})
