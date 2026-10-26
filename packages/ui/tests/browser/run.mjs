#!/usr/bin/env node
// Tiered local runner: borrowed fixtures run wide (their heavy work is
// shared and cached on the invocation's fixture daemon), exempt files run
// serially (each owns a full Vite+Chromium tree, and the Git fixtures race
// on shared Monaco prototype assets — #1139's reviewer pinned the local
// suite at one heavy file at a time). The runner owns the daemon for its
// light tier: adopted if fresh, replaced if stale, stopped afterwards.
// CI keeps shard.mjs's serial slices.
//   node tests/browser/run.mjs [--dry-run]
import { spawn } from "node:child_process"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readyDirectoryFor } from "./fixture-daemon/paths.ts"
import { ensureInvocationDaemon } from "./fixture-daemon/orchestrate.ts"

const directory = path.dirname(fileURLToPath(import.meta.url))
const dryRun = process.argv.includes("--dry-run")

const entries = await readdir(directory, { recursive: true })
const files = entries.map(file => file.split(path.sep).join("/")).filter(file => file.endsWith(".test.ts")).sort()
const { exemptions, heavyServers } = await import("./fixture-exemptions.ts")
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
  ["borrowed", borrowed, Number(process.env.CODENOMAD_TIERED_LIGHT_WIDTH ?? 3)],
  ["exempt", owned, Number(process.env.CODENOMAD_TIERED_HEAVY_WIDTH ?? 1)],
]) {
  if (!slice.length) continue
  console.log(`— ${label}: ${slice.length} files at ${concurrency}-wide`)
  const daemon = label === "borrowed"
    ? await ensureInvocationDaemon({ uiRoot, readyDirectory: readyDirectoryFor(uiRoot) }).catch(error => {
        console.error(`fixture daemon unavailable (${error}); borrowers will use private daemons`)
        return null
      })
    : null
  const child = spawn(process.execPath, [
    "--import", "tsx", "--test", `--test-concurrency=${concurrency}`,
    ...slice.map(file => path.join(directory, file)),
  ], { stdio: "inherit", cwd: uiRoot })
  const code = await new Promise(resolve => {
    child.on("error", error => { console.error(error); resolve(1) })
    child.on("close", resolve)
  })
  failures ||= code === 0 ? 0 : 1 // a signal-terminated child (code === null) is a failure
  if (daemon) await daemon.stop()
}
process.exit(failures)
