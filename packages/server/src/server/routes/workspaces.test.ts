import assert from "node:assert/strict"
import { describe, it } from "node:test"
import Fastify from "fastify"

import type { WorkspaceDescriptor } from "../../api-types"
import type { WorkspaceManager } from "../../workspaces/manager"
import { registerWorkspaceRoutes } from "./workspaces"

describe("workspace routes", () => {
  it("forwards a validated explicit binary path when creating a workspace", async () => {
    const calls: unknown[][] = []
    const app = Fastify({ logger: false })
    const descriptor: WorkspaceDescriptor = {
      id: "workspace",
      path: "C:/work",
      status: "ready",
      proxyPath: "/workspaces/workspace/instance",
      binaryId: "C:/tools/opencode.exe",
      binaryLabel: "opencode.exe",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }
    const workspaceManager = {
      create: async (...args: unknown[]) => {
        calls.push(args)
        return descriptor
      },
    } as unknown as WorkspaceManager
    registerWorkspaceRoutes(app, { workspaceManager })

    const response = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: {
        path: "C:/work",
        name: "Work",
        binaryPath: " C:/tools/opencode.exe ",
        requestId: " restore-request ",
      },
    })

    assert.equal(response.statusCode, 201)
    assert.deepEqual(calls, [["C:/work", "Work", "C:/tools/opencode.exe", "restore-request"]])

    const invalid = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: "C:/work", binaryPath: "x".repeat(4097) },
    })
    assert.equal(invalid.statusCode, 400)
    assert.equal(calls.length, 1)
    await app.close()
  })
})
