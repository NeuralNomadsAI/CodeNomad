import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Read-only source A/B in isolated loopback Chromium fixtures. No checkout,
// desktop, daemon, database or user-profile mutation is needed.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const ui = join(root, "packages/ui")
const reference = "47f9e43e3fa1a3be59c0f94932a7af0a4be20660"
const source = "packages/ui/src/components/tool-call/renderers/task.tsx"
const repetitions = Number(process.argv[2] ?? 3)
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) throw new Error("Use 1–10 repetitions")
const directory = mkdtempSync(join(tmpdir(), "codenomad-render-cost-"))
const baselinePath = join(directory, "task-baseline.tsx")
writeFileSync(baselinePath, execFileSync("git", ["show", `${reference}:${source}`], { cwd: root }))
const runs = []
for (let repetition = 0; repetition < repetitions; repetition++) {
  for (const variant of ["baseline", "fixed"]) {
    const env = { ...process.env, CODENOMAD_RENDER_INSTRUMENT: "off" }
    if (variant === "baseline") env.CODENOMAD_RENDER_TASK_BASELINE = baselinePath
    else delete env.CODENOMAD_RENDER_TASK_BASELINE
    const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1",
      "--test-name-pattern=^audit sample:", "tests/browser/render-cost.test.ts"], {
      cwd: ui, env, encoding: "utf8", windowsHide: true, timeout: 120_000,
    })
    writeFileSync(join(directory, `${repetition + 1}-${variant}.log`), `${result.stdout ?? ""}\n${result.stderr ?? ""}`)
    if (result.status !== 0) throw new Error(`Fixture failed (${variant}): ${result.error ?? result.stderr}; logs: ${directory}`)
    const match = result.stdout.match(/render-cost-native-deltas (\{[^\r\n]*\})/)
    if (!match) throw new Error(`No metrics in ${variant}; logs: ${directory}`)
    const metrics = JSON.parse(match[1])
    if (metrics.variant !== variant || metrics.instrumented || metrics.samples.length !== 10) throw new Error("Invalid A/B fixture metadata")
    runs.push({ repetition: repetition + 1, ...metrics })
    console.log(`${repetition + 1}/${repetitions} ${variant}: 10 samples recorded`)
  }
}
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  return { n: values.length, median: (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2,
    min: sorted[0], max: sorted.at(-1), mean,
    sampleStandardDeviation: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)) }
}
const summary = Object.fromEntries(["baseline", "fixed"].map(variant => {
  const samples = runs.filter(run => run.variant === variant).flatMap(run => run.samples)
  return [variant, Object.fromEntries(["syncMs", "scriptMs", "taskMs", "layoutMs", "styleMs"].map(key => [key, stats(samples.map(sample => sample[key]))]))]
}))
const artifact = { reference, fixedSourceSha256: createHash("sha256").update(readFileSync(join(root, source))).digest("hex"),
  browserPath: process.env.CODENOMAD_BROWSER_PATH ?? "Playwright default", node: process.version,
  repetitions, scenario: "80 completed read steps × 8,000 characters; 3 warmup deltas, 10 single native text deltas per run",
  notes: "CDP cumulative CPU deltas through two animation frames; not frame latency. Instrumentation off. Other host activity is not controlled.",
  summary, runs }
writeFileSync(join(directory, "metrics.json"), JSON.stringify(artifact, null, 2))
console.log(JSON.stringify(summary, null, 2))
console.log(`Raw metrics and logs: ${join(directory, "metrics.json")}`)
