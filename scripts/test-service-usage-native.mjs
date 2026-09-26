import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { ServiceUsage } from "../packages/server/src/opencode/service-usage.ts"

const git = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(cwd, "empty-git-config"), GIT_CONFIG_NOSYSTEM: "1" } })
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim()
}
let projectRoot, worktree, other, clone
await withProductRuntime(process.argv[2], async ({ root }) => {
  projectRoot = path.join(root, "repo"); worktree = path.join(root, "worktree"); other = path.join(root, "other")
  for (const directory of [projectRoot, other]) {
    await mkdir(directory); git(directory, "init")
    await writeFile(path.join(directory, "fixture.txt"), directory)
    git(directory, "add", "fixture.txt")
    git(directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture")
  }
  git(projectRoot, "worktree", "add", "-b", "fixture-worktree", worktree)
  clone = path.join(root, "independent-clone")
  git(root, "clone", projectRoot, clone)
}, async ({ client }) => {
  const from = Date.now() - 60_000
  const locations = []
  for (const directory of [projectRoot, worktree, other, clone]) {
    locations.push(await client.location.get({ location: { directory } }))
    const session = await client.session.create({ location: { directory } })
    await client.session.prompt({ sessionID: session.id, text: "Synthetic usage fixture", model: { providerID: "fixture", id: "fixture" } })
    await client.session.wait({ sessionID: session.id })
  }
  const record = {}, connection = { client, assertCurrent() {} }
  assert.equal(locations[0].project.id, locations[3].project.id, "Independent clones share native project identity")
  const usage = new ServiceUsage({ get: () => record, getSharedServiceConnection: async () => connection })
  const result = await usage.read("fixture", { from, to: Date.now() + 1000, timezone: "UTC" })
  assert.equal(result.scope, "service")
  assert.equal(result.stats.sessions, 4, "Explicit service scope includes worktrees, independent clones and unrelated projects")
  assert.equal(result.stats.prompts, 4); assert.equal(result.stats.steps, 4)
  assert.equal(result.stats.tokens.input, 40); assert.equal(result.stats.tokens.output, 20)
  assert.equal(result.stats.models.length, 1); assert.equal(result.stats.models[0].model.providerID, "fixture")
  assert.deepEqual(result.stats.tools, { mode: "none" })
  assert.equal(result.stats.activity.reduce((sum, row) => sum + row.steps, 0), 4)
  console.log("PASS explicitly authorized service-wide usage including independent clone, durable tokens/models/activity and tools:none")
})
