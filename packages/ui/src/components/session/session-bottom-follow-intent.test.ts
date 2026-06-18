import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { resolveSessionBottomFollowIntent, shouldClearSessionBottomFollowIntent } from "./session-bottom-follow-intent.ts"

describe("session bottom follow intent", () => {
  it("only exposes submit follow intent to the matching session", () => {
    const intent = { sessionId: "session-a", token: 3, minItemCount: 12 }

    assert.deepEqual(resolveSessionBottomFollowIntent(intent, "session-a"), {
      token: 3,
      minItemCount: 12,
    })
    assert.equal(resolveSessionBottomFollowIntent(intent, "session-b"), null)
  })

  it("clears submit follow intent only after the submitted exchange has rendered and stopped streaming", () => {
    const intent = { sessionId: "session-a", token: 3, minItemCount: 12 }

    assert.equal(
      shouldClearSessionBottomFollowIntent(intent, {
        sessionId: "session-a",
        messageCount: 11,
        streamingActive: false,
      }),
      false,
    )

    assert.equal(
      shouldClearSessionBottomFollowIntent(intent, {
        sessionId: "session-a",
        messageCount: 12,
        streamingActive: true,
      }),
      false,
    )

    assert.equal(
      shouldClearSessionBottomFollowIntent(intent, {
        sessionId: "session-a",
        messageCount: 12,
        streamingActive: false,
      }),
      true,
    )

    assert.equal(
      shouldClearSessionBottomFollowIntent(intent, {
        sessionId: "session-b",
        messageCount: 12,
        streamingActive: false,
      }),
      false,
    )
  })
})
