#!/usr/bin/env node
// Runs one interleaved shard of the browser fixture suite. CI invokes this per
// matrix entry so each runner executes a slice serially — today's proven-stable
// mode — while the wall clock divides by the shard count. The shard owns the
// fixture daemon for its invocation: spawned as a child here, its endpoint
// handed to the test processes through the environment, stopped (portably,
// over HTTP) when the slice ends — and it follows this process to the grave
// even if the runner dies without cleanup.
//   node tests/browser/shard.mjs <index-1-based> <total> [--dry-run]
import { spawn } from "node:child_process"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { startRunDaemon } from "./fixture-daemon/run.ts"

const directory = path.dirname(fileURLToPath(import.meta.url))
const [index = "1", total = "1", dryRun] = process.argv.slice(2)
const shard = Number(index), shards = Number(total)
if (!Number.isInteger(shard) || shard < 1 || !Number.isInteger(shards) || shards < 1 || shard > shards) {
  console.error("usage: node tests/browser/shard.mjs <index 1-based> <total>")
  process.exit(2)
}

const slice = (await readdir(directory, { recursive: true }))
  .filter(file => file.endsWith(".test.ts"))
  .sort()
  .filter((_, position) => position % shards === shard - 1)
  .map(file => path.join(directory, file))

if (!slice.length) {
  console.error(`shard ${shard}/${shards} received no test files`)
  process.exit(2)
}
console.log(`shard ${shard}/${shards}: ${slice.length} files`)
if (dryRun) { for (const file of slice) console.log(file); process.exit(0) }

const uiRoot = path.resolve(directory, "../..")
let daemon = null
try { daemon = await startRunDaemon({ uiRoot }) }
catch (error) { console.error(`shard ${shard}/${shards}: ${error}; borrowers will use standalone daemons`) }

const child = spawn(process.execPath, [
  "--import", "tsx", "--test", `--test-concurrency=${process.env.SHARD_CONCURRENCY ?? "1"}`, ...slice,
], { stdio: "inherit", cwd: uiRoot, env: daemon ? { ...process.env, ...daemon.env } : process.env })
// A spawn error can be followed by "close": finish once, and let a failed
// daemon teardown fail the shard.
let finished = false
async function finish(code) {
  if (finished) return
  finished = true
  if (daemon) await daemon.stop().catch(error => { console.error(String(error)); code ||= 1 })
  process.exit(code)
}
child.on("error", error => { console.error(error); void finish(1) })
child.on("close", code => void finish(code ?? 1))
