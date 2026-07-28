import assert from "node:assert/strict"
import { describe, it } from "node:test"
import Fastify from "fastify"

import type { WorkspaceDescriptor } from "../../api-types"
import { WorkspaceDeletionBlockedError, type WorkspaceManager } from "../../workspaces/manager"
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
        return { workspace: descriptor, created: true }
      },
      releaseCreationRequest: (workspaceId: string, requestId: string) =>
        workspaceId === descriptor.id && requestId === "restore-request",
      cancelCreationRequest: async (requestId: string) => {
        calls.push(["cancel", requestId])
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
        lineageId: "00000000-0000-4000-8000-000000000001",
        requestId: " restore-request ",
        forceNew: true,
      },
    })

    assert.equal(response.statusCode, 201)
    assert.deepEqual(calls, [["C:/work", "Work", {
      binaryPath: "C:/tools/opencode.exe",
      lineageId: "00000000-0000-4000-8000-000000000001",
      requestId: "restore-request",
      forceNew: true,
    }]])

    const released = await app.inject({
      method: "POST",
      url: "/api/workspaces/workspace/creation/release",
      payload: { requestId: "restore-request" },
    })
    assert.equal(released.statusCode, 204)

    const wrongRelease = await app.inject({
      method: "POST",
      url: "/api/workspaces/workspace/creation/release",
      payload: { requestId: "other-request" },
    })
    assert.equal(wrongRelease.statusCode, 404)

    const cancelled = await app.inject({
      method: "POST",
      url: "/api/workspaces/creation/cancel",
      payload: { requestId: "restore-request" },
    })
    assert.equal(cancelled.statusCode, 204)
    assert.deepEqual(calls.at(-1), ["cancel", "restore-request"])

    const invalid = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: "C:/work", binaryPath: "x".repeat(4097) },
    })
    assert.equal(invalid.statusCode, 400)
    assert.equal(calls.length, 2)
    await app.close()
  })

  it("rejects release after cancellation wins while deletion is still pending", async () => {
    const app = Fastify({ logger: false })
    let state: "active" | "cancelled" | "released" = "active"
    let cancellationStarted!: () => void
    let finishDeletion!: () => void
    const started = new Promise<void>((resolve) => { cancellationStarted = resolve })
    const deletion = new Promise<void>((resolve) => { finishDeletion = resolve })
    const workspaceManager = {
      cancelCreationRequest: async () => {
        state = "cancelled"
        cancellationStarted()
        await deletion
      },
      releaseCreationRequest: () => {
        if (state === "cancelled") return false
        state = "released"
        return true
      },
    } as unknown as WorkspaceManager
    registerWorkspaceRoutes(app, { workspaceManager })

    const cancellation = app.inject({
      method: "POST",
      url: "/api/workspaces/creation/cancel",
      payload: { requestId: "restore-request" },
    })
    await started
    const release = await app.inject({
      method: "POST",
      url: "/api/workspaces/workspace/creation/release",
      payload: { requestId: "restore-request" },
    })

    assert.equal(release.statusCode, 404)
    assert.equal(release.body, "Workspace creation request not found")
    finishDeletion()
    assert.equal((await cancellation).statusCode, 204)
    await app.close()
  })

  it("reports workflow-owned deletion and restore cancellation as conflicts", async () => {
    let deleted = false
    const app = Fastify({ logger: false })
    const workspaceManager = {
      get: () => ({ id: "workspace", lineageId: "lineage", path: "C:/worktree" }),
      delete: async () => {
        deleted = true
        throw new WorkspaceDeletionBlockedError("workspace")
      },
      cancelCreationRequest: async () => { throw new WorkspaceDeletionBlockedError("workspace") },
    } as unknown as WorkspaceManager
    registerWorkspaceRoutes(app, { workspaceManager })

    const response = await app.inject({ method: "DELETE", url: "/api/workspaces/workspace" })
    const cancellation = await app.inject({
      method: "POST",
      url: "/api/workspaces/creation/cancel",
      payload: { requestId: "restore-request" },
    })

    assert.equal(response.statusCode, 409)
    assert.equal(cancellation.statusCode, 409)
    assert.equal(deleted, true)
    await app.close()
  })
})
