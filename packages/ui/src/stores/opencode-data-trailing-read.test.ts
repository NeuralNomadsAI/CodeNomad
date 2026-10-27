import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { messageStoreBus } from "./message-v2/bus.ts"
import { applyOpenCodeDataEvent, projectOpenCodeMessages } from "./opencode-data.ts"
import { armLive, assistantRow, deltaDuring, readFixture, readTestingModel as model, readTestingSessionId as sessionId, settleSync, textOf } from "./opencode-data-read-testing.ts"

const history = {
  id: "old", type: "assistant", agent: "build", model,
  content: [], time: { created: 100, completed: 100 },
}

describe("OpenCode data trailing read", () => {
  it("answers a live read in one round trip, keeping the page's window and cursor", async () => {
    const instanceId = "opencode-data-trailing-read"
    let reads = 0
    const f = readFixture(instanceId, async () => {
      reads += 1
      await new Promise<void>((resolve) => setImmediate(resolve))
      // A delta and a new row land inside every fetch window, however long
      // the stream lasts.
      deltaDuring(instanceId, reads)
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: `fresh-${reads}`, type: "session.step.started", created: 2000 + reads,
        data: { sessionID: sessionId, assistantMessageID: "fresh", agent: "build", model },
      } as any)
      return {
        data: [assistantRow("live", "base", 500), history],
        cursor: { next: "cursor-page" },
      }
    })
    try {
      const data = armLive(instanceId)
      data.session.message.invalidate(sessionId)
      await settleSync(data.session.message.sync(sessionId), () => reads)

      assert.equal(reads, 1, "streaming events must not restart the read")
      const ids = data.session.message.list(sessionId).map((message) => message.id)
      assert.deepEqual(ids, ["old", "live", "fresh"], `unexpected merged window ${JSON.stringify(ids)}`)
      assert.equal(textOf(data, "live"), "baseX", "the touched row lost its live version")
      assert.equal(data.session.message.more(sessionId), true, "the fetched page's cursor was lost")
    } finally {
      f.cleanup()
    }
  })

  it("never publishes a page that a destructive event invalidated", async () => {
    const instanceId = "opencode-data-trailing-revert"
    let reads = 0
    const f = readFixture(instanceId, async () => {
      reads += 1
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (reads === 1) {
        // A revert lands inside the fetch window: the fetched page predates
        // it and still contains the reverted message, so the read restarts.
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: "revert", type: "session.revert.committed", created: 2000,
          data: { sessionID: sessionId, to: "reverted" },
        } as any)
        return { data: [assistantRow("reverted", "gone", 50)], cursor: {} }
      }
      return { data: [], cursor: {} }
    })
    try {
      const data = armLive(instanceId)
      data.session.message.invalidate(sessionId)
      await settleSync(data.session.message.sync(sessionId), () => reads)

      assert.ok(reads >= 2, "the destructive event restarted the read")
      assert.ok(
        data.session.message.list(sessionId).every((message) => message.id !== "reverted"),
        "the invalidated page republished the reverted message",
      )
    } finally {
      f.cleanup()
    }
  })

  it("keeps reducing streaming events while the read is in flight", async () => {
    const instanceId = "opencode-data-trailing-live"
    let reads = 0
    const release = new Promise<void>(() => {})
    const f = readFixture(instanceId, async () => {
      reads += 1
      await release
      return { data: [], cursor: {} }
    })
    try {
      const data = armLive(instanceId)
      data.session.message.invalidate(sessionId)
      const pending = data.session.message.sync(sessionId).catch(() => undefined)
      await new Promise<void>((resolve) => setImmediate(resolve))

      // Deltas keep reducing on the fast path while the read never returns.
      for (let index = 0; index < 5; index += 1) {
        const updated = deltaDuring(instanceId, index, String(index))
        projectOpenCodeMessages(instanceId, sessionId, updated)
      }
      const store = messageStoreBus.getOrCreate(instanceId)
      const record = store.getMessage("live")
      const texts = Object.values(record?.parts ?? {}).map((part: any) => String(part.data?.text ?? ""))
      assert.ok(texts.some((text) => text.includes("01234")), `streaming froze behind the read: ${JSON.stringify(texts)}`)
      void pending
    } finally {
      f.cleanup()
    }
  })
})
