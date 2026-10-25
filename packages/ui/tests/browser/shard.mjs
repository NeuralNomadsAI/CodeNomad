#!/usr/bin/env node
// Runs one interleaved shard of the browser fixture suite. CI invokes this per
// matrix entry so each runner executes a slice serially — today's proven-stable
// mode — while the wall clock divides by the shard count.
//   node tests/browser/shard.mjs <index-1-based> <total> [--dry-run]
import { readdir } from "node:fs/promises"
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const directory = path.dirname(fileURLToPath(import.meta.url))
const [index = "1", total = "1", dryRun] = process.argv.slice(2)
const shard = Number(index), shards = Number(total)
if (!Number.isInteger(shard) || shard < 1 || !Number.isInteger(shards) || shards < 1 || shard > shards) {
  console.error("usage: node tests/browser/shard.mjs <index 1-based> <total>")
  process.exit(2)
}

const files = (await readdir(directory))
  .filter(file => file.endsWith(".test.ts"))
  .sort()
  .filter((_, position) => position % shards === shard - 1)
  .map(file => path.join(directory, file))

if (!files.length) {
  console.error(`shard ${shard}/${shards} received no test files`)
  process.exit(2)
}
console.log(`shard ${shard}/${shards}: ${files.length} files`)
if (dryRun) { for (const file of files) console.log(file); process.exit(0) }

const child = spawn(process.execPath, [
  "--import", "tsx", "--test", `--test-concurrency=${process.env.SHARD_CONCURRENCY ?? "1"}`, ...files,
], { stdio: "inherit", cwd: path.resolve(directory, "../..") })
child.on("close", code => process.exit(code ?? 1))
