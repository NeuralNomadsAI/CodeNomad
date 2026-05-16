import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createInstanceMessageStore } from "../../stores/message-v2/instance-store.ts"
import { isInlineQuestionActive } from "./question-active.ts"

describe("isInlineQuestionActive (task 059)", () => {
  it("returns true when the question is the head of the v2 question queue and no permission is ahead", () => {
    const store = createInstanceMessageStore("instance-1")
    store.upsertQuestion({
      request: { id: "question-1", questions: [{ header: "Pick", question: "?", options: [{ label: "A", description: "" }] }] } as any,
      messageId: "msg-1",
      partId: "part-1",
      enqueuedAt: 1_000,
    })

    const result = isInlineQuestionActive({
      requestId: "question-1",
      questionsActiveRequestId: store.state.questions.active?.request.id ?? null,
      permissionsActiveId: store.state.permissions.active?.permission.id ?? null,
    })

    assert.equal(result, true)
  })

  it("returns false when a permission interruption is ahead of the question (F-5 / F-1 reproduction)", () => {
    const store = createInstanceMessageStore("instance-1")

    // Permission lands first and takes the v2 active slot.
    store.upsertPermission({
      permission: { id: "permission-1", time: { created: 1_000 } } as any,
      messageId: "msg-1",
      partId: "perm-part-1",
      enqueuedAt: 1_000,
    })

    // Then a question arrives — its options will render but the inline block
    // must not be interactive because a permission is ahead.
    store.upsertQuestion({
      request: { id: "question-1", questions: [{ header: "Pick", question: "?", options: [{ label: "A", description: "" }] }] } as any,
      messageId: "msg-1",
      partId: "tool-part-1",
      enqueuedAt: 2_000,
    })

    const result = isInlineQuestionActive({
      requestId: "question-1",
      questionsActiveRequestId: store.state.questions.active?.request.id ?? null,
      permissionsActiveId: store.state.permissions.active?.permission.id ?? null,
    })

    assert.equal(result, false, "Question prompt must be inactive while a permission is ahead in the queue")
  })

  it("returns false when another question is ahead in the queue", () => {
    const store = createInstanceMessageStore("instance-1")
    store.upsertQuestion({
      request: { id: "question-1", questions: [] } as any,
      messageId: "msg-1",
      partId: "part-1",
      enqueuedAt: 1_000,
    })
    store.upsertQuestion({
      request: { id: "question-2", questions: [] } as any,
      messageId: "msg-1",
      partId: "part-2",
      enqueuedAt: 2_000,
    })

    // The store keeps the first inserted entry as active.
    const activeId = store.state.questions.active?.request.id
    assert.equal(activeId, "question-1")

    const queuedResult = isInlineQuestionActive({
      requestId: "question-2",
      questionsActiveRequestId: activeId ?? null,
      permissionsActiveId: null,
    })
    assert.equal(queuedResult, false)
  })

  it("returns false when the request id is missing", () => {
    const result = isInlineQuestionActive({
      requestId: undefined,
      questionsActiveRequestId: "question-1",
      permissionsActiveId: null,
    })
    assert.equal(result, false)
  })
})
