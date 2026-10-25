#!/usr/bin/env node
// Tiered local runner: borrowed fixtures run four-wide (their heavy work is
// shared and cached on the daemon), exempt files run two-wide (each owns a
// full Vite+Chromium tree). CI keeps shard.mjs's serial slices.
//   node tests/browser/run.mjs [--dry-run]
import { spawn } from "node:child_process"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const directory = path.dirname(fileURLToPath(import.meta.url))
const dryRun = process.argv.includes("--dry-run")

const files = (await readdir(directory)).filter(file => file.endsWith(".test.ts")).sort()
const exemptionSource = await readFile(path.join(directory, "fixture-exemptions.ts"), "utf8")
const exempt = new Set([...exemptionSource.matchAll(/"([^"]+)":/g)].map(match => match[1]))
const borrowed = files.filter(file => !exempt.has(file))
const owned = files.filter(file => exempt.has(file))

console.log(`tiered run: ${borrowed.length} borrowed (4-wide) + ${owned.length} exempt (2-wide)`)
if (dryRun) { console.log(borrowed.join("\n")); process.exit(0) }

for (const [label, slice, concurrency] of [["borrowed", borrowed, 4], ["exempt", owned, 2]]) {
  if (!slice.length) continue
  console.log(`— ${label}: ${slice.length} files at ${concurrency}-wide`)
  const child = spawn(process.execPath, [
    "--import", "tsx", "--test", `--test-concurrency=${concurrency}`,
    ...slice.map(file => path.join(directory, file)),
  ], { stdio: "inherit", cwd: path.resolve(directory, "../..") })
  const code = await new Promise(resolve => child.on("close", resolve))
  if (code) process.exit(code)
}
