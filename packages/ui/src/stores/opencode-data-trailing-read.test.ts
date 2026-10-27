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

/** Arms one live assistant row whose projected text already holds its base. */
function armSession(instanceId: string, sessionId: string) {
  const base = { sessionID: sessionId, assistantMessageID: "live" }
  let data = applyOpenCodeDataEvent(instanceId, "/work", {
    id: "step", type: "session.step.started", created: 1,
    data: { ...base, agent: "build", model },
  } as any)
  data = applyOpenCodeDataEvent(instanceId, "/work", {
    id: "text", type: "session.text.started", created: 2, data: { ...base },
  } as any)
  data = applyOpenCodeDataEvent(instanceId, "/work", {
    id: "base", type: "session.text.delta", created: 3, data: { ...base, ordinal: 0, delta: "base" },
  } as any)
  return { data, base }
}

const projectedText = (data: ReturnType<typeof applyOpenCodeDataEvent>, sessionId: string, messageId: string) => {
  const row: any = data.session.message.get(sessionId, messageId)
  return String(row?.content?.find((part: any) => part.type === "text")?.text ?? "")
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
  it("answers a live read in one round trip with projected rows on top", async () => {
    const instanceId = "opencode-data-trailing-read"
    const sessionId = "session"
    const client = getRootClient(instanceId)
    const page = [{
      id: "live", type: "assistant", agent: "build", model,
      content: [{ type: "text", text: "base" }], time: { created: 500 },
    }]
    let reads = 0
    sseManager.seedStatus(instanceId, "connected")
    stubAuthoritativeSession(client, sessionId, async () => {
      reads += 1
      // One network round-trip; a streaming delta for the same message lands
      // inside the fetch window, however long the stream lasts.
      await new Promise<void>((resolve) => setImmediate(resolve))
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: `delta-${reads}`, type: "session.text.delta", created: 1000 + reads,
        data: { sessionID: sessionId, assistantMessageID: "live", ordinal: 0, delta: "X" },
      } as any)
      return { data: page, cursor: {} }
    })
    try {
      const { data } = armSession(instanceId, sessionId)
      data.session.message.invalidate(sessionId)
      await settleSync(data.session.message.sync(sessionId), () => reads)

      assert.equal(reads, 1, "streaming deltas must not restart the read")
      assert.ok(data.session.message.list(sessionId).some((message) => message.id === "live"))
      assert.equal(projectedText(data, sessionId, "live"), "baseX")
    } finally {
      cleanup(instanceId)
    }
  })

  it("never publishes a page that a destructive event invalidated", async () => {
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
      if (reads === 1) {
        // A revert lands inside the fetch window: the fetched page predates
        // it and still contains the reverted message, so the read restarts.
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: "revert", type: "session.revert.committed", created: 2000,
          data: { sessionID: sessionId, to: "reverted" },
        } as any)
        return { data: [reverted], cursor: {} }
      }
      return { data: [], cursor: {} }
    })
    try {
      const { data } = armSession(instanceId, sessionId)
      data.session.message.invalidate(sessionId)
      await settleSync(data.session.message.sync(sessionId), () => reads)

      assert.ok(reads >= 2, "the destructive event restarted the read")
      assert.ok(
        data.session.message.list(sessionId).every((message) => message.id !== "reverted"),
        "the invalidated page republished the reverted message",
      )
    } finally {
      cleanup(instanceId)
    }
  })

  it("keeps the fetched page's window and cursor and rides newer rows along", async () => {
    const instanceId = "opencode-data-trailing-window"
    const sessionId = "session"
    const client = getRootClient(instanceId)
    const history = {
      id: "old", type: "assistant", agent: "build", model,
      content: [], time: { created: 100, completed: 100 },
    }
    let reads = 0
    sseManager.seedStatus(instanceId, "connected")
    stubAuthoritativeSession(client, sessionId, async () => {
      reads += 1
      await new Promise<void>((resolve) => setImmediate(resolve))
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: `delta-${reads}`, type: "session.text.delta", created: 1000 + reads,
        data: { sessionID: sessionId, assistantMessageID: "live", ordinal: 0, delta: "X" },
      } as any)
      // A message the stream created during the fetch window: the page never
      // saw it, the projection holds it.
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: `fresh-${reads}`, type: "session.step.started", created: 2000 + reads,
        data: { sessionID: sessionId, assistantMessageID: "fresh", agent: "build", model },
      } as any)
      return { data: [{ id: "live", type: "assistant", agent: "build", model,
        content: [{ type: "text", text: "base" }], time: { created: 500 } }, history], cursor: { next: "cursor-page" } }
    })
    try {
      const { data } = armSession(instanceId, sessionId)
      data.session.message.invalidate(sessionId)
      await settleSync(data.session.message.sync(sessionId), () => reads)

      assert.equal(reads, 1)
      const ids = data.session.message.list(sessionId).map((message) => message.id)
      assert.deepEqual(ids, ["old", "live", "fresh"], `unexpected merged window ${JSON.stringify(ids)}`)
      assert.equal(projectedText(data, sessionId, "live"), "baseX")
      assert.equal(data.session.message.more(sessionId), true, "the fetched page's cursor was lost")
    } finally {
      cleanup(instanceId)
    }
  })

  it("keeps reducing streaming events while the read is in flight", async () => {
    const instanceId = "opencode-data-trailing-live"
    const sessionId = "session"
    const client = getRootClient(instanceId)
    let reads = 0
    const release = new Promise<void>(() => {})
    sseManager.seedStatus(instanceId, "connected")
    stubAuthoritativeSession(client, sessionId, async () => {
      reads += 1
      await release
      return { data: [], cursor: {} }
    })
    try {
      const { data } = armSession(instanceId, sessionId)
      data.session.message.invalidate(sessionId)
      const pending = data.session.message.sync(sessionId).catch(() => undefined)
      await new Promise<void>((resolve) => setImmediate(resolve))

      // Deltas keep reducing on the fast path while the read never returns.
      for (let index = 0; index < 5; index += 1) {
        const updated = applyOpenCodeDataEvent(instanceId, "/work", {
          id: `delta-${index}`, type: "session.text.delta", created: 100 + index,
          data: { sessionID: sessionId, assistantMessageID: "live", ordinal: 0, delta: `${index}` },
        } as any)
        projectOpenCodeMessages(instanceId, sessionId, updated)
      }
      const store = messageStoreBus.getOrCreate(instanceId)
      const record = store.getMessage("live")
      const texts = Object.values(record?.parts ?? {}).map((part: any) => String(part.data?.text ?? ""))
      assert.ok(texts.some((text) => text.includes("01234")), `streaming froze behind the read: ${JSON.stringify(texts)}`)
      void pending
    } finally {
      cleanup(instanceId)
    }
  })
})
