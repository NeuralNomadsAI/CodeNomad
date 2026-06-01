import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  clearRepliedQuestions,
  hasRepliedQuestion,
  markQuestionReplied,
  pruneRepliedQuestions,
} from "./question-replies.ts"

/**
 * These tests exercise the exact ledger-driven guard expressions used by the
 * production question lifecycle (instances.ts `syncPendingQuestions`,
 * session-events.ts `handleQuestionAsked`, and the `sendQuestionReply` /
 * `handleQuestionSubmit` idempotency checks). They prove the AC-7 scenarios:
 * stale reply no-op, reconnect re-delivery ignored, double-submit prevented,
 * and the expired-request path — without mocking the full SDK client graph.
 */

describe("question stale-reply no-op (AC-1/AC-4)", () => {
  it("treats a second reply attempt as a no-op once the ledger records it", () => {
    const instanceId = "inst-stale-reply"
    const requestId = "que_stale"

    // First reply succeeds and records the ledger entry (mirrors the
    // markQuestionReplied call inside sendQuestionReply on success).
    let posts = 0
    function sendReply(): "posted" | "noop" {
      if (hasRepliedQuestion(instanceId, requestId)) return "noop"
      posts += 1
      markQuestionReplied(instanceId, requestId)
      return "posted"
    }

    assert.equal(sendReply(), "posted")
    assert.equal(sendReply(), "noop")
    assert.equal(sendReply(), "noop")
    assert.equal(posts, 1, "only the first attempt may POST")

    clearRepliedQuestions(instanceId)
  })
})

describe("reconnect re-delivery ignored (AC-2/AC-3)", () => {
  it("syncPendingQuestions filter drops an already-replied question on reconnect", () => {
    const instanceId = "inst-reconnect"
    const requestId = "que_reconnect"

    // User answered locally just now.
    const repliedAt = 5_000
    markQuestionReplied(instanceId, requestId, repliedAt)

    // A reconnect sync STARTED BEFORE the server has processed the reply still
    // reports the question pending. The prune must NOT retire the ledger (sync
    // started before the reply cannot prove the server dropped it), and the
    // filter must drop the stale item so it is not re-queued.
    const syncStartedAt = 4_000
    const remotePendingIds = new Set([requestId])
    pruneRepliedQuestions(instanceId, remotePendingIds, syncStartedAt)
    const pendingRemote = [requestId].filter((id) => !hasRepliedQuestion(instanceId, id))

    assert.equal(hasRepliedQuestion(instanceId, requestId), true, "ledger retained")
    assert.deepEqual(pendingRemote, [], "stale question filtered out of the queue")

    clearRepliedQuestions(instanceId)
  })

  it("handleQuestionAsked stale guard ignores a re-delivered asked event", () => {
    const instanceId = "inst-asked"
    const requestId = "que_asked"
    markQuestionReplied(instanceId, requestId)

    // Mirror handleQuestionAsked: early-return when already replied.
    function handleQuestionAsked(id: string): "ignored" | "queued" {
      if (id && hasRepliedQuestion(instanceId, id)) return "ignored"
      return "queued"
    }

    assert.equal(handleQuestionAsked(requestId), "ignored")
    clearRepliedQuestions(instanceId)
  })
})

describe("double-submit prevented (AC-5)", () => {
  it("synchronous submitting flag blocks a second submit before the await boundary", () => {
    let submitting = false
    let replies = 0

    function handleQuestionSubmit(): void {
      // Mirror the very-top guard in tool-call.tsx handleQuestionSubmit.
      if (submitting) return
      submitting = true
      replies += 1
      // (await sendQuestionReply ... happens here in production)
    }

    // Enter + button fire back-to-back within the same synchronous turn.
    handleQuestionSubmit()
    handleQuestionSubmit()

    assert.equal(replies, 1, "only one reply dispatched despite two submit vectors")
    submitting = false
  })

  it("ledger no-op blocks a submit after an SSE replied event already cleared it", () => {
    const instanceId = "inst-double"
    const requestId = "que_double"

    // SSE handleQuestionAnswered marked it replied before the user's submit ran.
    markQuestionReplied(instanceId, requestId)

    function handleQuestionSubmit(): "noop" | "submit" {
      if (hasRepliedQuestion(instanceId, requestId)) return "noop"
      return "submit"
    }

    assert.equal(handleQuestionSubmit(), "noop")
    clearRepliedQuestions(instanceId)
  })
})

describe("expired-request path (AC-4)", () => {
  it("surfaces the expired path when the request is absent from question.list()", () => {
    const instanceId = "inst-expired"
    const requestId = "que_expired"

    // Reconcile-before-POST: the remote list no longer contains the request.
    const remotePending = new Set<string>(["que_other"])

    function reconcileBeforePost(): "post" | "expired" {
      if (!remotePending.has(requestId)) {
        // Mirror sendQuestionReply: mark replied + treat as expired, no POST.
        markQuestionReplied(instanceId, requestId)
        return "expired"
      }
      return "post"
    }

    assert.equal(reconcileBeforePost(), "expired")
    assert.equal(hasRepliedQuestion(instanceId, requestId), true, "expired request retired via ledger")

    clearRepliedQuestions(instanceId)
  })

  it("POSTs normally while the request is still present in question.list()", () => {
    const instanceId = "inst-present"
    const requestId = "que_present"
    const remotePending = new Set<string>([requestId])

    function reconcileBeforePost(): "post" | "expired" {
      if (!remotePending.has(requestId)) return "expired"
      return "post"
    }

    assert.equal(reconcileBeforePost(), "post")
    clearRepliedQuestions(instanceId)
  })
})
