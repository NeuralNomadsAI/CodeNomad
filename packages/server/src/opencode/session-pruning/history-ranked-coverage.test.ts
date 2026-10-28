import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { queryRankedHistory, RANKED_LIMITS } from "./history-ranked-store"
import { historyRankedInputSchema, historyRankedPageSchema } from "./history-ranked-contract"
import { mayContainHistoryTerms } from "./history-ranked-prefilter"
import { historyContent, historyTexts } from "./history-content"
import { searchTerms, termMask, textJudge } from "./history-ranking"
import { rankedBenchmarkDatabase, instrumentRankedScan } from "./history-ranked-benchmark-fixture"

function fixture(count: number) {
  const db = new DatabaseSync(":memory:")
  db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT,workspace_id TEXT,project_id TEXT,title TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,time_created INTEGER,data TEXT);
    INSERT INTO session_v2 VALUES ('s','/repo',NULL,'p','Fixture');`)
  const insert = db.prepare("INSERT INTO session_message VALUES (?, 's','user',?,?)")
  for (let n = 0; n < count; n++) insert.run(`m-${n}`, n, JSON.stringify({ text: n === 0 || n === count - 1 ? "needle worktree" : "ordinary worktree" }))
  return db
}
const search = (db: DatabaseSync, query = "worktree") => queryRankedHistory(db, { directory: "/repo", projectID: "p" },
  historyRankedInputSchema.parse({ version: 1, query, limit: 20 }), new AbortController().signal, async () => "owned")

test("time-capped scans cover the newest rows, not the oldest prefix", async t => {
  const db = fixture(100)
  let now = 0
  t.mock.method(performance, "now", () => now)
  const prepare = db.prepare.bind(db)
  db.prepare = ((sql: string) => {
    const statement = prepare(sql)
    if (sql.includes("AS mask")) {
      const iterate = statement.iterate.bind(statement)
      statement.iterate = function* (...params) {
        let n = 0
        for (const row of Reflect.apply(iterate, statement, params)) {
          if (++n === 10) now = 1501
          yield row
        }
      }
    }
    return statement
  }) as typeof db.prepare
  try {
    const result = await search(db)
    assert.equal(result.scanned, 10)
    assert(result.caps.includes("scan_time"))
    assert.equal(result.hits[0].messageID, "m-99")
    assert(result.hits.every(hit => Number(hit.messageID.slice(2)) >= 90))
  } finally { db.close() }
})

test("idle repeated searches cover the same fixed newest window and exclude older matches", async () => {
  const count = RANKED_LIMITS.messages + 20, db = fixture(count)
  try {
    const results = []
    for (let n = 0; n < 3; n++) results.push(await search(db, "needle"))
    assert.equal(results[0].scanned, RANKED_LIMITS.messages)
    assert.deepEqual(results[0].caps, ["message_limit"])
    assert.deepEqual(results[0].hits.map(hit => hit.messageID), [`m-${count - 1}`])
    assert.deepEqual(results[1], results[0]); assert.deepEqual(results[2], results[0])
  } finally { db.close() }
})

test("newest scan skips rowid holes and foreign chunks without dropping older owned rows", async () => {
  const db = fixture(10)
  try {
    db.exec("INSERT INTO session_v2 VALUES ('foreign','/other',NULL,'foreign','Foreign')")
    const insert = db.prepare("INSERT INTO session_message(rowid,id,session_id,type,time_created,data) VALUES (?,?,'foreign','user',1,?)")
    for (let n = 0; n < 500; n++) insert.run(1000 + n, `foreign-${n}`, '{"text":"secret worktree"}')
    insert.run(1_000_000, "gap", '{"text":"secret worktree"}')
    const result = await search(db)
    assert.equal(result.scanned, 10)
    assert.equal(result.capped, false)
    assert(!JSON.stringify(result).includes("secret"))
    assert.equal(result.hits[0].messageID, "m-9")
  } finally { db.close() }
})

test("older windows retain their original horizon, advance exact examined ranges and finish without repeats", async () => {
  const db = fixture(2 * RANKED_LIMITS.messages + 3)
  const input = historyRankedInputSchema.parse({ version: 1, query: "worktree", limit: 40 })
  const run = (cursor?: string) => queryRankedHistory(db, { directory: "/repo", projectID: "p" }, { ...input, cursor }, new AbortController().signal, async () => "owned")
  try {
    const first = historyRankedPageSchema.parse(await run())
    assert.equal(first.hits.length, 40); assert.equal(first.judged, 600)
    assert.equal(first.examinedBefore, 0); assert.equal(first.scanned, RANKED_LIMITS.messages); assert(first.cursor)
    db.exec(`INSERT INTO session_message VALUES ('appended','s','user',999999,'{"text":"worktree"}')`)
    const second = await run(first.cursor!)
    assert.equal(second.examinedBefore, RANKED_LIMITS.messages); assert.equal(second.scanned, RANKED_LIMITS.messages)
    assert(second.cursor); assert.equal(second.hits.length, 40)
    assert(second.hits.every(hit => !first.hits.some(previous => previous.messageID === hit.messageID)))
    assert(second.hits.every(hit => hit.messageID !== "appended" && Number(hit.messageID.slice(2)) < RANKED_LIMITS.messages + 3))
    const third = await run(second.cursor!)
    assert.equal(third.examinedBefore, 2 * RANKED_LIMITS.messages); assert.equal(third.scanned, 3)
    assert.equal(third.cursor, null); assert.equal(third.capped, false)
    assert.deepEqual(third.hits.map(hit => hit.messageID), ["m-2", "m-1", "m-0"])
  } finally { db.close() }
})

test("native continuations reject tampering, scope, query and option changes", async () => {
  const db = fixture(RANKED_LIMITS.messages + 1)
  const input = historyRankedInputSchema.parse({ version: 1, query: "worktree" })
  const scope = { directory: "/repo", projectID: "p" }
  const run = (value = input, owner = scope) => queryRankedHistory(db, owner, value, new AbortController().signal, async () => "owned")
  try {
    const first = await run(); assert(first.cursor)
    const [body, signature] = first.cursor.split(".")
    const forged = JSON.parse(Buffer.from(body, "base64url").toString())
    forged.value.through++
    const changedHorizon = `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${signature}`
    for (const extra of [{ query: "needle" }, { query: "!" }, { includeTechnical: true }, { since: "2026-01-01" }, { until: "2026-01-02" }, { limit: 40 },
      { cursor: `x${first.cursor}` }, { cursor: `${first.cursor}.extra` }, { cursor: `${first.cursor}!` }, { cursor: changedHorizon }]) {
      await assert.rejects(run({ ...input, cursor: first.cursor!, ...extra }))
    }
    for (const extra of [{ directory: "/foreign" }, { projectID: "foreign" }, { workspaceID: "foreign" }, { sessionID: "s" }]) {
      await assert.rejects(run({ ...input, cursor: first.cursor! }, { ...scope, ...extra }))
    }
  } finally { db.close() }
})

test("raw-byte necessary condition is a superset of decoded masks and judges across Unicode/JSON forms", () => {
  const words = ["worktree", "café", "caféété", "éloigné", "kelvin", "shell", "İstanbul", "σίσυφος", "𐐨𐐩", "東京", "foo_bar", "21", "null", "btext"]
  let checked = 0
  for (const query of [...words, ...words.map((word, i) => `${word} ${words[(i + 3) % words.length]}`)]) {
    const terms = searchTerms(query), exact = termMask(terms), judge = textJudge(terms, query, terms.map(() => 1))
    for (const technical of [false, true]) {
      const possible = mayContainHistoryTerms(terms, technical)
      for (const word of words) for (const variant of [word, word.toUpperCase(), word.toLowerCase(), "KELVIN ſHELL éLoIgNÉ caféÉté İstanbul"]) {
        const content = [{ type: "text", text: `before\n${variant}\u001b[0m` }, { type: "reasoning", text: variant },
          { type: "tool", name: "probe", input: { value: variant }, state: { content: [{ type: "text", text: variant }] } }]
        const raw = JSON.stringify({ content })
        for (const encoded of [raw, JSON.stringify({ content }, null, 2), raw.replace(/[^\x20-\x7e]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`),
          raw.replace(/[A-Za-z]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)]) {
          const sources = [...historyTexts(historyContent(JSON.parse(encoded), "assistant"), technical)]
          if (sources.some(source => exact(source.text) || judge(source.text).at >= 0)) assert(possible(Buffer.from(encoded)), `${query}: ${encoded}`)
          checked++
        }
      }
    }
  }
  for (const [raw, query] of [
    ['{"content":[{"type":"tool","input":"\\u0008text"}]}', "btext"],
    ['{"content":[{"type":"tool","input":{"v":1000000000000000000000}}]}', "21"],
    ['{"content":[{"type":"tool","input":{"v":1e400}}]}', "null nu ll"],
  ]) {
    const terms = searchTerms(query!)
    assert([...historyTexts(historyContent(JSON.parse(raw!), "assistant"), true)].some(source => termMask(terms)(source.text)))
    assert(mayContainHistoryTerms(terms, true)(Buffer.from(raw!)))
    checked++
  }
  assert(checked > 10_000)
  assert.equal(mayContainHistoryTerms(["worktree"], false)(Buffer.from('{"text":"Un café ordinaire\\u001b[32m"}')), false)
  console.log(`necessary-condition property cases: ${checked}`)
})

