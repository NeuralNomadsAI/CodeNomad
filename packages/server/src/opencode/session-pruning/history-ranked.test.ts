import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { queryRankedHistory, RANKED_LIMITS } from "./history-ranked-store"
import { historyRankedInputSchema, historyRankedPageSchema } from "./history-ranked-contract"
import { idfWeights, searchTerms, termPrefilterSQL, textJudge } from "./history-ranking"
import type { HistoryScope } from "./history-store"

const scope: HistoryScope = { directory: "/repo", projectID: "p" }
function fixture() {
  const db = new DatabaseSync(":memory:")
  db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT,workspace_id TEXT,project_id TEXT,title TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,time_created INTEGER,data TEXT);
    INSERT INTO session_v2 VALUES ('s','/repo',NULL,'p','Fixture');`)
  return db
}
function insert(db: DatabaseSync, id: string, text: string, session = "s", time = Date.parse("2026-01-02Z")) {
  db.prepare("INSERT INTO session_message VALUES (?,?,'user',?,?)").run(id, session, time, JSON.stringify({ text }))
}
async function search(db: DatabaseSync, query: string, options = {}, owner = scope, signal = new AbortController().signal) {
  const page = await queryRankedHistory(db, owner, historyRankedInputSchema.parse({ version: 1, query, ...options }), signal, async () => "owned")
  historyRankedPageSchema.parse(page)
  return page
}

test("SQL prefilter covers ASCII, supported accented case forms and JSON escapes", () => {
  const db = fixture()
  try {
    for (const [query, text, data] of [
      ["GitHub", "gItHuB", undefined], ["été", "ÉTÉ", undefined],
      ["github", "github", '{"text":"\\u0067ithub"}'],
      ["café", "CAFÉ", '{"text":"CAF\\u00c9"}'],
      ["éloigné", "Éloigné", undefined], ["éloigné", "ÉlOiGnÉ", undefined], ["éloigné", "ÉLOIGNÉ", undefined],
      ["éloigné", "éloigné", '{"text":"\\u00e9loign\\u00e9"}'],
    ]) {
      const term = searchTerms(query!)[0]
      assert.equal(textJudge([term], query!, [1])(text!).at, 0)
      const filter = termPrefilterSQL(term)
      const result = db.prepare(`SELECT ${filter.sql} AS flag FROM (SELECT ? AS data) m`).get(...filter.params, data ?? JSON.stringify({ text }))
      assert.equal(result?.flag, 1, `${query}: ${text}`)
    }
  } finally { db.close() }
})

test("multiline accented JSON without a term gets no presence flag or candidate", async () => {
  const db = fixture()
  try {
    const text = 'Un café récent\nUne autre décision\t"citée" \\ un chemin'
    insert(db, "unrelated", text)
    for (const term of ["orbital", "éloigné", "été", "kelvin"]) {
      const filter = termPrefilterSQL(term)
      assert.equal(db.prepare(`SELECT ${filter.sql} AS flag FROM session_message m`).get(...filter.params)?.flag, 0, term)
      const result = await search(db, term)
      assert.equal(result.scanned, 1)
      assert.equal(result.candidates, 0, term)
      assert.equal(result.judged, 0, term)
    }
  } finally { db.close() }
})

test("precise SQL presence flags give rare terms greater IDF in multiline accented messages", () => {
  const db = fixture()
  try {
    for (let n = 0; n < 100; n++) insert(db, `m-${n}`, `panel\nDécision récente ${n < 3 ? "orbital" : "courante"}`)
    const filters = ["panel", "orbital"].map(termPrefilterSQL)
    const rows = db.prepare(`SELECT ${filters.map((filter, i) => `${filter.sql} AS t${i}`).join(",")} FROM session_message m`)
      .all(...filters.flatMap(filter => filter.params))
    const flags = rows.map(row => [Boolean(row.t0), Boolean(row.t1)])
    assert.equal(flags.filter(row => row[0]).length, 100)
    assert.equal(flags.filter(row => row[1]).length, 3)
    const weights = idfWeights(flags, 2)
    assert.equal(weights[0], Math.log(2))
    assert.equal(weights[1], Math.log(1 + 100 / 3))
  } finally { db.close() }
})

test("an old rare match ranks first ahead of over 600 newer multiline accented frequent matches", async () => {
  const db = fixture()
  try {
    insert(db, "old-rare", "orbital\nDécision archivée", "s", 1)
    for (let n = 0; n < 800; n++) insert(db, `recent-${n}`, "panel\nUn café récent et une décision courante", "s", 1000 + n)
    const result = await search(db, "panel orbital", { limit: 1 })
    assert.equal(result.scanned, 801)
    assert.equal(result.candidates, 801)
    assert.equal(result.judged, 600)
    assert.deepEqual(result.hits.map(hit => hit.messageID), ["old-rare"])
    assert.deepEqual(result.caps, ["judge_limit"])
  } finally { db.close() }
})

test("prefilter uses a fixed number of literal scans with no wildcard matcher", () => {
  for (const term of ["panel", "éloigné", "İstanbul", "a".repeat(199) + "b"]) {
    const filter = termPrefilterSQL(term)
    assert.doesNotMatch(filter.sql, /GLOB|LIKE/)
    assert(filter.params.length >= 1 && filter.params.length <= 4)
  }
})

test("scope shares directory boundaries, native workspace and project/global isolation with history", async () => {
  const db = fixture()
  try {
    for (const [id, directory, workspace, project] of [
      ["nested", "/repo/src", null, "p"], ["global", "/repo/old", null, "global"], ["sibling", "/repo-other", null, "p"],
      ["workspace", "/repo", "other", "p"], ["clone", "/repo/clone", null, "foreign"],
    ]) db.prepare("INSERT INTO session_v2 VALUES (?,?,?,?,?)").run(id!, directory!, workspace!, project!, id!)
    for (const id of ["s", "nested", "global", "sibling", "workspace", "clone"]) insert(db, id, "past discussion", id)
    const result = await search(db, "discussion")
    assert.deepEqual(result.hits.map(hit => hit.sessionID).sort(), ["global", "nested", "s"])
    assert.equal(result.matchedSessions, 3)
    assert.equal(result.sessions.length, 3)
    assert(result.sessions.every(session => session.directory.startsWith("/repo")))
    assert.deepEqual((await search(db, "discussion", {}, { ...scope, workspaceID: "other" })).hits.map(hit => hit.sessionID), ["workspace"])
  } finally { db.close() }
})

test("ranking searches older rows before choosing hits, with rare terms, phrase bonus and session diversity", async () => {
  const db = fixture()
  try {
    db.exec("INSERT INTO session_v2 VALUES ('peer','/repo',NULL,'p','Peer')")
    insert(db, "rare", "the rareword", "s", 1)
    insert(db, "separated", "rareword with the", "s", 2)
    insert(db, "peer", "the word", "peer", 4)
    for (let n = 0; n < 100; n++) insert(db, `filler-${n}`, "the newest filler", "s", n + 10)
    const result = await search(db, "the rareword", { limit: 3 })
    assert.equal(result.scanned, 103)
    assert.deepEqual(result.hits.map(hit => hit.messageID), ["rare", "peer", "separated"])
    assert.equal(result.capped, false)
  } finally { db.close() }
})

test("prose outranks technical payloads; shared projection preserves native part indexes and readable roles", async () => {
  const db = fixture()
  try {
    db.prepare("INSERT INTO session_message VALUES ('tool','s','assistant',3,?)").run(JSON.stringify({ content: [
      { type: "tool", name: "shell", state: { input: { command: "needle" }, metadata: { files: [{ patch: "needle" }] } } },
      { type: "reasoning", text: "needle" }, { type: "text", text: "Nothing here" },
    ] }))
    db.prepare("INSERT INTO session_message VALUES ('prose','s','assistant',1,?)").run(JSON.stringify({ content: [null, { type: "text", text: "needle" }] }))
    for (const role of ["system", "synthetic", "skill", "shell"]) db.prepare("INSERT INTO session_message VALUES (?, 's', ?, 2, ?)").run(role, role, JSON.stringify({ summary: "needle" }))
    const prose = await search(db, "needle", { limit: 20 })
    assert.equal(prose.hits.length, 5)
    assert.equal(prose.hits.find(hit => hit.messageID === "prose")?.partIndex, 1)
    const technical = await search(db, "needle", { includeTechnical: true, limit: 20 })
    assert.equal(technical.hits.length, 6)
    assert.equal(technical.hits.at(-1)?.messageID, "tool")
    assert.equal(technical.hits.at(-1)?.kind, "tool")
  } finally { db.close() }
})

test("inclusive date bounds filter message timestamps and word-boundary noise is rejected", async () => {
  const db = fixture()
  try {
    insert(db, "before", "needle", "s", Date.parse("2026-01-01T23:59:59Z"))
    insert(db, "first", "needle", "s", Date.parse("2026-01-02T00:00:00Z"))
    insert(db, "last", "NEEDLE", "s", Date.parse("2026-01-02T23:59:59.999Z"))
    insert(db, "after", "needle", "s", Date.parse("2026-01-03T00:00:00Z"))
    insert(db, "noise", "needles _needle needlework")
    assert.deepEqual((await search(db, "needle", { since: "2026-01-02", until: "2026-01-02" })).hits.map(hit => hit.messageID), ["last", "first"])
  } finally { db.close() }
})

test("oversized and unsupported rows are skipped; attachments stay outside the text-only JS body", async () => {
  const db = fixture()
  try {
    for (const [id, data] of [["large", JSON.stringify({ text: "needle", bytes: "x".repeat(16 * 1024 * 1024) })], ["invalid", "{"],
      ["null", "null"], ["array", "[]"], ["assistant", '{"text":"needle"}']]) {
      db.prepare("INSERT INTO session_message VALUES (?, 's', ?, 1, ?)").run(id!, id === "assistant" ? "assistant" : "user", data!)
    }
    db.prepare("INSERT INTO session_message VALUES ('readable','s','user',1,?)").run(JSON.stringify({ text: "needle", attachments: [{ bytes: "x".repeat(1024 * 1024) }] }))
    const prepare = db.prepare.bind(db)
    let bytes = 0
    db.prepare = ((sql: string) => {
      const statement = prepare(sql)
      if (sql.includes("AS data")) {
        const get = statement.get.bind(statement)
        statement.get = (...params) => { const row = Reflect.apply(get, statement, params); bytes += typeof row?.data === "string" ? row.data.length : 0; return row }
      }
      return statement
    }) as typeof db.prepare
    const result = await search(db, "needle")
    assert.equal(result.skipped, 5)
    assert.deepEqual(result.hits.map(hit => hit.messageID), ["readable"])
    assert(bytes < 1024, `materialized ${bytes} bytes`)
  } finally { db.close() }
})

test("scan yields to the event loop, excludes appended rows by horizon and honors cancellation", async () => {
  const db = fixture()
  try {
    for (let n = 0; n < 1100; n++) insert(db, `m-${n}`, "needle")
    let yielded = false
    setImmediate(() => { yielded = true; insert(db, "appended", "needle") })
    const result = await search(db, "needle")
    assert(yielded)
    assert.equal(result.scanned, 1100)
    assert(result.caps.includes("judge_limit"))
    assert(!result.hits.some(hit => hit.messageID === "appended"))
    const abort = new AbortController()
    setImmediate(() => abort.abort())
    await assert.rejects(search(db, "needle", {}, scope, abort.signal), /abort/i)
    await assert.rejects(search(db, "needle", {}, scope, abort.signal), /abort/i)
  } finally { db.close() }
})

test("candidate and judgement caps are explicit and keep output/provenance bounded", async t => {
  const db = fixture()
  t.mock.method(performance, "now", () => 0)
  try {
    db.exec("BEGIN")
    for (let n = 0; n <= RANKED_LIMITS.candidates; n++) insert(db, `m-${n}`, "needle")
    db.exec("COMMIT")
    const result = await search(db, "needle", { limit: 20 })
    assert.equal(result.candidates, RANKED_LIMITS.candidates)
    assert.equal(result.judged, RANKED_LIMITS.judged)
    assert.equal(result.hits.length, 20)
    assert.deepEqual(result.caps, ["candidate_limit", "judge_limit"])
    assert.equal(result.capped, true)
    assert.equal(new Set(result.hits.map(hit => hit.messageID)).size, 20)
  } finally { db.close() }
})

test("total scan and body-judging time budgets report partial coverage", async t => {
  const db = fixture()
  try {
    for (const id of ["one", "two", "three", "four"]) insert(db, id, "needle")
    let now = -500
    t.mock.method(performance, "now", () => now += 500)
    const result = await search(db, "needle")
    assert.equal(result.capped, true)
    assert(result.caps.includes("scan_time"))
    assert(result.caps.includes("total_time"))
  } finally { db.close() }
})

test("provenance covers nonmatches and bounded session fanout, with reconstructible owned counts", async t => {
  const db = fixture()
  t.mock.method(performance, "now", () => 0)
  try {
    for (let n = 0; n <= RANKED_LIMITS.sessions; n++) {
      const id = `owner-${n}`
      db.prepare("INSERT INTO session_v2 VALUES (?, '/repo', NULL, 'p', ?)").run(id, id)
      insert(db, id, n < 2 ? "needle" : "unrelated", id)
    }
    const result = await search(db, "needle")
    assert.deepEqual(result.caps, ["session_limit"])
    assert.equal(result.sessions.length, 600)
    assert.equal(result.matchedSessions, 2)
    assert.equal(result.sessions.filter(owner => owner.matchedMessages > 0).length, 2)
    for (const key of ["scanned", "candidates", "judged", "skipped"] as const) {
      assert.equal(result.sessions.reduce((sum, owner) => sum + owner[key], 0), result[key])
    }
    assert.equal(result.sessions.filter(owner => owner.candidates === 0).length, 598)
  } finally { db.close() }
})

test("40 ms slice yields within a chunk before its 1,000-row boundary", async t => {
  const db = fixture()
  let now = 0, visited = 0, firstYield = 0
  t.mock.method(performance, "now", () => now++)
  try {
    for (let n = 0; n < 60; n++) insert(db, `m-${n}`, "needle")
    const prepare = db.prepare.bind(db)
    db.prepare = ((sql: string) => {
      const statement = prepare(sql)
      if (sql.includes("AS supported")) {
        const iterate = statement.iterate.bind(statement)
        statement.iterate = function* (...params) {
          for (const row of Reflect.apply(iterate, statement, params)) { visited++; yield row }
        }
      }
      return statement
    }) as typeof db.prepare
    setImmediate(() => { firstYield = visited })
    const result = await search(db, "needle")
    assert(firstYield > 0 && firstYield < 60, `first yield after ${firstYield} rows`)
    assert.equal(result.scanned, 60)
    assert.equal(result.capped, false)
  } finally { db.close() }
})
