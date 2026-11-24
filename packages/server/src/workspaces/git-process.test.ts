import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"
import { runGitProcess } from "./git-process"

// The native Missions plugin ships this module through an esbuild ESM bundle
// (scripts/build-missions-plugin.mjs). Free `require` inside the eval worker
// source was rewritten to an undefined `__require`, so every Git call failed.
test("bundled Git worker still runs Git after esbuild ESM rewriting", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "git-process-bundle-")))
  try {
    const repo = path.join(root, "repo")
    execFileSync("git", ["init", "-q", repo])
    const output = await build({ entryPoints: [fileURLToPath(new URL("./git-process.ts", import.meta.url))],
      bundle: true, write: false, platform: "node", format: "esm", target: "node22" })
    const bundle = path.join(root, "git-process.mjs")
    await writeFile(bundle, output.outputFiles[0]!.text)
    const { runWorktreeGit } = await import(pathToFileURL(bundle).href) as typeof import("./git-process")
    const top = await runWorktreeGit(repo, ["rev-parse", "--show-toplevel"])
    assert.equal(await realpath(top), repo)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("queued inventory probes make progress through a sustained foreground batch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-process-fairness-"))
  try {
    const trace = path.join(root, "trace.jsonl")
    const env = { GIT_TRACE2_EVENT: trace }
    const blockers = Array.from({ length: 2 }, () =>
      runGitProcess(root, ["-c", "alias.pause=!sleep 0.2", "pause"], { env }))
    const inventory = runGitProcess(root, ["-c", "test.queue=inventory", "--version"], { env })
    const foreground = Array.from({ length: 16 }, () =>
      runGitProcess(root, ["-c", "test.queue=foreground", "--version"], { env, priority: "foreground" }))
    await Promise.all([...blockers, ...foreground, inventory])
    const starts = (await readFile(trace, "utf8")).trim().split("\n")
      .map(line => JSON.parse(line)).filter(event => event.event === "start")
    const first = starts.findIndex(event => event.argv.includes("test.queue=foreground"))
    const last = starts.map(event => event.argv.includes("test.queue=foreground")).lastIndexOf(true)
    const bulk = starts.findIndex(event => event.argv.includes("test.queue=inventory"))
    assert.ok(first !== -1 && first < bulk && bulk < last, `foreground range ${first}–${last}; inventory ${bulk}`)
  } finally { await rm(root, { recursive: true, force: true }) }
})
