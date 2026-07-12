import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { mergePendingRequestEntry, shouldSkipPendingRequestUpsert } from "./pending-request-dedupe.ts"

describe("pending request dedupe", () => {
  it("skips unchanged polling updates at the same attachment location", () => {
    const existing = {
      messageId: "message-1",
      partId: "part-1",
      enqueuedAt: 1_000,
    }
    const request = { id: "question-1", sessionID: "session-1", questions: [{ header: "Confirm", question: "Continue?", options: [] }] }

    assert.equal(shouldSkipPendingRequestUpsert({
      existing,
      existingAtLocationId: "question-1",
      expectedActiveId: "question-1",
      activeId: "question-1",
      incomingId: "question-1",
      incomingMessageId: "message-1",
      incomingPartId: "part-1",
      incomingEnqueuedAt: 1_000,
      existingValue: request,
      incomingValue: { ...request, questions: [...request.questions] },
    }), true)
  })

  it("does not skip when polling resolves a request from global state to a tool part", () => {
    const existing = {
      enqueuedAt: 1_000,
    }
    const request = { id: "question-1", sessionID: "session-1", questions: [{ header: "Confirm", question: "Continue?", options: [] }] }

    assert.equal(shouldSkipPendingRequestUpsert({
      existing,
      existingAtLocationId: undefined,
      expectedActiveId: "question-1",
      activeId: "question-1",
      incomingId: "question-1",
      incomingMessageId: "message-1",
      incomingPartId: "part-1",
      incomingEnqueuedAt: 1_000,
      existingValue: request,
      incomingValue: request,
    }), false)
  })

  it("keeps the earliest queue time while preserving resolved attachment ids", () => {
    const merged = mergePendingRequestEntry(
      { messageId: "message-1", partId: "part-1", enqueuedAt: 3_000 },
      { enqueuedAt: 1_000 },
    )

    assert.deepEqual(merged, { messageId: "message-1", partId: "part-1", enqueuedAt: 1_000 })
  })
})
