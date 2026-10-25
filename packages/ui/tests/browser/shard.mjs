#!/usr/bin/env node
// Runs one interleaved shard of the browser fixture suite. CI invokes this per
// matrix entry so each runner executes a slice serially — today's proven-stable
// mode — while the wall clock divides by the shard count. On Linux the shard
// owns the shared fixture daemon's lifecycle: started (and warmed) before the
// slice, stopped after it, unless an earlier daemon is already serving.
//   node tests/browser/shard.mjs <index-1-based> <total> [--dry-run]
import { spawn } from "node:child_process"
import { mkdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readyDirectoryFor } from "./fixture-daemon/paths.ts"

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
let ownedDaemon = null
if (process.platform === "linux") ownedDaemon = await ensureDaemon()

const child = spawn(process.execPath, [
  "--import", "tsx", "--test", `--test-concurrency=${process.env.SHARD_CONCURRENCY ?? "1"}`, ...slice,
], { stdio: "inherit", cwd: uiRoot })
child.on("close", async code => {
  if (ownedDaemon) {
    try { process.kill(ownedDaemon.pid, "SIGTERM") } catch { /* already gone */ }
    await rm(ownedDaemon.readyDirectory, { recursive: true, force: true })
  }
  process.exit(code ?? 1)
})

async function ensureDaemon() {
  const readyDirectory = readyDirectoryFor(uiRoot)
  const readyFile = path.join(readyDirectory, "ready")
  const probe = async () => readFile(readyFile, "utf8")
    .then(JSON.parse)
    .then(async ready => (await fetch(`http://127.0.0.1:${ready.port}/__daemon/health`).then(() => ready, () => null)))
    .catch(() => null)
  let ready = await probe()
  if (ready) return null // an earlier daemon is already serving this checkout
  await rm(readyDirectory, { recursive: true, force: true })
  await mkdir(readyDirectory, { recursive: true }).catch(() => {})
  spawn(process.execPath, ["--import", "tsx", path.join(directory, "fixture-daemon", "daemon.mjs")],
    { detached: true, stdio: "ignore", cwd: uiRoot }).unref()
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    ready = await probe()
    if (ready) { console.log(`shard ${shard}/${shards}: fixture daemon on port ${ready.port}`); return { pid: ready.pid, readyDirectory } }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  console.error(`shard ${shard}/${shards}: fixture daemon did not become ready; borrowers will fall back to lazy spawning`)
  return null
}
