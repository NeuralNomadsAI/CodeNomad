import assert from "node:assert/strict"
import { describe, it } from "node:test"

/**
 * Loads the full instances.ts module graph (under bun's `browser` resolution
 * conditions) to verify the new question idempotency surface is exported and
 * wired. This guards against import/export regressions in the heavy store graph
 * that pure ledger tests would not catch.
 */
describe("instances question idempotency exports", () => {
  it("exposes the question ledger + expired-request error", async () => {
    const mod = await import("./instances.ts")

    assert.equal(typeof mod.sendQuestionReply, "function")
    assert.equal(typeof mod.sendQuestionReject, "function")
    assert.equal(typeof mod.hasRepliedQuestion, "function")
    assert.equal(typeof mod.markQuestionReplied, "function")
    assert.equal(typeof mod.QuestionExpiredError, "function")
  })

  it("QuestionExpiredError carries the request id and a distinct name", async () => {
    const mod = await import("./instances.ts")
    const error = new mod.QuestionExpiredError("que_abc")

    assert.ok(error instanceof Error)
    assert.equal(error.name, "QuestionExpiredError")
    assert.equal(error.requestId, "que_abc")
    assert.match(error.message, /que_abc/)
  })

  it("ledger round-trips through the instances re-exports", async () => {
    const mod = await import("./instances.ts")
    const instanceId = "inst-export-roundtrip"
    const requestId = "que_export"

    assert.equal(mod.hasRepliedQuestion(instanceId, requestId), false)
    mod.markQuestionReplied(instanceId, requestId)
    assert.equal(mod.hasRepliedQuestion(instanceId, requestId), true)
  })
})
