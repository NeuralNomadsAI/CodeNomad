import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { ProjectUsage } from "../packages/server/src/opencode/project-usage.ts"

const git = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(cwd, "empty-git-config"), GIT_CONFIG_NOSYSTEM: "1" } })
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim()
}
let projectRoot, worktree, other
await withProductRuntime(process.argv[2], async ({ root }) => {
  projectRoot = path.join(root, "repo"); worktree = path.join(root, "worktree"); other = path.join(root, "other")
  for (const directory of [projectRoot, other]) {
    await mkdir(directory); git(directory, "init")
    await writeFile(path.join(directory, "fixture.txt"), directory)
    git(directory, "add", "fixture.txt")
    git(directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture")
  }
  git(projectRoot, "worktree", "add", "-b", "fixture-worktree", worktree)
}, async ({ client }) => {
  const from = Date.now() - 60_000
  for (const directory of [projectRoot, worktree, other]) {
    await client.location.get({ location: { directory } })
    const session = await client.session.create({ location: { directory } })
    await client.session.prompt({ sessionID: session.id, text: "Synthetic usage fixture", model: { providerID: "fixture", id: "fixture" } })
    await client.session.wait({ sessionID: session.id })
  }
  const record = {}, connection = { client, assertCurrent() {} }
  const usage = new ProjectUsage({ get: () => record, getSharedServiceConnection: async () => connection,
    getServiceDirectoryForPath: async (_id, directory) => [projectRoot, worktree].includes(directory) ? directory : undefined,
    ownsLocation: async (_id, location) => [projectRoot, worktree].includes(location.directory),
  }, async () => ({ available: true, platform: process.platform }))
  const result = await usage.read("fixture", { directory: worktree, from, to: Date.now() + 1000, timezone: "UTC" })
  assert.equal(result.stats.sessions, 2, "Project stats include owned worktrees, exclude foreign repository")
  assert.equal(result.stats.prompts, 2); assert.equal(result.stats.steps, 2)
  assert.equal(result.stats.tokens.input, 20); assert.equal(result.stats.tokens.output, 10)
  assert.equal(result.stats.models.length, 1); assert.equal(result.stats.models[0].model.providerID, "fixture")
  assert.deepEqual(result.stats.tools, { mode: "none" })
  assert.equal(result.stats.activity.reduce((sum, row) => sum + row.steps, 0), 2)
  await assert.rejects(usage.read("fixture", { directory: other, from, to: Date.now() + 1000, timezone: "UTC" }))
  console.log("PASS native project/worktree usage, foreign exclusion, durable tokens/models/activity and tools:none")
})
