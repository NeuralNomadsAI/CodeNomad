import { DatabaseSync } from "node:sqlite"

// Synthetic native-style indexes deliberately exercise the join planner.
export function rankedBenchmarkDatabase(count = 40_000) {
  const db = new DatabaseSync(":memory:")
  db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT,workspace_id TEXT,project_id TEXT,title TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT);
    CREATE INDEX session_project ON session_v2(project_id,directory);
    CREATE INDEX message_session ON session_message(session_id,seq);`)
  const session = db.prepare("INSERT INTO session_v2 VALUES (?, ?, NULL, 'p', ?)")
  for (let n = 0; n < Math.ceil(count / 500); n++) session.run(`s-${n}`, n % 2 ? "/repo/src" : "/repo", `Synthetic ${n}`)
  const insert = db.prepare("INSERT INTO session_message VALUES (?,?,'assistant',?,?,?)")
  const output = "Vérification du module et de ses fichiers. Build output is ordinary terminal text.\n".repeat(400)
  db.exec("BEGIN")
  for (let n = 0; n < count; n++) insert.run(`m-${String(n).padStart(6, "0")}`, `s-${Math.floor(n / 500)}`, n, n + 1, JSON.stringify({
    content: [
      { type: "reasoning", text: "Réflexion sur la prochaine étape.\n".repeat(4) },
      { type: "tool", name: "shell", state: { input: { command: n % 5 ? "npm test" : "git worktree list" },
        content: [{ type: "text", text: (n % 3 ? "" : "\u001b[32m") + output }], metadata: { files: [] } } },
      { type: "text", text: ("Discussion du projet et décisions de conception.\n".repeat(8)) + (n % 10 ? "Ordinary conclusion." : "Keep this worktree decision.") },
    ], time: { created: n + 1, completed: n + 2 },
  }))
  db.exec("COMMIT")
  return db
}

export function instrumentRankedScan(db: DatabaseSync) {
  const stats = { chunks: 0, rows: 0, firstRowMs: 0, maxStepMs: 0, scanMs: 0, firstPosition: 0, lastPosition: 0, projectedParses: 0, plan: [] as string[] }
  const prepare = db.prepare.bind(db), parse = JSON.parse
  let stepping = false, began = 0, finished = 0, started = performance.now()
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    if (stepping) stats.projectedParses++
    return Reflect.apply(parse, JSON, args)
  }) as typeof JSON.parse
  db.prepare = ((sql: string) => {
    const statement = prepare(sql)
    if (!sql.includes("AS data")) {
      const get = statement.get.bind(statement)
      statement.get = (...params) => {
        const at = performance.now()
        try { return Reflect.apply(get, statement, params) }
        finally { stats.maxStepMs = Math.max(stats.maxStepMs, performance.now() - at) }
      }
    }
    if (sql.includes("AS mask")) {
      const iterate = statement.iterate.bind(statement)
      statement.iterate = function* (...params) {
        if (!began) began = performance.now()
        if (!stats.plan.length) stats.plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params as any[]).map(row => String(row.detail))
        stats.chunks++
        const iterator = Reflect.apply(iterate, statement, params)
        try {
          for (;;) {
            const at = performance.now()
            stepping = true
            let next
            try { next = iterator.next() } finally { stepping = false }
            stats.maxStepMs = Math.max(stats.maxStepMs, performance.now() - at)
            if (next.done) break
            if (!stats.rows) { stats.firstRowMs = performance.now() - started; stats.firstPosition = Number(next.value.position) }
            stats.rows++; stats.lastPosition = Number(next.value.position)
            yield next.value
          }
        } finally { iterator.return?.(); finished = performance.now(); stats.scanMs = finished - began }
      }
    }
    return statement
  }) as typeof db.prepare
  return { stats, start() { started = performance.now() }, dispose() { JSON.parse = parse; db.prepare = prepare } }
}
