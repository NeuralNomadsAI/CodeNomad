import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"

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
