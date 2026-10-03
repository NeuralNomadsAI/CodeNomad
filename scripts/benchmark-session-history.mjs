// Synthetic in-memory database only. Compare this checkout with a Git revision:
// node scripts/benchmark-session-history.mjs [baseline-ref]
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = fileURLToPath(new URL("..", import.meta.url))
const source = "packages/server/src/opencode/session-pruning/history-store.ts"
const baseline = process.argv[2] ?? "HEAD"
const implementations = []
for (const [name, contents] of [
  [baseline, execFileSync("git", ["show", `${baseline}:${source}`], { cwd: root, encoding: "utf8" })],
  ["working tree", readFileSync(resolve(root, source), "utf8")],
]) {
  const result = await build({ stdin: { contents, resolveDir: dirname(resolve(root, source)), loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "node" })
  const { queryHistoryPage } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`)
  implementations.push([name, queryHistoryPage])
}
const db = new DatabaseSync(":memory:")
db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY, directory TEXT, workspace_id TEXT, project_id TEXT);
  CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, type TEXT, data TEXT);
  INSERT INTO session_v2 VALUES ('s', '/repo', NULL, 'p')`)
const insert = db.prepare("INSERT INTO session_message VALUES (?, 's', 'assistant', ?)")
const payload = JSON.stringify({ content: [
  { type: "reasoning", text: "thinking ".repeat(10000) },
  { type: "tool", state: { content: [{ type: "text", text: "large output ".repeat(80000) }] } },
  { type: "text", text: "A searchable needle answer" },
] })
for (let n = 0; n < 128; n++) insert.run(`m-${n}`, payload)
let materialized = 0
const prepare = db.prepare.bind(db)
db.prepare = sql => {
  const statement = prepare(sql)
  if (sql.includes("AS data")) {
    const iterate = statement.iterate.bind(statement)
    statement.iterate = function* (...params) {
      for (const row of iterate(...params)) {
        materialized += typeof row.data === "string" ? Buffer.byteLength(row.data) : 0
        yield row
      }
    }
  }
  return statement
}
try {
  for (const purpose of ["stats", "search"]) {
    for (const [name, queryHistoryPage] of implementations) {
      const times = []
      for (let run = 0; run < 4; run++) {
        const start = performance.now()
        let cursor, scanned = 0, hits = 0
        materialized = 0
        do {
          const page = await queryHistoryPage(db, { directory: "/repo", sessionID: "s", projectID: "p" },
            { purpose, query: purpose === "search" ? "needle" : "", includeTechnical: false, cursor }, new AbortController().signal)
          cursor = page.cursor ?? undefined
          scanned += page.scanned
          hits += page.hits.length
          assert.equal(page.skipped, 0)
        } while (cursor)
        assert.equal(scanned, 128)
        assert.equal(hits, purpose === "search" ? 128 : 0)
        if (run) times.push(performance.now() - start)
      }
      times.sort((a, b) => a - b)
      console.log(JSON.stringify({ purpose, implementation: name, medianMs: Math.round(times[1]), materializedBytes: materialized }))
    }
  }
} finally { db.close() }
