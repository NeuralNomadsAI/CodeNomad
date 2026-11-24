import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import Fastify from "fastify"
import type { WorkspaceManager } from "../../workspaces/manager"
import { GitInitError } from "../../workspaces/git-init"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { registerWorkspaceRoutes } from "./workspaces"

describe("Git initialization route", () => {
  let root: string, folder: string
  before(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "codenomad-git-init-route-")))
    folder = path.join(root, "opened")
    await mkdir(folder)
  })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  const setup = (overrides: Partial<Record<"identity" | "initialize", unknown>> = {}) => {
    const app = Fastify()
    const fence = new WorktreeDeletionFence()
    const calls: string[] = []
    const workspaceManager = {
      get: (id: string) => id === "test" ? { id, path: folder } : undefined,
      getWorktreeIdentityForPath: async (_id: string, directory: string) => { calls.push(`identity:${directory}`); return "identity" in overrides ? overrides.identity : directory },
      initializeGit: async (id: string) => {
        calls.push(`init:${id}`)
        if (overrides.initialize) await (overrides.initialize as () => Promise<void>)()
      },
      getWorktrees: async (id: string, mode: string) => { calls.push(`worktrees:${id}:${mode}`); return { isGitRepo: true, worktrees: [] } },
    } as unknown as WorkspaceManager
    registerWorkspaceRoutes(app, { workspaceManager, worktreeDeletionFence: fence })
    const post = (directory: string, id = "test") => app.inject({ method: "POST", url: `/api/workspaces/${id}/git-init`, payload: { directory } })
    return { app, fence, calls, post }
  }

  it("initializes the opened folder under its deletion fence and republishes the inventory", async () => {
    const { app, calls, post } = setup()
    try {
      const response = await post(folder)
      assert.equal(response.statusCode, 200, response.body)
      assert.deepEqual(response.json(), { ok: true })
      assert.deepEqual(calls, [`identity:${folder}`, "init:test", "worktrees:test:fresh"])
    } finally { await app.close() }
  })

  it("refuses unknown workspaces, other directories and parents before any native request", async () => {
    const { app, calls, post } = setup()
    try {
      assert.equal((await post(folder, "missing")).statusCode, 404)
      for (const directory of [root, path.join(root, "absent")]) {
        const response = await post(directory)
        assert.equal(response.statusCode, 409, response.body)
        assert.equal(response.json().code, "git_init_directory_mismatch")
      }
      assert.equal((await app.inject({ method: "POST", url: "/api/workspaces/test/git-init", payload: {} })).statusCode, 400)
      assert.deepEqual(calls, [])
    } finally { await app.close() }
  })

  it("respects ownership and an in-progress deletion", async () => {
    const unowned = setup({ identity: undefined })
    try {
      assert.equal((await unowned.post(folder)).statusCode, 403)
      assert.ok(!unowned.calls.some(call => call.startsWith("init:")))
    } finally { await unowned.app.close() }
    const fenced = setup()
    try {
      await fenced.fence.run(folder, [folder], async () => {
        const response = await fenced.post(folder)
        assert.equal(response.statusCode, 409, response.body)
      })
      assert.ok(!fenced.calls.some(call => call.startsWith("init:")))
    } finally { await fenced.app.close() }
  })

  it("reports native unsupported and uncertain failures once, without refreshing as success", async () => {
    for (const [error, status, code] of [
      [new GitInitError("VCS provider does not support initialization", 501, "git_init_unsupported"), 501, "git_init_unsupported"],
      [new GitInitError("fetch failed", 502, "git_init_failed"), 502, "git_init_failed"],
    ] as const) {
      const { app, calls, post } = setup({ initialize: async () => { throw error } })
      try {
        const response = await post(folder)
        assert.equal(response.statusCode, status, response.body)
        assert.equal(response.json().code, code)
        assert.deepEqual(calls.filter(call => call.startsWith("init:")), ["init:test"])
        assert.ok(!calls.some(call => call.startsWith("worktrees:")))
      } finally { await app.close() }
    }
  })
})
