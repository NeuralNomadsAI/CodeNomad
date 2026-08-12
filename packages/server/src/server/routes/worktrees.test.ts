import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import Fastify from "fastify"
import type { WorkspaceManager } from "../../workspaces/manager"
import { registerWorktreeRoutes } from "./worktrees"

test("related session creation resolves its native scope after admission", async () => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-related-session-"))
  const originalFetch = globalThis.fetch
  const requests: Request[] = []
  try {
    execFileSync("git", ["init"], { cwd: repository })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repository })
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repository })
    execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: repository })

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request)
      const url = new URL(request.url)
      const json = (value: unknown) => new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
      if (url.pathname === "/experimental/workspace/sync-list") return json({})
      if (url.pathname === "/experimental/workspace") return json([{ id: "feature", directory: "/native/feature" }])
      if (url.pathname === "/session" && request.method === "GET") {
        return json([{ id: "source", directory: "/native/feature", workspaceID: "feature" }])
      }
      if (url.pathname === "/session" && request.method === "POST") {
        return json({
          id: "created",
          slug: "created",
          projectID: "project",
          workspaceID: "feature",
          directory: "/native/feature",
          title: "New Session",
          version: "1",
          time: { created: 1, updated: 1 },
        })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    const workspaceManager = {
      get: () => ({ id: "workspace", path: repository }),
      getInstancePort: () => 4321,
      getInstanceAuthorizationHeader: () => undefined,
      resolveInstanceDirectory: async () => "/native/root",
    } as unknown as WorkspaceManager
    const app = Fastify({ logger: false })
    registerWorktreeRoutes(app, {
      workspaceManager,
      sessionMetadataPersistence: {} as never,
    })

    const response = await app.inject({
      method: "POST",
      url: "/api/workspaces/workspace/worktrees/sessions/source/create-related",
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().directory, "/native/feature")
    const create = requests.find((request) => new URL(request.url).pathname === "/session" && request.method === "POST")
    assert.ok(create)
    assert.equal(new URL(create.url).searchParams.get("workspace"), "feature")
    assert.equal(new URL(create.url).searchParams.get("directory"), "/native/feature")
    await app.close()
  } finally {
    globalThis.fetch = originalFetch
    await fs.rm(repository, { recursive: true, force: true })
  }
})
