import { readFile, writeFile } from "node:fs/promises"
import { hashes } from "./harness.mjs"
const roots = ["SlIXMX", "wiQsSe", "XkNPCJ", "znvkjp", "nXXDqv", "Khag6I", "tR2OkJ", "aHtzji", "MVBlF2", "RVJCZc", "NkXFan", "pelAK7", "JPwpQA"]
// Add later run roots explicitly: never scan/read another lane's private database.
roots.push(...process.argv.slice(2))
const runs = []
for (const suffix of roots) {
  const root = `C:/Users/Admin/AppData/Local/Temp/opencode/missions-child-environment-${suffix}`
  const result = JSON.parse(await readFile(`${root}/results.json`, "utf8"))
  const requests = JSON.parse(await readFile(`${root}/requests.json`, "utf8"))
  const hooks = await readFile(`${root}/hooks.jsonl`, "utf8").catch(() => "")
  runs.push({ root, phase: result.phase, status: result.status, failure: result.error ?? null, counts: result.counts, matrix: result.matrix,
    before: result.before, after: result.after, hashesUnchanged: result.hashesUnchanged,
    providerConsumptionIndices: requests.filter(record => JSON.stringify(record.body.messages).includes("DEPTH3_LEAF_REPORT:") || JSON.stringify(record.body.messages).includes("EXPLICIT_SAME_CHILD_CONTINUATION:") || JSON.stringify(record.body.messages).includes("EXPLICIT_PLAY_SAME_CHILD_CONTINUED")).map(record => ({ index: record.index, sessionID: record.sessionID, kind: record.kind })),
    rejections: hooks.split("\n").filter(Boolean).map(JSON.parse).filter(record => record.kind === "rejected" || record.kind === "environment-context-rejected") })
}
const report = { scope: "Private 2.0.22 native runner plus deterministic synthetic provider; not real-LLM or production trust qualification", runs, hashesNow: await hashes(),
  totals: { runs: runs.length, completed: runs.filter(run => run.status === "completed-experiments").length, failedFixturesPreserved: runs.filter(run => run.status === "failed-fixture").length, providerRequests: runs.reduce((sum, run) => sum + (run.counts?.providerRequests ?? 0), 0) } }
await writeFile(new URL("./RESULTS.json", import.meta.url), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ totals: report.totals, hashesNow: report.hashesNow, runs: runs.map(({ root, phase, status, counts }) => ({ root, phase, status, counts })) }, null, 2))
