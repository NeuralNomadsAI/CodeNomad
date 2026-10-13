import { DatabaseSync } from "node:sqlite"
import { performance } from "node:perf_hooks"
import { setImmediate as turn } from "node:timers/promises"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { buildSync } from "esbuild"
import { readSessionOutline as currentOutline } from "../packages/server/src/opencode/session-pruning/outline-index"

const baseline = process.argv.includes("--baseline")
let readSessionOutline = currentOutline
if (baseline) {
  // Compile the immutable pre-mission source without changing the working tree.
  const directory = fileURLToPath(new URL("../packages/server/src/opencode/session-pruning/", import.meta.url))
  const source = execFileSync("git", ["show", "366830f6:packages/server/src/opencode/session-pruning/outline-index.ts"],
    { cwd: directory, encoding: "utf8" })
  const built = buildSync({ stdin: { contents: source, loader: "ts", resolveDir: directory }, bundle: true,
    platform: "node", format: "esm", write: false })
  readSessionOutline = (await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`)).readSessionOutline
}

// Synthetic memory-only database. Never discovers or opens an OpenCode database.
const count = Number(process.argv[2] ?? 256)
const bytes = Number(process.argv[3] ?? 262144)
if (!Number.isInteger(count) || count < 1 || count > 1024 || !Number.isInteger(bytes) || bytes < 1 || bytes > 1048576) {
  throw new Error("Use 1–1024 rows and 1–1048576 payload bytes per row")
}
const db = new DatabaseSync(":memory:")
try {
  db.exec(`CREATE TABLE session_v2(id TEXT,directory TEXT,project_id TEXT,workspace_id TEXT,revert TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,data TEXT,time_updated INTEGER DEFAULT 0);
    CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id,seq);
    INSERT INTO session_v2 VALUES ('s','/repo','p',NULL,NULL);`)
  const data = JSON.stringify({ content: [{ type: "tool", name: "read", state: { content: [{ type: "text", text: "x".repeat(bytes) }] } }] })
  const insert = db.prepare("INSERT INTO session_message(id,session_id,type,seq,data) VALUES (?,'s','assistant',?,?)")
  for (let i = 0; i < count; i++) insert.run(`m${i}`, i, data)
  for (let sample = 0; sample < 3; sample++) {
    await turn()
    const gaps: number[] = []
    let previous = performance.now()
    const start = previous
    let stopped = false
    const tick = () => {
      if (stopped) return
      const now = performance.now()
      gaps.push(now - previous)
      previous = now
      setImmediate(tick)
    }
    setImmediate(tick)
    const result = await readSessionOutline(db, { directory: "/repo", projectID: "p", sessionID: "s" }, undefined, new AbortController().signal)
    const elapsed = performance.now() - start
    await turn()
    stopped = true
    console.log(JSON.stringify({ baseline, sample, count, bytes, entries: result.status === "outline" ? result.entries.length : -1,
      elapsedMs: Math.round(elapsed), maxTurnGapMs: Math.round(Math.max(...gaps)), turns: gaps.length }))
  }
} finally { db.close() }
