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
      request: { id: "question-1", questions: [] } as any,
      enqueuedAt: 1_000,
    })
    store.upsertQuestion({
      request: { id: "question-1", questions: [] } as any,
      messageId: "message-1",
      partId: "part-1",
      enqueuedAt: 2_000,
    })

    assert.equal(store.state.questions.queue.length, 1)
    assert.equal(store.getQuestionState(undefined, "question-1"), null)
    assert.equal(store.getQuestionState("message-1", "part-1")?.entry.request.id, "question-1")
    assert.equal(store.getQuestionState("message-1", "part-1")?.active, true)
  })

  it("uses enqueue time when recalculating the active question", () => {
    const store = createInstanceMessageStore("instance-1")

    store.upsertQuestion({ request: { id: "question-2", questions: [] } as any, enqueuedAt: 2_000 })
    store.upsertQuestion({ request: { id: "question-1", questions: [] } as any, enqueuedAt: 1_000 })

    assert.equal(store.state.questions.active?.request.id, "question-1")
    assert.equal(store.getQuestionState(undefined, "question-1")?.active, true)
    assert.equal(store.getQuestionState(undefined, "question-2")?.active, false)
  })
})
