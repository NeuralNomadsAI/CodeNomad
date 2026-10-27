import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import { serverApi } from "../lib/api-client.ts"
import type { Session } from "../types/session.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { loadMessages } from "./session-api.ts"
import { applyOpenCodeDataEvent, destroyOpenCodeData, projectOpenCodeMessages } from "./opencode-data.ts"
import { getSessionMessagesLoadError, messagesLoaded, setSessions } from "./session-state.ts"

function session(instanceId: string, id: string): Session {
  return {
    id, instanceId, parentId: null, title: id, agent: "build", model: { providerId: "provider", modelId: "model" },
    status: "working", retry: null, idleSince: null, generationRecovery: null, runtimeStatusKnown: true,
    version: "1", projectID: "project", location: { directory: "/work" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
  }
}

function apiMessage(id: string) {
  return {
    id, type: "assistant", agent: "build", model: { providerID: "provider", id: "model" },
    time: { created: 1 }, content: [{ type: "text", text: "base" }],
  }
}

describe("session-api running-session open", () => {
  it("seeds an initial transcript page while the session keeps streaming", async () => {
    const instanceId = "session-api-running-open"
    const sessionId = "session"
    const originalFetchWorktrees = serverApi.fetchWorktrees
    serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [
      { slug: "root", directory: "/work", kind: "root" },
    ] })
    const client: any = { session: { active: async () => ({}) } }
    ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
    addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
    let reads = 0
    client.message = {
      list: async () => {
        reads += 1
        await new Promise<void>((resolve) => setImmediate(resolve))
        // A streaming event lands inside every fetch window: the session is
        // mid-generation and its start event was never admitted (UI restart).
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: `delta-${reads}`, type: "session.text.delta", created: 1000 + reads,
          data: { sessionID: sessionId, assistantMessageID: "msg_1", ordinal: 0, delta: "." },
        } as any)
        return { data: [apiMessage("msg_1")], cursor: {} }
      },
    }
    try {
      await loadMessages(instanceId, sessionId)

      assert.ok(!getSessionMessagesLoadError(instanceId, sessionId), "a load error was set for a running session")
      assert.ok(messagesLoaded().get(instanceId)?.has(sessionId))
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["msg_1"])
      assert.ok(reads <= 5, `message.list was issued ${reads} times for the initial open`)

      // The reducer projection holds the same base, so streaming keeps
      // updating the loaded message instead of freezing at its snapshot.
      const data = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "tail", type: "session.text.delta", created: 5000,
        data: { sessionID: sessionId, assistantMessageID: "msg_1", ordinal: 0, delta: "tail" },
      } as any)
      assert.ok(data.session.message.get(sessionId, "msg_1"), "the projection never held the loaded page")
      projectOpenCodeMessages(instanceId, sessionId, data)
      const record = messageStoreBus.getOrCreate(instanceId).getMessage("msg_1")
      const texts = Object.values(record?.parts ?? {}).map((part: any) => String(part.data?.text ?? ""))
      assert.ok(texts.some((text) => text.includes("basetail")), `streaming froze after the initial seed: ${JSON.stringify(texts)}`)
    } finally {
      serverApi.fetchWorktrees = originalFetchWorktrees
      destroyOpenCodeData(instanceId)
      messageStoreBus.unregisterInstance(instanceId)
      setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })
})
