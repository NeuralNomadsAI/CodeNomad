import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createInstanceMessageStore } from "../../stores/message-v2/instance-store.ts"
import { isInlineQuestionActive } from "./question-active.ts"

/**
 * Task 059 — scenario reproductions for the three failure modes called out in
 * the investigation (task 058) and observed in the wild on issue #448.
 *
 * These tests drive the v2 message store the same way the SSE pipeline does
 * during a real session and assert that {@link isInlineQuestionActive} — the
 * gate that decides whether the inline `<QuestionToolBlock>` is interactive —
 * returns the right answer for every question in the queue.
 *
 * Reading the v2 store state via the public selector is exactly what
 * `tool-call.tsx::isQuestionActive` does after the fix, so a passing assertion
 * here means a real user looking at the same question would see an
 * interactive prompt (or an honest "Queued" banner) and never a stuck
 * options-visible-but-uninteractive state.
 *
 * Why this lives in `components/tool-call/` rather than `stores/`: the
 * scenarios validate the inline component's contract with the store, not the
 * store's internal invariants. The store-level invariants are covered by
 * `question-optimistic-clear.test.ts`.
 */

type ActiveSnapshot = {
  questionsActiveRequestId: string | null
  permissionsActiveId: string | null
}

function snapshotActive(store: ReturnType<typeof createInstanceMessageStore>): ActiveSnapshot {
  return {
    questionsActiveRequestId: store.state.questions.active?.request.id ?? null,
    permissionsActiveId: store.state.permissions.active?.permission.id ?? null,
  }
}

function gate(snap: ActiveSnapshot, requestId: string) {
  return isInlineQuestionActive({
    requestId,
    questionsActiveRequestId: snap.questionsActiveRequestId,
    permissionsActiveId: snap.permissionsActiveId,
  })
}

function makeQuestion(id: string) {
  return {
    id,
    questions: [
      { header: "Pick one", question: "?", options: [{ label: "A", description: "" }] },
    ],
  } as any
}

