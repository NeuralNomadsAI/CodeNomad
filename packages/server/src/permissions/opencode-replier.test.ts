import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { OpenCodeClient } from "@opencode-ai/client"

import type { WorkspaceManager } from "../workspaces/manager"
import { createOpencodePermissionReplier } from "./opencode-replier"

describe("createOpencodePermissionReplier", () => {
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
    const replier = createOpencodePermissionReplier({ workspaceManager })

    await assert.rejects(replier({
      instanceId: "instance",
      sessionId: "foreign-session",
      permissionId: "permission",
    }), /does not belong/)
    assert.deepEqual(calls, [])
  })
})