test("host Unicode ASCII case crossings retain necessary byte anchors", () => {
  const cases = [..."abcdefghijklmnopqrstuvwxyz"].map(letter => ({ matcher: new RegExp(`^${letter}$`, "iu"), possible: mayContainHistoryTerms([`a${letter}b`], false) }))
  for (let point = 0; point <= 0x10ffff; point++) {
    const char = String.fromCodePoint(point)
    if (char.toUpperCase() === char.toLowerCase()) continue
    for (const entry of cases) if (entry.matcher.test(char)) assert(entry.possible(Buffer.from(JSON.stringify({ text: `a${char}b` }))), `U+${point.toString(16)}`)
  }
})

test("indexed large-corpus chunks stream without sorting or decoding negatives, within a synchronous-step bound", async () => {
  const db = rankedBenchmarkDatabase(6000), measurement = instrumentRankedScan(db)
  try {
    const result = await search(db)
    const stats = measurement.stats
    assert.equal(result.scanned, 6000)
    assert.equal(stats.firstPosition, 6000)
    assert(!stats.plan.some(line => /TEMP B-TREE/.test(line)), stats.plan.join("\n"))
    assert(stats.projectedParses < stats.rows / 2)
    assert(stats.maxStepMs < 120, `longest synchronous step ${stats.maxStepMs.toFixed(1)} ms`)
    assert(stats.firstRowMs < 150, `first row ${stats.firstRowMs.toFixed(1)} ms`)
    console.log(JSON.stringify({ firstRowMs: stats.firstRowMs, maxStepMs: stats.maxStepMs, projectedParses: stats.projectedParses, rows: stats.rows }))
  } finally { measurement.dispose(); db.close() }
})
