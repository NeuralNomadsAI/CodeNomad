import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  armLive, assistantRow, delta, emitEvent, readFixture, readTestingSessionId as sessionId, textOf,
} from "./opencode-data-read-testing.ts"

/** Quiet means no new fetch for a window covering many fetch round trips, so
 * a pending first fetch or a restarting read loop cannot look settled. */
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
  assert.fail(`message.list reads never went quiet (last count ${lastReads})`)
}

describe("OpenCode data trailing read", () => {
  it("settles a live message sync in one read while same-session deltas keep arriving", async () => {
    const instanceId = "opencode-data-trailing-read"
    let reads = 0
    const f = readFixture(instanceId, async () => {
      reads += 1
      // One network round trip per read; a streaming delta for the same
      // session lands inside every fetch window.
      await new Promise<void>((resolve) => setImmediate(resolve))
      delta(instanceId, ".")
      return {
        data: [{ ...assistantRow("live", "base", 100), content: [{ type: "text", text: "base" }, {
          type: "tool", id: "tool", name: "bash", time: { created: 2 }, state: { status: "streaming", input: "" },
        }] }, assistantRow("fetched", "history", 90)],
        cursor: { next: "older" },
      }
    })
    try {
      const data = armLive(instanceId)
      emitEvent(instanceId, "session.tool.input.started", { assistantMessageID: "live", id: "tool", name: "bash" })
      // The execution boundary makes the SDK refresh the reducer's messages,
      // since a tool is still streaming, while the session keeps streaming.
      emitEvent(instanceId, "session.execution.succeeded")

      await waitForQuietReads(() => reads)
      assert.equal(reads, 1, "streaming deltas restarted the read")
      assert.deepEqual(data.session.message.list(sessionId).map((message) => message.id), ["fetched", "live"])
      assert.equal(textOf(data, "live"), "base.", "the page rewound the streamed text")
      assert.equal(data.session.message.more(sessionId), true, "the page's cursor was lost")

      delta(instanceId, "!")
      assert.equal(textOf(data, "live"), "base.!", "streaming stopped reaching the reducer")
      assert.equal(reads, 1)
    } finally {
      f.cleanup()
    }
  })
})
