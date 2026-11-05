import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { OpenCodeClient } from "@opencode/client"

import type { WorkspaceManager } from "../workspaces/manager"
import { createOpencodePermissionReplier } from "./opencode-replier"
import { WorkspaceCapabilityError } from "../opencode/servers/capabilities"
import type { PermissionReceipts } from "./receipts"

describe("createOpencodePermissionReplier", () => {
  it("does not reply across logical workspace ownership", async () => {
    const calls: Array<Record<string, unknown>> = []
    const client = {
      session: { get: async () => ({ location: { directory: "/other" } }) },
      permission: { reply: async (input: Record<string, unknown>) => { calls.push(input) } },
    } as unknown as OpenCodeClient
    const workspaceManager = {
      requireWorkspaceCapability: () => new AbortController().signal,
      get: () => ({ path: "/repo" }),
      getSharedServiceConnection: async () => ({ client }),
      ownsLocation: async () => false,
    } as unknown as WorkspaceManager
    const replier = createOpencodePermissionReplier({ workspaceManager })

    await assert.rejects(replier({
      instanceId: "instance",
      sessionId: "foreign-session",
      permissionId: "permission",
    }), /does not belong/)
    assert.deepEqual(calls, [])
  })

  it("refuses explicit A/B before either client acquisition path while local identical IDs still reply", async () => {
    const effects: string[] = []
    const client = {
      session: { get: async () => { effects.push("get"); return { location: { directory: "/same" } } } },
      permission: { reply: async () => { effects.push("reply") } },
    } as unknown as OpenCodeClient
    const workspaceManager = {
      requireWorkspaceCapability(id: string, capability: string) {
        assert.equal(capability, "yolo")
        if (id !== "local") throw new WorkspaceCapabilityError("yolo", { code: "deferred" })
        return new AbortController().signal
      },
      getSharedServiceConnection: async () => {
        effects.push("acquire")
        return { client, assertCurrent() {} }
      },
      ownsLocation: async () => true,
    } as unknown as WorkspaceManager
    const permissionReceipts = { prepare: async () => { effects.push("prepare") } } as unknown as PermissionReceipts
    for (const receipts of [undefined, permissionReceipts]) {
      const replier = createOpencodePermissionReplier({ workspaceManager, permissionReceipts: receipts })
      for (const instanceId of ["A", "B"]) {
        await assert.rejects(replier({ instanceId, sessionId: "same", permissionId: "same" }), WorkspaceCapabilityError)
      }
      assert.deepEqual(effects, [])
      await replier({ instanceId: "local", sessionId: "same", permissionId: "same" })
      assert.equal(effects.filter(effect => effect === "reply").length, 1)
      effects.length = 0
    }
  })

  it("rechecks admission before dispatch without classifying a refusal as a dispatched failure", async () => {
    let admitted = true
    let replies = 0
    const client = {
      session: { get: async () => ({ location: { directory: "/same" } }) },
      permission: { reply: async () => { replies++ } },
    } as unknown as OpenCodeClient
    const workspaceManager = {
      requireWorkspaceCapability() {
        if (!admitted) throw new WorkspaceCapabilityError("yolo", { code: "deferred" })
        return new AbortController().signal
      },
      getSharedServiceConnection: async () => ({ client }),
      ownsLocation: async () => { admitted = false; return true },
    } as unknown as WorkspaceManager
    const replier = createOpencodePermissionReplier({ workspaceManager })
    await assert.rejects(replier({ instanceId: "local", sessionId: "same", permissionId: "same" }),
      (error: unknown) => error instanceof WorkspaceCapabilityError && !("retryable" in error))
    assert.equal(replies, 0)
  })

  it("keeps a lost dispatched reply non-retryable", async () => {
    const client = {
      session: { get: async () => ({ location: { directory: "/same" } }) },
      permission: { reply: async () => { throw new Error("lost response") } },
    } as unknown as OpenCodeClient
    const workspaceManager = {
      requireWorkspaceCapability: () => new AbortController().signal,
      getSharedServiceConnection: async () => ({ client }),
      ownsLocation: async () => true,
    } as unknown as WorkspaceManager
    const replier = createOpencodePermissionReplier({ workspaceManager })
    await assert.rejects(replier({ instanceId: "local", sessionId: "same", permissionId: "same" }), { retryable: false })
  })
})
