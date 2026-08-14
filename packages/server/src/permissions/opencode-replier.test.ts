import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { OpenCodeClient } from "@opencode-ai/client"

import type { Logger } from "../logger"
import type { WorkspaceManager } from "../workspaces/manager"
import { createOpencodePermissionReplier } from "./opencode-replier"

describe("createOpencodePermissionReplier", () => {
  it("uses the native permission reply input", async () => {
    const calls: Array<Record<string, unknown>> = []
    const client = {
      session: {
        get: async () => ({ location: { directory: "/repo" } }),
      },
      permission: { reply: async (input: Record<string, unknown>) => { calls.push(input) } },
    } as unknown as OpenCodeClient
    const workspaceManager = {
      get: () => ({ path: "/repo" }),
      getSharedServiceClient: async () => client,
      ownsDirectory: async (_instanceId: string, directory: string) => directory === "/repo",
    } as unknown as WorkspaceManager
    const replier = createOpencodePermissionReplier({ workspaceManager, logger: {} as Logger })

    await replier({
      instanceId: "instance",
      sessionId: "session",
      permissionId: "permission",
      source: "v2",
      reply: "once",
    })

    assert.deepEqual(calls, [{ sessionID: "session", requestID: "permission", reply: "once" }])
  })

  it("does not reply across logical workspace ownership", async () => {
    const calls: Array<Record<string, unknown>> = []
    const client = {
      session: { get: async () => ({ location: { directory: "/other" } }) },
      permission: { reply: async (input: Record<string, unknown>) => { calls.push(input) } },
    } as unknown as OpenCodeClient
    const workspaceManager = {
      get: () => ({ path: "/repo" }),
      getSharedServiceClient: async () => client,
      ownsDirectory: async () => false,
    } as unknown as WorkspaceManager
    const replier = createOpencodePermissionReplier({ workspaceManager, logger: {} as Logger })

    await assert.rejects(replier({
      instanceId: "instance",
      sessionId: "foreign-session",
      permissionId: "permission",
      source: "v2",
      reply: "once",
    }), /does not belong/)
    assert.deepEqual(calls, [])
  })
})
