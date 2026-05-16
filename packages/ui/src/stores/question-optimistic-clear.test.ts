import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createInstanceMessageStore } from "./message-v2/instance-store.ts"

/**
 * Task 059: regression test for the post-submit transient window (F-2 in
 * task 058's investigation).
 *
 * Before the fix, the v2 question entry was only removed when the server's
 * confirming `question.replied` SSE event arrived. On a slow round-trip or a
 * brief SSE disconnect the inline prompt re-rendered with options visible but
 * inactive between the HTTP reply resolving and the broadcast event.
 *
 * After the fix, `sendQuestionReply`/`sendQuestionReject` clear the v2 entry
 * optimistically — and restore it on a network failure. We can't exercise the
 * full action here without spinning up the network/worktree client, but we
 * can verify the underlying invariant: the v2 store correctly removes and
 * re-upserts a question entry without leaving stale `byMessage` slots, so
 * rollback is always sound.
 */
describe("question v2 entry optimistic clear/restore (task 059)", () => {
  it("removeQuestion clears all byMessage references and active slot", () => {
    const store = createInstanceMessageStore("instance-1")
    const request = { id: "question-1", questions: [] } as any
    store.upsertQuestion({
      request,
      messageId: "msg-1",
      partId: "part-1",
      enqueuedAt: 1_000,
    })

    assert.equal(store.state.questions.active?.request.id, "question-1")
    assert.equal(store.state.questions.queue.length, 1)
    assert.equal(store.getQuestionState("msg-1", "part-1")?.entry.request.id, "question-1")

    store.removeQuestion("question-1")

    assert.equal(store.state.questions.active, null)
    assert.equal(store.state.questions.queue.length, 0)
    assert.equal(store.getQuestionState("msg-1", "part-1"), null)
  })

  it("re-upserting after a remove restores the entry with the same identity (rollback path)", () => {
    const store = createInstanceMessageStore("instance-1")
    const request = { id: "question-1", questions: [] } as any
    const enqueuedAt = 1_500

    store.upsertQuestion({ request, messageId: "msg-1", partId: "part-1", enqueuedAt })

    // Simulate optimistic clear.
    store.removeQuestion("question-1")
    assert.equal(store.state.questions.queue.length, 0)

    // Simulate rollback after a failed network call.
    store.upsertQuestion({ request, messageId: "msg-1", partId: "part-1", enqueuedAt })

    const restoredActive = store.state.questions.active
    assert.ok(restoredActive, "Question should be restored after rollback")
    assert.equal(restoredActive.request.id, "question-1")
    assert.equal(store.state.questions.queue.length, 1)
    assert.equal(store.getQuestionState("msg-1", "part-1")?.active, true)
  })

  it("a second optimistic-clear after the SSE confirmation is idempotent", () => {
    const store = createInstanceMessageStore("instance-1")
    store.upsertQuestion({
      request: { id: "question-1", questions: [] } as any,
      messageId: "msg-1",
      partId: "part-1",
      enqueuedAt: 1_000,
    })

    // First clear: optimistic (during `sendQuestionReply`).
    store.removeQuestion("question-1")
    // Second clear: confirming `question.replied` SSE event arrives later.
    assert.doesNotThrow(() => store.removeQuestion("question-1"))
    assert.equal(store.state.questions.queue.length, 0)
  })
})
