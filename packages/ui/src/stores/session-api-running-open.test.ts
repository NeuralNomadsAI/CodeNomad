import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import { serverApi } from "../lib/api-client.ts"
import type { Session } from "../types/session.ts"
import { addInstance, handleInstanceInvalidation, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { loadMessages } from "./session-api.ts"
import { applyOpenCodeDataEvent, destroyOpenCodeData } from "./opencode-data.ts"
import { getSessionMessagesLoadError, messagesLoaded, setActiveSession, setSessions } from "./session-state.ts"

const sessionId = "session"
const model = { providerID: "provider", id: "model" }

function session(instanceId: string): Session {
  return {
    id: sessionId, instanceId, parentId: null, title: sessionId, agent: "build", model: { providerId: "provider", modelId: "model" },
    status: "working", retry: null, idleSince: null, generationRecovery: null, runtimeStatusKnown: true,
    version: "1", projectID: "project", location: { directory: "/work" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
  }
}

const streaming = (id: string, text = "BASE") => ({
  id, type: "assistant", agent: "build", model, time: { created: 1 }, content: [{ type: "text", text }],
})

const displayedText = (instanceId: string, messageId: string) => Object.values(messageStoreBus.getOrCreate(instanceId)
  .getMessage(messageId)?.parts ?? {}).map((part: any) => String(part.data?.text ?? "")).join("")

async function until(check: () => boolean, description: string) {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise<void>((resolve) => setImmediate(resolve))
  assert.ok(check(), description)
}

const cases = [
  { name: "the reducer already holds the streaming message", arm: true, created: false },
  { name: "the reducer missed the streaming message's start", arm: false, created: false },
  { name: "a new step starts during the fetch", arm: false, created: true },
]

describe("session-api running-session open", () => {
  for (const { name, arm, created } of cases) {
    it(`loads the latest window of a streaming session (${name})`, async () => {
      const instanceId = `session-api-running-open-${arm ? "warm" : created ? "created" : "cold"}`
      const originalFetchWorktrees = serverApi.fetchWorktrees
      serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [{ slug: "root", directory: "/work", kind: "root" }] }) as any
      const client: any = { session: { active: async () => ({}) } }
      ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
      addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
      setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId)]])))
      setActiveSession(instanceId, sessionId)
      let sequence = 0
      const native = (type: string, payload: Record<string, unknown>) => handleInstanceInvalidation(instanceId, {
        id: `evt_${++sequence}`, type, created: sequence, data: { sessionID: sessionId, ...payload }, location: { directory: "/work" },
      } as any)
      const reads: number[] = []
      let answered = 0
      client.message = {
        list: async (input: { limit?: number }) => {
          reads.push(input.limit ?? 0)
          await new Promise<void>((resolve) => setImmediate(resolve))
          // The session keeps streaming during every fetch window.
          native("session.text.delta", { assistantMessageID: "msg_1", ordinal: 0, delta: "X" })
          if (created && reads.length === 1) native("session.step.started", { assistantMessageID: "msg_2", agent: "build", model, started: 2 })
          answered += 1
          return { data: [streaming("msg_1")], cursor: {} }
        },
      }
      if (arm) {
        applyOpenCodeDataEvent(instanceId, "/work", { id: "arm-step", type: "session.step.started", created: 1,
          data: { sessionID: sessionId, assistantMessageID: "msg_1", agent: "build", model, started: 1 } } as any)
        applyOpenCodeDataEvent(instanceId, "/work", { id: "arm-text", type: "session.text.started", created: 1,
          data: { sessionID: sessionId, assistantMessageID: "msg_1" } } as any)
        applyOpenCodeDataEvent(instanceId, "/work", { id: "arm-base", type: "session.text.delta", created: 1,
          data: { sessionID: sessionId, assistantMessageID: "msg_1", ordinal: 0, delta: "BASE" } } as any)
      }
      try {
        await loadMessages(instanceId, sessionId)

        assert.ok(!getSessionMessagesLoadError(instanceId, sessionId), "a streaming session failed to load")
        assert.ok(messagesLoaded().get(instanceId)?.has(sessionId))
        assert.equal(reads[0], 200)
        assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), created ? ["msg_1", "msg_2"] : ["msg_1"])
        assert.equal(displayedText(instanceId, "msg_1"), arm ? "BASEX" : "BASE", "the load rewound or lost streamed text")

        // A reducer without rows syncs the SDK's own latest page, so later
        // deltas for the streaming message reach the display.
        if (!arm && !created) await until(() => answered === 2, "the empty reducer was never synced")
        await new Promise<void>((resolve) => setImmediate(resolve))
        assert.deepEqual(reads, !arm && !created ? [200, 20] : [200])
        if (created) return
        native("session.text.delta", { assistantMessageID: "msg_1", ordinal: 0, delta: "Y" })
        assert.equal(displayedText(instanceId, "msg_1"), arm ? "BASEXY" : "BASEY", "streaming froze after the load")
      } finally {
        serverApi.fetchWorktrees = originalFetchWorktrees
        destroyOpenCodeData(instanceId)
        messageStoreBus.unregisterInstance(instanceId)
        setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
        removeInstance(instanceId, { authoritative: false })
        sdkManager.destroyClientsForInstance(instanceId)
      }
    })
  }
})
