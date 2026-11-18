import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import type { WorkspaceManager } from "../../workspaces/manager"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { registerRepositorySourceRoute } from "./repository-source"

test("repository discovery fences directory ownership, WSL translation, deletion, replacement and transport disclosure", async () => {
  const app = Fastify(), workspace = { id: "fixture" }, fence = new WorktreeDeletionFence()
  let identity = "owned", closed = false, reads = 0
  const manager = { get: (id: string) => id === "fixture" && !closed ? workspace : undefined,
    getServiceDirectoryForPath: async (_id: string, directory: string) => directory === "/service" ? "/service" : undefined,
    getHostPathForServicePath: async () => "C:/host", getWorktreeIdentityForPath: async () => identity } as unknown as WorkspaceManager
  let afterRead = () => {}
  registerRepositorySourceRoute(app, { workspaceManager: manager, worktreeDeletionFence: fence, forge: { openRepository: async (directory, fresh, signal) => {
    reads++; assert.equal(directory, "C:/host"); assert.equal(fresh, true); assert.equal(signal?.aborted, false); afterRead()
    return { status: "ok", repository: { provider: "gitlab", host: "gitlab.com", path: "group/sub/project", webUrl: "https://gitlab.com/group/sub/project", access: "cli" },
      transport: { access: "cli", request: async () => { throw new Error("Never serialized") } } }
  } } })
  const url = "/api/workspaces/fixture/repository-source?directory=/service"
  try {
    const response = await app.inject(url)
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { status: "ok", repository: { provider: "gitlab", host: "gitlab.com", repository: "group/sub/project" } })
    assert.equal((await app.inject(url.replace("/service", "/foreign"))).statusCode, 403)
    assert.equal((await app.inject(url.split("?")[0])).statusCode, 400)
    assert.equal((await app.inject(url.replace("/fixture/", "/missing/"))).statusCode, 404)
    await fence.run("owned", ["owned"], async () => { assert.equal((await app.inject(url)).statusCode, 409) })
    assert.equal(reads, 1)
    afterRead = () => { identity = "changed" }; assert.equal((await app.inject(url)).statusCode, 409)
    afterRead = () => { closed = true }; assert.equal((await app.inject(url)).statusCode, 409)
  } finally { await app.close() }
})
