#!/usr/bin/env node
// Tiered local runner: borrowed fixtures run one file at a time (the local
// suite's proven-stable mode; the Git fixtures rebuild one checkout-wide
// Monaco asset directory that is concurrently unsafe, and wide runs grow
// load-sensitive failures on slow machines) against a daemon this runner
// owns — spawned here, its endpoint handed to the test processes through
// the environment, stopped portably when the tier ends. Exempt files keep
// their own full Vite+Chromium trees. CI keeps shard.mjs's serial slices.
// Widths stay tunable for braver machines.
//   node tests/browser/run.mjs [--dry-run]
import { spawn } from "node:child_process"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { startRunDaemon } from "./fixture-daemon/run.ts"

const directory = path.dirname(fileURLToPath(import.meta.url))
const dryRun = process.argv.includes("--dry-run")

const entries = await readdir(directory, { recursive: true })
const files = entries.map(file => file.split(path.sep).join("/")).filter(file => file.endsWith(".test.ts")).sort()
const { heavyServers } = await import("./fixture-exemptions.ts")
const borrowed = files.filter(file => !heavyServers.has(file))
const owned = files.filter(file => heavyServers.has(file))

console.log(`tiered run: ${borrowed.length} borrowed + ${owned.length} exempt (widths via CODENOMAD_TIERED_LIGHT_WIDTH/HEAVY_WIDTH)`)
if (dryRun) {
  console.log("--- borrowed:"); for (const file of borrowed) console.log(file)
  console.log("--- exempt:"); for (const file of owned) console.log(file)
  process.exit(0)
}

const uiRoot = path.resolve(directory, "../..")
let failures = 0
for (const [label, slice, concurrency] of [
  ["borrowed", borrowed, Number(process.env.CODENOMAD_TIERED_LIGHT_WIDTH ?? 1)],
  ["exempt", owned, Number(process.env.CODENOMAD_TIERED_HEAVY_WIDTH ?? 1)],
]) {
  if (!slice.length) continue
  console.log(`— ${label}: ${slice.length} files at ${concurrency}-wide`)
  const daemon = label === "borrowed"
    ? await startRunDaemon({ uiRoot }).catch(error => {
        console.error(`fixture daemon unavailable (${error}); borrowers will use standalone daemons`)
        return null
      })
    : null
  const child = spawn(process.execPath, [
    "--import", "tsx", "--test", `--test-concurrency=${concurrency}`,
    ...slice.map(file => path.join(directory, file)),
  ], { stdio: "inherit", cwd: uiRoot, env: daemon ? { ...process.env, ...daemon.env } : process.env })
  const code = await new Promise(resolve => {
    child.on("error", error => { console.error(error); resolve(1) })
    child.on("close", resolve)
  })
  failures ||= code === 0 ? 0 : 1 // a signal-terminated child (code === null) is a failure
  if (daemon) await daemon.stop()
}
process.exit(failures)
