import assert from "node:assert/strict"
import { describe, it } from "node:test"
import Fastify from "fastify"

import type { WorkspaceDescriptor } from "../../api-types"
import type { WorkspaceManager } from "../../workspaces/manager"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { registerWorkspaceRoutes } from "./workspaces"

describe("workspace routes", () => {
  it("forwards workspace creation options without per-workspace binary settings", async () => {
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
    registerWorkspaceRoutes(app, { workspaceManager, worktreeDeletionFence: new WorktreeDeletionFence() })

    const response = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: {
        path: "C:/work",
        name: "Work",
        binaryPath: "C:/tools/ignored-opencode.exe",
        requestId: " restore-request ",
      },
    })

    assert.equal(response.statusCode, 201)
    assert.deepEqual(calls, [["C:/work", "Work", {
      requestId: "restore-request",
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
    assert.deepEqual(calls[calls.length - 1], ["cancel", "restore-request"])

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
    registerWorkspaceRoutes(app, { workspaceManager, worktreeDeletionFence: new WorktreeDeletionFence() })

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

  it("marks a non-owned creation response as reused", async () => {
    const app = Fastify({ logger: false })
    let finishCreation!: () => void
    const creation = new Promise<void>((resolve) => { finishCreation = resolve })
    const descriptor: WorkspaceDescriptor = {
      id: "shared-workspace",
      path: "C:/work",
      status: "ready",
      proxyPath: "/workspaces/shared-workspace/instance",
      binaryId: "C:/tools/opencode.exe",
      binaryLabel: "opencode.exe",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }
    let ownerRequestId: string | undefined
    const workspaceManager = {
      create: async (_path: string, _name: string | undefined, options: { requestId?: string }) => {
        const owner = ownerRequestId === undefined
        ownerRequestId ??= options.requestId
        await creation
        return {
          workspace: owner ? { ...descriptor, requestId: options.requestId } : descriptor,
          created: owner,
        }
      },
    } as unknown as WorkspaceManager
    registerWorkspaceRoutes(app, { workspaceManager, worktreeDeletionFence: new WorktreeDeletionFence() })

    const owner = app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: "C:/work", requestId: "owner-request" },
    })
    const reused = app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: "C:/work", requestId: "reuse-request" },
    })
    await new Promise((resolve) => setImmediate(resolve))
    finishCreation()

    const [ownerResponse, reusedResponse] = await Promise.all([owner, reused])
    assert.equal(ownerResponse.statusCode, 201)
    assert.deepEqual(ownerResponse.json(), { ...descriptor, requestId: "owner-request" })
    assert.equal(reusedResponse.statusCode, 201)
    assert.deepEqual(reusedResponse.json(), { ...descriptor, reused: true })
    await app.close()
  })
})
