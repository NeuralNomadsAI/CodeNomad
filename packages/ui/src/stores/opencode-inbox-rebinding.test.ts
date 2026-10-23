import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createMemo, createRoot } from "solid-js"
import { applyOpenCodeDataEvent, destroyOpenCodeData, getOpenCodeSessionInbox, invalidateOpenCodeSessionContent } from "./opencode-data.ts"
import { getRootClient } from "./opencode-client.ts"
import { sdkManager } from "../lib/sdk-manager.ts"

async function waitFor(done: () => boolean, message: string): Promise<void> {
  for (let turn = 0; turn < 500 && !done(); turn++) await new Promise<void>((resolve) => setTimeout(resolve, 0))
  assert.ok(done(), message)
}

/** Replaces the session's reducer the way a pruning event or an overflowing event queue does. */
const triggers = {
  prune: (instanceId: string, sessionId: string) => invalidateOpenCodeSessionContent(instanceId, sessionId),
  overflow: (instanceId: string, sessionId: string) => {
    const step = (id: string, created: number) => applyOpenCodeDataEvent(instanceId, "/work", {
      id, type: "session.step.started", created,
      data: { sessionID: sessionId, assistantMessageID: id, agent: "build", model: { providerID: "provider", id: "model" } },
    } as any)
    for (let index = 0; index < 199; index++) step(`seed-${index}`, 10 + index)
    for (let index = 0; index < 4096; index++) step(`overflow-${index}`, 500 + index)
  },
}

describe("OpenCode session inbox", () => {
  for (const [name, replace] of Object.entries(triggers)) {
    it(`drops a delivered follow-up after a ${name} replaces the session reducer, before the turn ends`, async () => {
      const instanceId = `opencode-inbox-rebinding-${name}`
      const sessionId = "session"
      const client = getRootClient(instanceId) as any
      // The native inbox: what an authoritative resync lists.
      const native: any[] = []
      client.session.get = async () => ({
        id: sessionId, title: sessionId, projectID: "project", location: { directory: "/work" },
        time: { created: 1, updated: 1 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      client.session.active = async () => ({ [sessionId]: {} })
      client.session.inbox = { list: async () => native.map((item) => ({ ...item })) }
      client.permission.list = async () => []
      client.session.form.list = async () => []
      client.message.list = async () => ({ data: [], cursor: {} })
      const queue = (id: string, created: number) => {
        native.push({ id, sessionID: sessionId, type: "user", payload: { text: id }, delivery: "queue", time: { created } })
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: `enqueued-${id}`, type: "session.inbox.enqueued", created,
          data: { sessionID: sessionId, inboxID: id, item: { type: "user", payload: { text: id }, delivery: "queue" } },
        } as any)
      }
      const deliver = (id: string, created: number) => {
        native.splice(native.findIndex((item) => item.id === id), 1)
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: `delivered-${id}`, type: "session.inbox.delivered", created, data: { sessionID: sessionId, inboxID: id },
        } as any)
      }
      // The session view's queued badges read this memo.
      let queued!: () => string[]
      const dispose = createRoot((dispose) => {
        queued = createMemo(() => getOpenCodeSessionInbox(instanceId, sessionId, "/work").map((item) => item.id))
        return dispose
      })
      try {
        queue("first", 1)
        queue("second", 2)
        assert.deepEqual(queued(), ["first", "second"])

        replace(instanceId, sessionId)
        await waitFor(() => queued().length === 2, "the resynced reducer still lists both follow-ups")
        await new Promise<void>((resolve) => setTimeout(resolve, 50))
        assert.deepEqual(queued(), ["first", "second"])

        deliver("first", 5000)
        assert.deepEqual(queued(), ["second"], "only the follow-up still waiting keeps its badge")
        deliver("second", 5001)
        assert.deepEqual(queued(), [])
      } finally {
        dispose()
        destroyOpenCodeData(instanceId)
        sdkManager.destroyClientsForInstance(instanceId)
      }
    })
  }
})
