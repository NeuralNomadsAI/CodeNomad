import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  armLive, assistantRow, emitEvent, readFixture, readTestingModel, readTestingSessionId as sessionId, textOf,
} from "./opencode-data-read-testing.ts"

async function settle(ms = 150): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

describe("OpenCode data transcript rotation replay", () => {
  it("replays a streamed completion queued across rotation without rewinding it", async () => {
    const instanceId = "opencode-rotation-replay"
    let reads = 0
    const f = readFixture(instanceId, async () => {
      reads += 1
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      return {
        data: [
          { id: "msg_prompt", type: "user", text: "next", time: { created: 900 } },
          assistantRow("live", "base", 100),
        ],
        cursor: {},
      }
    })
    try {
      const data = armLive(instanceId, "base")
      // Fill the reducer past the transcript bound so an append-boundary event
      // queues and starts rotation.
      for (let index = 0; index < 205; index += 1) {
        emitEvent(instanceId, "session.synthetic", { text: `row ${index}`, description: `filler ${index}` })
      }
      emitEvent(instanceId, "session.inbox.enqueued", {
        inboxID: "msg_prompt",
        item: { type: "user", delivery: "steer", payload: { text: "next" } },
      })
      // The completion and its turn boundary queue behind the rotation.
      const fullText = "H".repeat(800) + "TAIL".repeat(50)
      emitEvent(instanceId, "session.text.delta", { assistantMessageID: "live", ordinal: 0, delta: fullText })
      emitEvent(instanceId, "session.text.ended", { assistantMessageID: "live", ordinal: 0, text: fullText })
      emitEvent(instanceId, "session.step.ended", { assistantMessageID: "live", finish: "stop" })
      emitEvent(instanceId, "session.execution.succeeded")
      await settle(400)
      assert.equal(textOf(data, "live"), fullText, "rotation replay rewound the streamed completion")
    } finally {
      f.cleanup()
    }
  })
})
