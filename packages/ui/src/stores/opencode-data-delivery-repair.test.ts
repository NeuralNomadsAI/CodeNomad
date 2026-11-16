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

const streamedText = "H".repeat(800) + "TAIL".repeat(50)

/** Arms the delivery repair read: the prompt row is admitted, a later row
 * makes it not the reducer's last row, and its delivery is announced. */
function armDeliveryRepair(instanceId: string) {
  emitEvent(instanceId, "session.inbox.enqueued", {
    inboxID: "msg_prompt",
    item: { type: "user", delivery: "steer", payload: { text: "follow-up" } },
  })
  emitEvent(instanceId, "session.synthetic", { text: "note", description: "later row" })
  emitEvent(instanceId, "session.inbox.delivered", { inboxID: "msg_prompt" })
}

describe("OpenCode data delivery repair read", () => {
  it("keeps a streaming reply's assembled deltas when the page holds the fragment's empty persistence", async () => {
    const instanceId = "opencode-data-delivery-repair-open"
    let reads = 0
    const f = readFixture(instanceId, async () => {
      reads += 1
      await new Promise<void>((resolve) => setImmediate(resolve))
      // The native persists an empty part until the fragment's full-text
      // ending commits, so a page fetched while its deltas are paused holds
      // the fragment with no text even though the stream already displayed it.
      return {
        data: [
          { id: "msg_prompt", type: "user", text: "follow-up", time: { created: 250 } },
          assistantRow("live", "", 100),
        ],
        cursor: {},
      }
    })
    try {
      // The reply is mid-stream with its deltas paused; the live row holds the
      // text the stream assembled so far and no completion stamp, and so does
      // the page's copy of the row.
      const data = armLive(instanceId, streamedText)
      armDeliveryRepair(instanceId)

      await waitForQuietReads(() => reads)
      assert.equal(textOf(data, "live"), streamedText, "the repair read's empty persistence rewound the streamed text")
    } finally {
      f.cleanup()
    }
  })

  for (const finalText of ["D", ""]) {
    it(`takes the page's completed-item final ${JSON.stringify(finalText)} over the streamed draft`, async () => {
      const instanceId = `opencode-data-delivery-repair-final-${finalText.length}`
      let reads = 0
      const f = readFixture(instanceId, async () => {
        reads += 1
        await new Promise<void>((resolve) => setImmediate(resolve))
        // The provider's completed item replaced the streamed draft; the page
        // carries the replacement together with the step's completion, both
        // committed before the ending's event reached the reducer.
        return {
          data: [
            { id: "msg_prompt", type: "user", text: "follow-up", time: { created: 250 } },
            {
              ...assistantRow("live", finalText, 100),
              finish: "stop",
              time: { created: 100, completed: 200 },
            },
          ],
          cursor: {},
        }
      })
      try {
        const data = armLive(instanceId, streamedText)
        armDeliveryRepair(instanceId)

        await waitForQuietReads(() => reads)
        assert.equal(textOf(data, "live"), finalText, "the page's authoritative final must replace the streamed draft")
        assert.equal((data.session.message.get(sessionId, "live") as { finish?: unknown })?.finish, "stop")
      } finally {
        f.cleanup()
      }
    })
  }

  it("takes the page's committed empty final that precedes a later part in an open step", async () => {
    const instanceId = "opencode-data-delivery-repair-open-final"
    let reads = 0
    const f = readFixture(instanceId, async () => {
      reads += 1
      await new Promise<void>((resolve) => setImmediate(resolve))
      // The fragment finalized as empty and a tool input already started in
      // the same open step: the tool part's append proves the empty ending
      // committed, so the empty text is the authoritative final.
      return {
        data: [
          { id: "msg_prompt", type: "user", text: "follow-up", time: { created: 250 } },
          {
            ...assistantRow("live", undefined, 100),
            content: [
              { type: "text", text: "" },
              { type: "tool", id: "tool", name: "bash", time: { created: 150 }, state: { status: "streaming", input: "" } },
            ],
          },
        ],
        cursor: {},
      }
    })
    try {
      const data = armLive(instanceId, streamedText)
      armDeliveryRepair(instanceId)

      await waitForQuietReads(() => reads)
      assert.equal(textOf(data, "live"), "", "a committed empty final before a later part must replace the streamed draft")
    } finally {
      f.cleanup()
    }
  })

  it("takes the page's committed empty final that carries native metadata as the last part", async () => {
    const instanceId = "opencode-data-delivery-repair-native-final"
    let reads = 0
    const f = readFixture(instanceId, async () => {
      reads += 1
      await new Promise<void>((resolve) => setImmediate(resolve))
      // The fragment's ending committed as empty and stamped the provider's
      // native metadata onto the stored part; the next part has not been
      // appended yet, so the committed empty final is the row's last part.
      return {
        data: [
          { id: "msg_prompt", type: "user", text: "follow-up", time: { created: 250 } },
          {
            ...assistantRow("live", undefined, 100),
            content: [
              { type: "text", text: "", native: { itemId: "msg_1", phase: "final_answer" } },
            ],
          },
        ],
        cursor: {},
      }
    })
    try {
      const data = armLive(instanceId, streamedText)
      armDeliveryRepair(instanceId)

      await waitForQuietReads(() => reads)
      assert.equal(textOf(data, "live"), "", "a committed empty final with native metadata must replace the streamed draft")
    } finally {
      f.cleanup()
    }
  })

  it("keeps streamed reasoning when the page holds the open fragment empty with its started native metadata", async () => {
    const instanceId = "opencode-data-delivery-repair-open-reasoning"
    let reads = 0
    const f = readFixture(instanceId, async () => {
      reads += 1
      await new Promise<void>((resolve) => setImmediate(resolve))
      // Reasoning persists its provider metadata when it starts, so `native`
      // alone does not mark it ended; only `time.completed` does.
      return {
        data: [
          { id: "msg_prompt", type: "user", text: "follow-up", time: { created: 250 } },
          {
            ...assistantRow("live", undefined, 100),
            content: [
              { type: "reasoning", text: "", native: { itemId: "rs_1", reasoningEncryptedContent: null }, time: { created: 150 } },
            ],
          },
        ],
        cursor: {},
      }
    })
    try {
      const live = { assistantMessageID: "live" }
      emitEvent(instanceId, "session.step.started", { ...live, agent: "build", model: readTestingModel, started: 100 })
      emitEvent(instanceId, "session.reasoning.started", { ...live, ordinal: 0 })
      const data = emitEvent(instanceId, "session.reasoning.delta", { ...live, ordinal: 0, delta: streamedText })
      armDeliveryRepair(instanceId)

      await waitForQuietReads(() => reads)
      const row: any = data.session.message.get(sessionId, "live")
      const reasoning = row?.content?.find((part: any) => part.type === "reasoning")?.text
      assert.equal(reasoning, streamedText, "the repair read's open reasoning fragment rewound the streamed reasoning")
    } finally {
      f.cleanup()
    }
  })
})
