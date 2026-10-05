// Summarize the unfiltered repeated samples written by search-highlight.test.ts.
import { readFile } from "node:fs/promises"

const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2
}
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
for (const path of process.argv.slice(2)) {
  const data = JSON.parse(await readFile(path, "utf8"))
  console.log(`\n${path}\n${JSON.stringify({ versions: data.versions, cpu: data.cpu, platform: data.platform, build: data.build })}`)
  console.log("| Workload / mode | n | Matches | Sync p50/p95 ms | Paint opportunity p50/p95 ms | DOM records p50 | Long tasks |")
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: |")
  for (const workload of new Set(data.results.map(row => row.workload))) {
    for (const mode of ["baseline", "css"]) {
      const rows = data.results.filter(row => row.workload === workload && row.mode === mode)
      const summary = key => `${median(rows.map(row => row[key])).toFixed(2)} / ${p95(rows.map(row => row[key])).toFixed(2)}`
      console.log(`| ${workload} / ${mode} | ${rows.length} | ${rows[0].matches} | ${summary("synchronousMs")} | ${summary("paintOpportunityMs")} | ${median(rows.map(row => row.mutations))} | ${rows.reduce((n, row) => n + row.longTasks.length, 0)} |`)
    }
  }
  console.log("GC counters:", JSON.stringify(data.memoryEvidence))
}
