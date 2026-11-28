import assert from "node:assert/strict"
import test from "node:test"
import { recurrenceInputBudget, recurrenceSourceContextLimit, RECURRENCE_SOURCE_CONTEXT_HEADER, RECURRENCE_SOURCE_REFERENCE_RESERVE } from "./recurrence-read-budget"

test("whole source text reserves exact reference, Location and cursor envelopes", () => {
  const config = { consigne: "Review", roots: [{ directory: "/project" }], watchedConversationIDs: ["session_one"] }
  const budget = recurrenceInputBudget(config)
  const messages = [{ id: "msg_source", type: "user", text: "x".repeat(900) }]
  const text = config.consigne + RECURRENCE_SOURCE_CONTEXT_HEADER + JSON.stringify([{ conversationID: "session_one",
    directory: "/project", afterMessageID: null, limit: 32, messages }])
  assert(text.length <= budget.textMaximum)
  assert.equal(recurrenceInputBudget({ ...config, consigne: "x".repeat(budget.instructionsMaximum) }).sufficient, true)
  assert.equal(recurrenceInputBudget({ ...config, consigne: "x".repeat(budget.instructionsMaximum + 1) }).sufficient, false)
})
test("quiet sources release text room without truncating full later source replies", () => {
  const config = { consigne: "Review", roots: [{ directory: "/project" }], watchedConversationIDs: ["session_one", "session_two"] }
  const first = recurrenceSourceContextLimit(config, [])
  const quiet = recurrenceSourceContextLimit(config, [[]])
  assert.equal(quiet, first + RECURRENCE_SOURCE_REFERENCE_RESERVE - 2)
  const messages = [{ id: "msg_source", type: "assistant", text: "x".repeat(8 * 1024) }]
  assert.equal(recurrenceSourceContextLimit(config, [messages]), quiet - JSON.stringify(messages).length + 2)
})
