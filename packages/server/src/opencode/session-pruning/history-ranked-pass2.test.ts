import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { mkdir, mkdtemp, rename, rm, writeFile, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setImmediate as tick } from "node:timers/promises"
import { queryRankedHistory } from "./history-ranked-store"
import { historyRankedInputSchema } from "./history-ranked-contract"
import { rankedDirectoryOwnership, type CheckRankedDirectory } from "./history-ranked-ownership"
import { readCheckoutCommonDirectory } from "./checkout-identity"

async function temporary() {
  const parent = path.join(os.tmpdir(), "opencode")
  await mkdir(parent, { recursive: true })
  return mkdtemp(path.join(parent, "ranked-pass2-"))
}
async function git(root: string) {
  await mkdir(path.join(root, ".git", "objects"), { recursive: true })
  await mkdir(path.join(root, ".git", "refs"))
  await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n")
}
function database(texts: string[], directory = "/repo") {
  const db = new DatabaseSync(":memory:")
  db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT,workspace_id TEXT,project_id TEXT,title TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,time_created INTEGER,data TEXT);`)
  db.prepare("INSERT INTO session_v2 VALUES ('s',?,NULL,'p','Fixture')").run(directory)
  for (const [n, text] of texts.entries()) db.prepare("INSERT INTO session_message VALUES (?, 's','user',?,?)").run(`m-${n}`, n, JSON.stringify({ text }))
  return db
}
const owned: CheckRankedDirectory = async () => "owned"
const search = (db: DatabaseSync, query: string, check = owned, directory = "/repo") => queryRankedHistory(db,
  { directory, projectID: "p" }, historyRankedInputSchema.parse({ version: 1, query }), new AbortController().signal, check)

test("pass3: slow pre-judge ownership checks leave the judge its remaining allowance", async t => {
  const db = database(["needle"])
  let now = 0
  t.mock.method(performance, "now", () => now)
  try {
    let validations = 0
    const slow: CheckRankedDirectory = async (_directory, fresh) => {
      // The first fresh pass runs before judging and takes longer than the whole budget.
      if (fresh && validations++ === 0) now += 5_000
      return "owned"
    }
    const result = await search(db, "needle", slow)
    assert.deepEqual(result.caps, [])
    assert.equal(result.judged, 1)
    assert.deepEqual(result.hits.map(hit => hit.messageID), ["m-0"])
  } finally { db.close() }
})

test("pass2 P1: replacing a checkout after a fresh check loses request authority", async () => {
  const parent = await temporary(), root = path.join(parent, "root")
  try {
    await git(root); await mkdir(path.join(root, "child"))
    const check = await rankedDirectoryOwnership(root, new AbortController().signal)
    assert.equal(await check(root, true), "owned")
    await rename(root, path.join(parent, "old")); await git(root); await mkdir(path.join(root, "child"))
    assert.equal(await check(path.join(root, "child"), true), "unknown_directory")
  } finally { await rm(parent, { recursive: true, force: true }) }
})

test("pass2 P1: replacing the common directory at the same pathname loses authority", async () => {
  const root = await temporary()
  try {
    await git(root)
    const check = await rankedDirectoryOwnership(root, new AbortController().signal)
    assert.equal(await check(root), "owned")
    await rename(path.join(root, ".git"), path.join(root, "old-git")); await git(root)
    assert.equal(await check(root, true), "unknown_directory")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("pass2 P1: publication performs an uncached root fence after directory validation", async () => {
  const db = database(["needle"])
  let fence = 0
  try {
    const check = async (_directory: string, fresh?: unknown) => {
      if (fresh === "root") { fence++; return "unknown_directory" as const }
      return "owned" as const
    }
    const result = await search(db, "needle", check)
    assert.equal(result.hits.length, 0)
    assert.equal(result.scanned, 0)
    assert.equal(fence, 1)
    assert(result.exclusions.includes("unknown_directory"))
  } finally { db.close() }
})

for (const [query, text] of [["éloigné", "éLoIgNÉ"], ["caféété", "caféÉté"], ["kelvin", "KELVIN"], ["shell", "ſHELL"]]) {
  test(`pass2 P2: Unicode substring prefilter preserves ${query} / ${text}`, async () => {
    const db = database([`before\n${text}\nafter`, "Un café récent\nAucun rapport"])
    try {
      const result = await search(db, query!)
      assert.equal(result.candidates, 1)
      assert.deepEqual(result.hits.map(hit => hit.messageID), ["m-0"])
    } finally { db.close() }
  })
}

test("pass2 P2: one deterministic scalar produces precise substring masks, overlaps and Unicode escapes", async () => {
  const db = database(["ababa"])
  const define = db.function.bind(db)
  let registrations = 0
  db.function = ((name: string, options: any, callback: any) => {
    registrations++
    assert.equal(options.deterministic, true)
    return define(name, options, callback)
  }) as typeof db.function
  try {
    await search(db, "abab baba")
    assert.equal(registrations, 1)
    const mask = db.prepare("SELECT codenomad_ranked_mask(?, 'user') AS mask")
    assert.equal(mask.get('{"text":"ababa"}')?.mask, 3)
    assert.equal(mask.get('{"text":"other\\ntext"}')?.mask, 0)
    assert.equal(mask.get('{"text":"\\u0061baba"}')?.mask, 3)
    assert.equal(mask.get('{"text":"\\\\UPPER"}')?.mask, 0)
  } finally { db.close() }
})

test("pass2 P2: adversarial 16 MiB rows yield promptly for mixed-accent and six-long-term queries", async () => {
  for (const query of ["bcdefg".split("").map(c => "a".repeat(28) + "Éé" + c).join(" "),
    "bcdefg".split("").map(c => "a".repeat(30) + c).join(" ")]) {
    const db = database(["a".repeat(16_777_000)])
    const define = db.function.bind(db)
    let calls = 0
    db.function = ((name: string, options: any, callback: any) => define(name, options, (data: any, role: any) => {
      calls++
      return callback(data, role)
    })) as typeof db.function
    try {
      const started = performance.now(), firstYield = tick().then(() => performance.now() - started)
      const result = await search(db, query)
      const elapsed = await firstYield
      console.log(`pass2 ${query.includes("É") ? "accent" : "ASCII"} adversary: ${elapsed.toFixed(0)} ms`)
      assert(elapsed < 900, `first yield took ${elapsed.toFixed(0)} ms`)
      assert.equal(result.prefilterBypassed, 1)
      assert.equal(calls, 1, "classify the projection once before marking large readable text unknown")
    } finally { db.close() }
  }
})

test("pass2 P2: a found hit and counts survive exhausted judgement time with fresh ownership", async t => {
  const db = database(["needle", "needle"])
  let now = 0, freshChecks = 0
  t.mock.method(performance, "now", () => now)
  const prepare = db.prepare.bind(db)
  db.prepare = ((sql: string) => {
    const statement = prepare(sql)
    if (sql.includes("AS data")) {
      const get = statement.get.bind(statement)
      statement.get = (...params) => { const row = Reflect.apply(get, statement, params); now = 2001; return row }
    }
    return statement
  }) as typeof db.prepare
  try {
    const result = await search(db, "needle", async (_directory, fresh) => { if (fresh) freshChecks++; return "owned" })
    assert.equal(result.hits.length, 1)
    assert.equal(result.scanned, 2)
    assert.equal(result.matchedSessions, 1)
    assert(result.caps.includes("total_time"))
    assert(freshChecks > 0)
  } finally { db.close() }
})

test("pass2 P3: workspace discovery reaches a checkout more than 128 levels above", async () => {
  const root = await temporary()
  try {
    await git(root)
    let deep = root
    for (let n = 0; n < 130; n++) { deep = path.join(deep, "x"); await mkdir(deep) }
    assert.equal(await readCheckoutCommonDirectory(deep), await realpath(path.join(root, ".git")))
    const check = await rankedDirectoryOwnership(deep, new AbortController().signal)
    assert.equal(await check(deep), "unknown_directory", "plugin discovery keeps its own bound")
  } finally { await rm(root, { recursive: true, force: true }) }
})
