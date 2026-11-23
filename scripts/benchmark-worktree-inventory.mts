import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout } from "node:timers/promises"
import type { OpenCodeClient } from "@opencode/client"
import { listNativeWorktrees } from "../packages/server/src/workspaces/native-worktrees"
import { requireHostGit } from "../packages/server/src/workspaces/git-requirement"
import { WorktreeInventory } from "../packages/server/src/workspaces/worktree-inventory"

const temp = mkdtempSync(path.join(tmpdir(), "codenomad-inventory-bench-"))
try {
  for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key]
  process.env.GIT_CONFIG_NOSYSTEM = "1"
  process.env.GIT_CONFIG_GLOBAL = path.join(temp, "empty-config")
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, "")
  const repo = path.join(temp, "main")
  const git = (directory: string, ...args: string[]) => execFileSync("git", ["-C", directory, ...args], { stdio: "pipe" })
  git(temp, "init", repo)
  git(repo, "-c", "user.name=Bench", "-c", "user.email=bench@example.com", "commit", "--allow-empty", "-m", "initial")
  git(repo, "config", "extensions.worktreeConfig", "true")
  const directories = [repo]
  for (let i = 0; i < 60; i++) {
    const directory = path.join(temp, `linked-${i}`)
    git(repo, "worktree", "add", "--detach", directory)
    directories.push(directory)
  }
  const trace = path.join(temp, "trace.jsonl")
  process.env.GIT_TRACE2_EVENT = trace
  const client = {
    location: { get: async () => ({ directory: repo, project: { id: "bench", directory: repo, canonical: repo } }) },
    worktree: { refresh: async () => {}, list: async () => directories.map(directory => ({ directory })) },
  } as unknown as OpenCodeClient
  let processed = 0
  let admit: () => void = () => {}
  const inventory = new WorktreeInventory({
    changed: () => {},
    failed: (_id, error) => { throw error },
    load: () => listNativeWorktrees({
      client, workspacePath: repo, location: { directory: repo },
      toHost: async directory => {
        if (directory !== repo && ++processed === 8) admit()
        return directory
      },
    }),
  })
  assert.equal((await inventory.read("bench", "validated")).worktrees.length, directories.length)
  for (let pass = 0; pass < 5; pass++) {
    writeFileSync(trace, "")
    processed = 0
    const inspecting = new Promise<void>(resolve => { admit = resolve })
    inventory.invalidate("bench")
    const scanStart = performance.now()
    const scan = inventory.read("bench", "validated")
    await Promise.race([inspecting, scan])
    // Let the first batch reach the worker, then run the same host-Git probe
    // as project session-list admission, independently of the inventory.
    await setTimeout(20)
    const probeStart = performance.now()
    await requireHostGit()
    const probeMs = Math.round(performance.now() - probeStart)
    assert.equal((await scan).worktrees.length, directories.length)
    const scanAndProbeMs = Math.round(performance.now() - scanStart)
    const starts = readFileSync(trace, "utf8").trim().split("\n")
      .map(line => JSON.parse(line)).filter(event => event.event === "start")
    const versionIndex = starts.findIndex(event => event.argv.includes("--version"))
    assert.notEqual(versionIndex, -1)
    console.log({ pass: pass + 1, count: starts.length, probeMs, scanAndProbeMs, versionIndex })
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}
