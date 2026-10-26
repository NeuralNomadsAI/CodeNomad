#!/usr/bin/env node
// Runs one interleaved shard of the browser fixture suite. CI invokes this per
// matrix entry so each runner executes a slice serially — today's proven-stable
// mode — while the wall clock divides by the shard count. The shard owns the
// shared fixture daemon's lifecycle for its invocation: a healthy daemon whose
// source tree has not moved past it is adopted, a stale one is replaced, and
// one this shard started is stopped when the slice ends.
//   node tests/browser/shard.mjs <index-1-based> <total> [--dry-run]
import { spawn } from "node:child_process"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readyDirectoryFor } from "./fixture-daemon/paths.ts"
import { ensureInvocationDaemon } from "./fixture-daemon/orchestrate.ts"

const directory = path.dirname(fileURLToPath(import.meta.url))
const [index = "1", total = "1", dryRun] = process.argv.slice(2)
const shard = Number(index), shards = Number(total)
if (!Number.isInteger(shard) || shard < 1 || !Number.isInteger(shards) || shards < 1 || shard > shards) {
  console.error("usage: node tests/browser/shard.mjs <index 1-based> <total>")
  process.exit(2)
}

const files = (await import("node:fs/promises")).readdir(directory, { recursive: true })
const slice = (await files)
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
try { daemon = await ensureInvocationDaemon({ uiRoot, readyDirectory: readyDirectoryFor(uiRoot) }) }
catch (error) { console.error(`shard ${shard}/${shards}: ${error}; borrowers will use private daemons`) }

const child = spawn(process.execPath, [
  "--import", "tsx", "--test", `--test-concurrency=${process.env.SHARD_CONCURRENCY ?? "1"}`, ...slice,
], { stdio: "inherit", cwd: uiRoot })
child.on("error", error => { console.error(error); process.exit(1) })
child.on("close", async code => {
  if (daemon) await daemon.stop()
  process.exit(code ?? 1)
})
