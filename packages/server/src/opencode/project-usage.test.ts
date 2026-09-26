import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import { ProjectUsage } from "./project-usage"
import { registerProjectUsageRoutes } from "../server/routes/project-usage"

function fixture() {
  let current = true, git = true, owned = true, present = true, defer: (() => void) | undefined
  const record = {}, calls: any[] = []
  const project = { id: "project", canonical: "/repo", vcs: "git" }
  const connection = { assertCurrent() { assert.ok(current, "stale connection") }, client: {
    location: { get: async () => ({ directory: "/repo/worktree", project }) }, project: { list: async () => [project] },
    session: { stats: async (input: any) => { calls.push(input); if (defer) await new Promise<void>(resolve => { defer = resolve }); return { sessions: 3, tools: { mode: "none" } } } },
  } }
  const manager: any = { get: () => present ? record : undefined, getSharedServiceConnection: async () => connection,
    getServiceDirectoryForPath: async (_id: string, directory: string) => directory === "/repo/worktree" ? directory : undefined,
    ownsLocation: async () => owned }
  return { service: new ProjectUsage(manager, async () => ({ available: git, platform: process.platform })), calls, project,
    stale: () => { current = false }, loseGit: () => { git = false }, disown: () => { owned = false }, close: () => { present = false },
    defer: () => { defer = () => {} }, release: () => defer?.() }
}
const query = { directory: "/repo/worktree", from: 1, to: 2, timezone: "UTC" }
test("usage derives native project identity and always disables tool aggregation", async () => {
  const f = fixture()
  assert.equal((await f.service.read("w", query)).project, "project")
  assert.deepEqual(f.calls, [{ project: "project", from: 1, to: 2, timezone: "UTC", tools: "none" }])
  await assert.rejects(f.service.read("w", { ...query, directory: "/foreign" }), /not owned/)
  f.project.vcs = "other"
  await assert.rejects(f.service.read("w", query), /not owned/)
  f.project.vcs = "git"; f.loseGit()
  await assert.rejects(f.service.read("w", query), /Git/)
  assert.equal(f.calls.length, 1)
})
test("usage rejects late connection, Git, workspace and ownership changes", async () => {
  for (const invalidate of ["stale", "loseGit", "close", "disown"] as const) {
    const f = fixture(); f.defer()
    const pending = f.service.read("w", query)
    while (!f.calls.length) await new Promise(resolve => setImmediate(resolve))
    f[invalidate](); f.release()
    await assert.rejects(pending)
  }
})
test("usage route bounds periods and rejects global/project or tool-detail selectors", async () => {
  const app = Fastify(), f = fixture()
  registerProjectUsageRoutes(app, f.service)
  const url = "/api/workspaces/w/usage?directory=%2Frepo%2Fworktree&from=1&to=2&timezone=UTC"
  try {
    assert.equal((await app.inject(url)).statusCode, 200)
    for (const extra of ["&project=foreign", "&tools=detail", "&workspaceID=legacy", "&from=0"]) assert.equal((await app.inject(url + extra)).statusCode, 400)
    for (const invalid of [url.replace("to=2", "to=1"), url.replace("to=2", "to=999999999999"), url.replace("UTC", "Invalid/Zone")]) assert.equal((await app.inject(invalid)).statusCode, 400)
    assert.equal(f.calls.length, 1)
  } finally { await app.close() }
})
