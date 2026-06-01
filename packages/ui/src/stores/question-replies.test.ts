import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  clearRepliedQuestions,
  hasRepliedQuestion,
  markQuestionReplied,
  pruneRepliedQuestions,
} from "./question-replies.ts"

describe("replied question tracking", () => {
  it("keeps replied ids when an older sync does not include them", () => {
    const instanceId = "instance-old-sync"
    const questionId = "question-1"

    markQuestionReplied(instanceId, questionId, 1_000)
    pruneRepliedQuestions(instanceId, new Set(), 900)

    assert.equal(hasRepliedQuestion(instanceId, questionId), true)
    clearRepliedQuestions(instanceId)
  })

  it("keeps replied ids while the server still reports them pending", () => {
    const instanceId = "instance-still-pending"
    const questionId = "question-1"

    markQuestionReplied(instanceId, questionId, 1_000)
    pruneRepliedQuestions(instanceId, new Set([questionId]), 1_100)

    assert.equal(hasRepliedQuestion(instanceId, questionId), true)
    clearRepliedQuestions(instanceId)
  })

  it("clears replied ids once a newer sync observes them missing", () => {
    const instanceId = "instance-new-sync"
    const questionId = "question-1"

    markQuestionReplied(instanceId, questionId, 1_000)
    pruneRepliedQuestions(instanceId, new Set(), 1_100)

    assert.equal(hasRepliedQuestion(instanceId, questionId), false)
    clearRepliedQuestions(instanceId)
  })

  it("ignores empty question ids", () => {
    const instanceId = "instance-empty-id"

    markQuestionReplied(instanceId, "", 1_000)

    assert.equal(hasRepliedQuestion(instanceId, ""), false)
    clearRepliedQuestions(instanceId)
  })

  it("clears all replied ids for an instance", () => {
    const instanceId = "instance-clear"

    markQuestionReplied(instanceId, "question-1", 1_000)
    markQuestionReplied(instanceId, "question-2", 1_000)
    clearRepliedQuestions(instanceId)

    assert.equal(hasRepliedQuestion(instanceId, "question-1"), false)
    assert.equal(hasRepliedQuestion(instanceId, "question-2"), false)
  })

  it("isolates ledgers per instance", () => {
    markQuestionReplied("instance-a", "question-1", 1_000)

    assert.equal(hasRepliedQuestion("instance-a", "question-1"), true)
    assert.equal(hasRepliedQuestion("instance-b", "question-1"), false)

    clearRepliedQuestions("instance-a")
    clearRepliedQuestions("instance-b")
  })
})
