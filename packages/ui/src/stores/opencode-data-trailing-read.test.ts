import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { messageStoreBus } from "./message-v2/bus.ts"
import { applyOpenCodeDataEvent, destroyOpenCodeData, projectOpenCodeMessages } from "./opencode-data.ts"
import { getRootClient } from "./opencode-client.ts"
import { sdkManager } from "../lib/sdk-manager.ts"
import { sseManager } from "../lib/sse-manager.ts"

const model = { providerID: "provider", id: "model" }

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

function armSession(instanceId: string, sessionId: string) {
  const base = { sessionID: sessionId, assistantMessageID: "live" }
  let data = applyOpenCodeDataEvent(instanceId, "/work", {
    id: "step", type: "session.step.started", created: 1,
    data: { ...base, agent: "build", model },
  } as any)
  data = applyOpenCodeDataEvent(instanceId, "/work", {
    id: "tool", type: "session.tool.input.started", created: 2,
    data: { ...base, id: "tool", name: "bash" },
  } as any)
  return { data, base }
}

async function settleSync(sync: Promise<unknown>, reads: () => number): Promise<void> {
  await Promise.race([
    sync,
    new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error(`message.list sync did not settle (${reads()} reads)`)), 2000)
    }),
  ])
}

function cleanup(instanceId: string) {
  destroyOpenCodeData(instanceId)
  if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
  sdkManager.destroyClientsForInstance(instanceId)
}

describe("OpenCode data trailing read", () => {
  it("settles a live message sync while same-session events keep arriving", async () => {
    const instanceId = "opencode-data-trailing-read"
    const sessionId = "session"
    const client = getRootClient(instanceId)
    const fetched = {
      id: "fetched", type: "assistant", agent: "build", model,
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
      const { data } = armSession(instanceId, sessionId)
      data.session.message.invalidate(sessionId)
      await settleSync(data.session.message.sync(sessionId), () => reads)

      assert.ok(reads <= 25, `message.list was issued ${reads} times under streaming`)
      assert.ok(
        data.session.message.list(sessionId).some((message) => message.id === "live"),
        "live projection row was dropped by the sync",
      )
    } finally {
      cleanup(instanceId)
    }
  })

  it("never publishes a page that a newer event invalidated", async () => {
    const instanceId = "opencode-data-trailing-revert"
    const sessionId = "session"
    const client = getRootClient(instanceId)
    const reverted = {
      id: "reverted", type: "assistant", agent: "build", model,
      content: [], time: { created: 100, completed: 100 },
    }
    let reads = 0
    sseManager.seedStatus(instanceId, "connected")
    stubAuthoritativeSession(client, sessionId, async () => {
      reads += 1
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (reads <= 2) {
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: `delta-${reads}`, type: "session.text.delta", created: 1000 + reads,
          data: { sessionID: sessionId, assistantMessageID: "live", ordinal: 0, delta: "." },
        } as any)
      } else if (reads === 3) {
        // A revert lands inside the last fetch window: the fetched page
        // predates it and still contains the reverted message.
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: "revert", type: "session.revert.committed", created: 2000,
          data: { sessionID: sessionId, to: "reverted" },
        } as any)
      }
      return { data: reads <= 3 ? [reverted] : [], cursor: {} }
    })
    try {
      // Execution activity only: the live projection stays empty, so the
      // contended read cannot lean on resident rows.
      const data = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "exec", type: "session.execution.started", created: 1,
        data: { sessionID: sessionId },
      } as any)
      data.session.message.invalidate(sessionId)
      await settleSync(data.session.message.sync(sessionId), () => reads)

      assert.ok(
        data.session.message.list(sessionId).every((message) => message.id !== "reverted"),
        "the invalidated page republished the reverted message",
      )
    } finally {
      cleanup(instanceId)
    }
  })

  it("re-reads authority once the stream quiets after a provisional read", async () => {
    const instanceId = "opencode-data-trailing-recovery"
    const sessionId = "session"
    const client = getRootClient(instanceId)
    const history = {
      id: "old", type: "assistant", agent: "build", model,
      content: [], time: { created: 100, completed: 100 },
    }
    const live = {
      id: "live", type: "assistant", agent: "build", model,
      content: [], time: { created: 500 },
    }
    let reads = 0
    sseManager.seedStatus(instanceId, "connected")
    stubAuthoritativeSession(client, sessionId, async () => {
      reads += 1
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (reads <= 3) {
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: `delta-${reads}`, type: "session.text.delta", created: 1000 + reads,
          data: { sessionID: sessionId, assistantMessageID: "live", ordinal: 0, delta: "." },
        } as any)
        return { data: [live], cursor: { next: "cursor-streaming" } }
      }
      return { data: [history, live], cursor: { next: "cursor-authoritative" } }
    })
    try {
      const { data } = armSession(instanceId, sessionId)
      data.session.message.invalidate(sessionId)
      await settleSync(data.session.message.sync(sessionId), () => reads)
      const provisionalReads = reads

      // The quiet re-read reconciles history and restores the cursor.
      const deadline = Date.now() + 1000
      while (Date.now() < deadline && reads === provisionalReads) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
      }
      const current = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "quiet-delta", type: "session.text.delta", created: 5000,
        data: { sessionID: sessionId, assistantMessageID: "live", ordinal: 0, delta: "." },
      } as any)
      const ids = current.session.message.list(sessionId).map((message) => message.id)
      assert.ok(ids.includes("old"), `history was not reconciled after quiet (${JSON.stringify(ids)})`)
      assert.ok(ids.includes("live"), "live row was lost by the recovery read")
      assert.equal(current.session.message.more(sessionId), true, "pagination cursor was not restored")
      assert.ok(reads <= 25, `message.list was issued ${reads} times in total`)
    } finally {
      cleanup(instanceId)
    }
  })
})
