// Run with `node --import tsx`; compare --baseline=/path/to/historical.ts.
import { performance } from "node:perf_hooks"
import { fileURLToPath, pathToFileURL } from "node:url"

const baseline = process.argv.find(arg => arg.startsWith("--baseline="))?.slice("--baseline=".length)
const source = baseline ? pathToFileURL(baseline).href : new URL("../packages/ui/src/components/session-outline-projection.ts", import.meta.url).href
const { createSessionOutlineProjection } = await import(source)
const results = []
for (const count of [1000, 10000, 50000]) {
  const entries = Array.from({ length: count }, (_, seq) => ({
    id: `message-${seq}`, seq, type: "assistant", tools: seq % 3 === 0 ? 1 : 0,
    toolName: seq % 3 === 0 ? "read" : undefined, reasoning: 0,
  }))
  const marker = { id: "stream", messageId: `message-${count - 1}`, type: "assistant",
    label: "assistant", tooltip: "streaming", totalChars: 0 }
  const project = createSessionOutlineProjection()
  let translations = 0
  const t = key => { translations++; return key }
  const initial = project(entries, [marker], t)
  translations = 0
  const times = [], publications = []
  for (let token = 0; token < 64; token++) {
    const start = performance.now()
    publications.push(project(entries, [marker], t))
    times.push(performance.now() - start)
  }
  const sorted = [...times].sort((a, b) => a - b)
  const updated = project(entries, [{ ...marker, tooltip: "new streamed prefix", totalChars: 128 }], t)
  results.push({ count, medianMs: sorted[Math.floor(sorted.length / 2)], maximumMs: Math.max(...times),
    totalMs: times.reduce((sum, value) => sum + value, 0), translations,
    unchangedArrayIdentity: publications.every(result => result === initial),
    changedTextPublished: updated.find(segment => segment.id === `${marker.messageId}:outline`)?.tooltip === "new streamed prefix" })
}
console.log(JSON.stringify({ source: fileURLToPath(source), results }, null, 2))
