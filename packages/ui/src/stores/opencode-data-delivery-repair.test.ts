import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  armLive, assistantRow, emitEvent, readFixture, readTestingModel, readTestingSessionId as sessionId, textOf,
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

const fullText = "H".repeat(800) + "TAIL".repeat(50)
const midStreamText = fullText.slice(0, 800)

describe("OpenCode data delivery repair read", () => {
  it("keeps a completed reply's ended text when the repair read's page still holds its mid-stream prefix", async () => {
    const instanceId = "opencode-data-delivery-repair"
    let reads = 0
    const f = readFixture(instanceId, async () => {
      reads += 1
      await new Promise<void>((resolve) => setImmediate(resolve))
      // A page fetched while the native's stored copy of the completed reply
      // still held its mid-stream text: a strict prefix of the ended text.
      return {
        data: [
          assistantRow("next", undefined, 300),
          { id: "msg_prompt", type: "user", text: "follow-up", time: { created: 250 } },
          assistantRow("live", midStreamText, 100),
        ],
        cursor: {},
      }
    })
    try {
      // The previous turn completes: the stream assembled the full text and the
      // text ending stamped the final content onto the row.
      const data = armLive(instanceId, fullText)
      emitEvent(instanceId, "session.text.ended", { assistantMessageID: "live", ordinal: 0, text: fullText })
      emitEvent(instanceId, "session.step.ended", { assistantMessageID: "live", finish: "stop" })
      emitEvent(instanceId, "session.execution.succeeded")
      assert.equal(textOf(data, "live"), fullText)

      // The user sends the next prompt; the native admits it and already began
      // the following turn, so the delivered prompt row is not the reducer's
      // last row and its delivery owes the authoritative page read.
      emitEvent(instanceId, "session.inbox.enqueued", {
        inboxID: "msg_prompt",
        item: { type: "user", delivery: "steer", payload: { text: "follow-up" } },
      })
      emitEvent(instanceId, "session.step.started", { assistantMessageID: "next", agent: "build", model: readTestingModel, started: 300 })
      emitEvent(instanceId, "session.inbox.delivered", { inboxID: "msg_prompt" })

      await waitForQuietReads(() => reads)
      assert.equal(reads, 1, "the delivery repair read restarted")
      assert.equal(textOf(data, "live"), fullText, "the repair read's mid-stream page truncated the completed reply")
    } finally {
      f.cleanup()
    }
  })
})
