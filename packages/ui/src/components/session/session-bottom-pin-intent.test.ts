import assert from "node:assert/strict"
import fs from "node:fs"
import { describe, it } from "node:test"

import { getSubmitBottomPinTargetCount, resolveSessionBottomPinIntent, shouldClearSessionBottomPinIntent } from "./session-bottom-pin-intent.ts"

describe("session bottom pin intent", () => {
  it("starts a bottom pin for every locally submitted prompt, including queue delivery", () => {
    const source = fs.readFileSync(new URL("./session-view.tsx", import.meta.url), "utf8")
    const start = source.indexOf("async function handleSendMessage(")
    const submit = source.slice(start, source.indexOf("function showQueueError", start))

    assert.match(submit, /const initialPinIntent = forceSubmittedExchangeToBottom/)
    assert.doesNotMatch(submit, /delivery === "queue"/)
  })

  it("targets only the queued user prompt when submitting during active streaming", () => {
    assert.equal(getSubmitBottomPinTargetCount(10, true), 11)
    assert.equal(getSubmitBottomPinTargetCount(10, false), 12)
  })

  it("only exposes submit bottom pin intent to the matching session", () => {
    const intent = { sessionId: "session-a", token: 3, minItemCount: 12, createdMessageCount: 10, observedStreaming: false }

    assert.deepEqual(resolveSessionBottomPinIntent(intent, "session-a"), {
      token: 3,
      minItemCount: 12,
    })
    assert.equal(resolveSessionBottomPinIntent(intent, "session-b"), null)
  })

  it("clears submit bottom pin intent after the submitted exchange has rendered and stopped streaming", () => {
    const intent = { sessionId: "session-a", token: 3, minItemCount: 12, createdMessageCount: 10, observedStreaming: false }

    assert.equal(
      shouldClearSessionBottomPinIntent(intent, {
        sessionId: "session-a",
        messageCount: 11,
        streamingActive: false,
      }),
      false,
    )

    assert.equal(
      shouldClearSessionBottomPinIntent(intent, {
        sessionId: "session-a",
        messageCount: 12,
        streamingActive: true,
      }),
      false,
    )

    assert.equal(
      shouldClearSessionBottomPinIntent(intent, {
        sessionId: "session-a",
        messageCount: 12,
        streamingActive: false,
      }),
      true,
    )

    assert.equal(
      shouldClearSessionBottomPinIntent(intent, {
        sessionId: "session-b",
        messageCount: 12,
        streamingActive: false,
      }),
      false,
    )
  })

  it("clears a submitted turn that stopped streaming before the optimistic count was reached", () => {
    const intent = { sessionId: "session-a", token: 3, minItemCount: 12, createdMessageCount: 10, observedStreaming: true }

    assert.equal(
      shouldClearSessionBottomPinIntent(intent, {
        sessionId: "session-a",
        messageCount: 11,
        streamingActive: false,
      }),
      true,
    )
  })
})
