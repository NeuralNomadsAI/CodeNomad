import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createInstanceMessageStore } from "./instance-store.ts"

describe("message-v2 permission state", () => {
  it("keeps one permission attachment when a duplicate moves from global to a tool part", () => {
    const store = createInstanceMessageStore("instance-1")

    store.upsertPermission({
      permission: { id: "permission-1", callID: "call-1", time: { created: 1_000 } },
      enqueuedAt: 1_000,
    })
    store.upsertPermission({
      permission: { id: "permission-1", tool: { callID: "call-1", messageID: "message-1" } },
      messageId: "message-1",
      partId: "part-1",
      enqueuedAt: 2_000,
    })

    assert.equal(store.state.permissions.queue.length, 1)
    assert.equal(store.getPermissionState(undefined, "permission-1"), null)
    assert.equal(store.getPermissionState("message-1", "part-1")?.entry.permission.callID, "call-1")
    assert.equal(store.getPermissionState("message-1", "part-1")?.active, true)
  })

  it("recalculates the active permission after removing the first queue entry", () => {
    const store = createInstanceMessageStore("instance-1")

    store.upsertPermission({ permission: { id: "permission-1" }, enqueuedAt: 1_000 })
    store.upsertPermission({ permission: { id: "permission-2" }, enqueuedAt: 2_000 })
    store.removePermission("permission-1")

    assert.equal(store.state.permissions.active?.permission.id, "permission-2")
    assert.equal(store.getPermissionState(undefined, "permission-2")?.active, true)
  })
})

describe("message-v2 question state", () => {
  it("keeps one question attachment when a duplicate moves from global to a tool part", () => {
    const store = createInstanceMessageStore("instance-1")

    store.upsertQuestion({
      request: { id: "question-1", sessionID: "session-1", questions: [] },
      enqueuedAt: 1_000,
    })
    store.upsertQuestion({
      request: { id: "question-1", sessionID: "session-1", questions: [] },
      messageId: "message-1",
      partId: "part-1",
      enqueuedAt: 2_000,
    })

    assert.equal(store.state.questions.queue.length, 1)
    assert.equal(store.getQuestionState(undefined, "question-1"), null)
    assert.equal(store.getQuestionState("message-1", "part-1")?.entry.request.id, "question-1")
    assert.equal(store.getQuestionState("message-1", "part-1")?.active, true)
  })

  it("recalculates the active question after removing the first queue entry", () => {
    const store = createInstanceMessageStore("instance-1")

    store.upsertQuestion({ request: { id: "question-1", sessionID: "session-1", questions: [] }, enqueuedAt: 1_000 })
    store.upsertQuestion({ request: { id: "question-2", sessionID: "session-1", questions: [] }, enqueuedAt: 2_000 })
    store.removeQuestion("question-1")

    assert.equal(store.state.questions.active?.request.id, "question-2")
    assert.equal(store.getQuestionState(undefined, "question-2")?.active, true)
  })

  it("preserves original enqueuedAt when a question is upserted with a newer timestamp", () => {
    const store = createInstanceMessageStore("instance-1")

    store.upsertQuestion({ request: { id: "question-1", sessionID: "session-1", questions: [] }, enqueuedAt: 1_000 })
    store.upsertQuestion({ request: { id: "question-2", sessionID: "session-1", questions: [] }, enqueuedAt: 1_500 })
    store.upsertQuestion({
      request: { id: "question-1", sessionID: "session-1", questions: [] },
      messageId: "message-1",
      partId: "part-1",
      enqueuedAt: 2_000,
    })

    // Queue stays ordered by original enqueue time, not the newer upsert time
    assert.equal(store.state.questions.queue.length, 2)
    assert.equal(store.state.questions.queue[0].request.id, "question-1")
    assert.equal(store.state.questions.queue[0].enqueuedAt, 1_000)
    assert.equal(store.state.questions.queue[1].request.id, "question-2")
    assert.equal(store.state.questions.queue[1].enqueuedAt, 1_500)
    assert.equal(store.state.questions.active?.request.id, "question-1")

    // Resolved question-1 is reachable at its tool part location
    assert.equal(store.getQuestionState("message-1", "part-1")?.active, true)
  })
})
