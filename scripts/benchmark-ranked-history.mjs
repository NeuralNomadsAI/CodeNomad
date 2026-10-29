// Synthetic in-memory data only; never opens native service discovery or a user DB.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { tsImport } from "tsx/esm/api"

const root = fileURLToPath(new URL("..", import.meta.url))
const source = "packages/server/src/opencode/session-pruning/history-ranked-store.ts"
const baseline = process.argv[2] ?? "HEAD"
const { rankedBenchmarkDatabase, instrumentRankedScan } = await tsImport("../packages/server/src/opencode/session-pruning/history-ranked-benchmark-fixture.ts", import.meta.url)
const db = rankedBenchmarkDatabase(Number(process.env.RANKED_BENCHMARK_ROWS ?? 40_000))
try {
  for (const [name, contents] of [[baseline, execFileSync("git", ["show", `${baseline}:${source}`], { cwd: root, encoding: "utf8" })],
    ["working tree", readFileSync(resolve(root, source), "utf8")]]) {
    const built = await build({ stdin: { contents, resolveDir: dirname(resolve(root, source)), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "node" })
    const { queryRankedHistory } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`)
    for (let run = 1; run <= 3; run++) {
      const measurement = instrumentRankedScan(db)
      const started = performance.now(); measurement.start()
      try {
        const result = await queryRankedHistory(db, { directory: "/repo", projectID: "p" },
          { version: 1, query: "worktree", includeTechnical: false, limit: 20 }, new AbortController().signal, async () => "owned")
        const stats = measurement.stats
        console.log(JSON.stringify({ implementation: name, run, scanned: result.scanned, candidates: result.candidates, judged: result.judged,
          caps: result.caps, elapsedMs: Math.round(performance.now() - started), scanMs: Math.round(stats.scanMs), rowsPerSecond: Math.round(1000 * stats.rows / stats.scanMs),
          firstRowMs: +stats.firstRowMs.toFixed(2), maxStepMs: +stats.maxStepMs.toFixed(2), firstPosition: stats.firstPosition, lastPosition: stats.lastPosition,
          projectedParses: stats.projectedParses, chunks: stats.chunks, matchedSessions: result.matchedSessions,
          firstHit: result.hits[0]?.messageID, plan: stats.plan }))
      } finally { measurement.dispose() }
    }
  }
} finally { db.close() }