describe("question prompt concurrency scenarios (task 059 / issue #448)", () => {
  it("two questions arrive back-to-back: head is interactive, trailing renders queued", () => {
    // Scenario: parallel subagents each emit a question into the same session
    // within milliseconds. Both tool parts mount and render their options.
    // Before the fix the inline gate could leave the head disabled while the
    // legacy `activeInterruption` resolved; after the fix the v2 store is the
    // single source of truth and the head is always interactive.
    const store = createInstanceMessageStore("instance-1")

    store.upsertQuestion({
      request: makeQuestion("q-head"),
      messageId: "msg-1",
      partId: "part-head",
      enqueuedAt: 1_000,
    })
    store.upsertQuestion({
      request: makeQuestion("q-tail"),
      messageId: "msg-1",
      partId: "part-tail",
      enqueuedAt: 1_010,
    })

    const snap = snapshotActive(store)
    assert.equal(snap.questionsActiveRequestId, "q-head", "first-arrival keeps the active slot")
    assert.equal(gate(snap, "q-head"), true, "head question must be interactive")
    assert.equal(gate(snap, "q-tail"), false, "trailing question must render the queued banner")
  })

  it("permission interruption arriving alongside a question keeps the prompt non-interactive (issue #448 path 1)", () => {
    // Scenario: a tool call requiring permission and a question arrive in the
    // same SSE burst. The permission lands first and owns the v2 permission
    // slot; the question's tool part still mounts and its options render.
    // Before the fix the legacy `activeInterruption` pointed at the permission
    // and the inline block disabled every input while leaving Submit hidden —
    // visually identical to "loading." After the fix the inline gate explicitly
    // sees the permission ahead and the queued banner is rendered instead.
    const store = createInstanceMessageStore("instance-1")

    store.upsertPermission({
      permission: { id: "perm-1", time: { created: 1_000 } } as any,
      messageId: "msg-1",
      partId: "part-perm",
      enqueuedAt: 1_000,
    })
    store.upsertQuestion({
      request: makeQuestion("q-1"),
      messageId: "msg-1",
      partId: "part-question",
      enqueuedAt: 1_005,
    })

    const blockedSnap = snapshotActive(store)
    assert.equal(blockedSnap.permissionsActiveId, "perm-1")
    assert.equal(blockedSnap.questionsActiveRequestId, "q-1")
    assert.equal(
      gate(blockedSnap, "q-1"),
      false,
      "question must not be interactive while a permission is ahead in the v2 queue",
    )

    // Once the user resolves the permission, the question becomes interactive
    // without any further SSE replay — the gate reacts to v2 state only.
    store.removePermission("perm-1")
    const releasedSnap = snapshotActive(store)
    assert.equal(releasedSnap.permissionsActiveId, null)
    assert.equal(
      gate(releasedSnap, "q-1"),
      true,
      "question becomes interactive immediately after the permission is cleared",
    )
  })

  it("post-submit lifecycle: optimistic clear + delayed SSE confirmation never re-strands the prompt", () => {
    // Scenario: user picks an answer and submits. The HTTP reply succeeds,
    // `sendQuestionReply` removes the v2 entry optimistically, and a moment
    // later the server's `question.replied` SSE event arrives and triggers a
    // second `removeQuestion`. Before the fix the inline gate would briefly
    // disagree with the v2 store during this window (legacy queue cleared, v2
    // entry still present, looked stuck). After the fix the gate goes to false
    // the instant the v2 entry is removed and stays false even after the
    // duplicate SSE clear.
    const store = createInstanceMessageStore("instance-1")
    store.upsertQuestion({
      request: makeQuestion("q-reply"),
      messageId: "msg-1",
      partId: "part-1",
      enqueuedAt: 2_000,
    })

    const beforeSubmit = snapshotActive(store)
    assert.equal(gate(beforeSubmit, "q-reply"), true)

    // sendQuestionReply -> optimistic clear
    store.removeQuestion("q-reply")
    const afterOptimisticClear = snapshotActive(store)
    assert.equal(afterOptimisticClear.questionsActiveRequestId, null)
    assert.equal(gate(afterOptimisticClear, "q-reply"), false)

    // Confirming SSE event arrives later — idempotent
    assert.doesNotThrow(() => store.removeQuestion("q-reply"))
    const afterConfirmingSse = snapshotActive(store)
    assert.equal(afterConfirmingSse.questionsActiveRequestId, null)
    assert.equal(gate(afterConfirmingSse, "q-reply"), false)
  })

  it("rollback after a failed reply restores interactivity on the same prompt", () => {
    // Scenario: optimistic clear runs, the HTTP reply fails, and the v2 entry
    // is re-upserted. The gate must return `true` again so the user can retry.
    const store = createInstanceMessageStore("instance-1")
    const request = makeQuestion("q-retry")
    store.upsertQuestion({
      request,
      messageId: "msg-1",
      partId: "part-1",
      enqueuedAt: 3_000,
    })

    // Optimistic clear.
    store.removeQuestion("q-retry")
    assert.equal(gate(snapshotActive(store), "q-retry"), false)

    // Rollback after network failure.
    store.upsertQuestion({ request, messageId: "msg-1", partId: "part-1", enqueuedAt: 3_000 })
    const afterRollback = snapshotActive(store)
    assert.equal(afterRollback.questionsActiveRequestId, "q-retry")
    assert.equal(gate(afterRollback, "q-retry"), true, "user must be able to retry the answer")
  })

  it("permission ahead of the head only blocks until the permission resolves (queue head stays correct)", () => {
    // Defense-in-depth: a permission ahead must not also disable a queued
    // (non-head) question's interactivity flag in a way that gets it
    // accidentally activated after the permission clears. Only the head
    // question becomes interactive when the permission is removed; the
    // trailing question remains queued.
    const store = createInstanceMessageStore("instance-1")

    store.upsertPermission({
      permission: { id: "perm-1", time: { created: 0 } } as any,
      messageId: "msg-1",
      partId: "part-perm",
      enqueuedAt: 1_000,
    })
    store.upsertQuestion({
      request: makeQuestion("q-head"),
      messageId: "msg-1",
      partId: "part-head",
      enqueuedAt: 1_500,
    })
    store.upsertQuestion({
      request: makeQuestion("q-tail"),
      messageId: "msg-1",
      partId: "part-tail",
      enqueuedAt: 1_600,
    })

    const blocked = snapshotActive(store)
    assert.equal(gate(blocked, "q-head"), false)
    assert.equal(gate(blocked, "q-tail"), false)

    store.removePermission("perm-1")
    const released = snapshotActive(store)
    assert.equal(gate(released, "q-head"), true)
    assert.equal(gate(released, "q-tail"), false, "queued question stays queued until head is answered")
  })
})
