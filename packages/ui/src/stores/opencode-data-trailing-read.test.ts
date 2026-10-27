import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { messageStoreBus } from "./message-v2/bus.ts"
import { applyOpenCodeDataEvent, destroyOpenCodeData } from "./opencode-data.ts"
import { getRootClient } from "./opencode-client.ts"
import { sdkManager } from "../lib/sdk-manager.ts"
import { sseManager } from "../lib/sse-manager.ts"

/** Settled means the read stream went quiet: no new fetch for a window that
 * covers several fetch round-trips, so a still-pending first fetch or a
 * spinning trailing-read loop cannot look settled. */
async function waitForQuietReads(reads: () => number, windowMs = 100, deadlineMs = 2_000): Promise<void> {
  const deadline = Date.now() + deadlineMs
  let lastReads = -1
  let stableSince = Date.now()
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    const current = reads()
    if (current !== lastReads) {
      lastReads = current
      stableSince = Date.now()
    }
    if (current > 0 && Date.now() - stableSince >= windowMs) return
  }
  assert.ok(false, `message.list reads never went quiet (last count ${lastReads})`)
}

function stubAuthoritativeSession(client: any, sessionId: string, messages: () => Promise<any>) {
  client.session.get = async () => ({
    id: sessionId, title: sessionId, projectID: "project", location: { directory: "/work" },
    time: { created: 1, updated: 1 }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  client.session.active = async () => ({})
  client.session.inbox = { list: async () => [] }
  client.permission.list = async () => []
  client.session.form.list = async () => []
  client.message.list = messages
}

describe("OpenCode data trailing read", () => {
  it("settles a live message sync while same-session events keep arriving", async () => {
    const instanceId = "opencode-data-trailing-read"
    const sessionId = "session"
    const client = getRootClient(instanceId)
    const fetched = {
      id: "fetched", type: "assistant", agent: "build", model: { providerID: "provider", id: "model" },
      content: [], time: { created: 900 },
    }
    let reads = 0
    sseManager.seedStatus(instanceId, "connected")
    stubAuthoritativeSession(client, sessionId, async () => {
      reads += 1
      // One network round-trip per read; a streaming event for the same
      // session lands inside every fetch window.
      await new Promise<void>((resolve) => setImmediate(resolve))
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: `delta-${reads}`, type: "session.text.delta", created: 1000 + reads,
        data: { sessionID: sessionId, assistantMessageID: "live", ordinal: 0, delta: "." },
      } as any)
      return { data: [fetched], cursor: {} }
    })
    try {
      const base = { sessionID: sessionId, assistantMessageID: "live" }
      let data = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "step", type: "session.step.started", created: 1,
        data: { ...base, agent: "build", model: { providerID: "provider", id: "model" } },
      } as any)
      data = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "tool", type: "session.tool.input.started", created: 2,
        data: { ...base, id: "tool", name: "bash" },
      } as any)
      // The SDK reacts to the execution boundary by refreshing the message
      // cache of the live entry while the session keeps streaming.
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: "done", type: "session.execution.succeeded", created: 3,
        data: { sessionID: sessionId },
      } as any)

      await waitForQuietReads(() => reads)
      assert.ok(reads <= 25, `message.list was issued ${reads} times under streaming`)
      assert.ok(
        data.session.message.list(sessionId).some((message) => message.id === "live"),
        "live projection row was dropped by the sync",
      )
    } finally {
      destroyOpenCodeData(instanceId)
      if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })
})
