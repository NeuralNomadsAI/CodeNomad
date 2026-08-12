import assert from "node:assert/strict"
import test from "node:test"
import { buildSessionSearchMatches, SESSION_SEARCH_MATCH_LIMIT, SESSION_SEARCH_WORK_CHARACTER_LIMIT } from "./session-search.ts"

test("session search retains 250 matches and reports partial results", () => {
  const messageId = "message"
  const partId = "part"
  const text = Array.from({ length: 300 }, () => "needle").join(" ")
  const record = { id: messageId, role: "assistant", partIds: [partId], parts: { [partId]: { data: { id: partId, type: "text", text } } } }
  const store = {
    getSessionMessageIds: () => [messageId],
    getMessage: () => record,
    getMessageInfo: () => undefined,
  }
  const result = buildSessionSearchMatches({ store: store as any, sessionId: "session", query: "needle", includeThinking: false })
  assert.equal(result.matches.length, SESSION_SEARCH_MATCH_LIMIT)
  assert.equal(result.partial, true)
})

test("session search reports complete results below the limit", () => {
  const record = { id: "message", role: "user", partIds: ["part"], parts: { part: { data: { id: "part", type: "text", text: "one needle" } } } }
  const store = { getSessionMessageIds: () => ["message"], getMessage: () => record, getMessageInfo: () => undefined }
  const result = buildSessionSearchMatches({ store: store as any, sessionId: "session", query: "needle", includeThinking: false })
  assert.equal(result.matches.length, 1)
  assert.equal(result.partial, false)
})

test("session search bounds work even without enough matches", () => {
  const text = `${"x".repeat(SESSION_SEARCH_WORK_CHARACTER_LIMIT + 1)}needle`
  const record = { id: "message", role: "user", partIds: ["part"], parts: { part: { data: { id: "part", type: "text", text } } } }
  const store = { getSessionMessageIds: () => ["message"], getMessage: () => record, getMessageInfo: () => undefined }
  const result = buildSessionSearchMatches({ store: store as any, sessionId: "session", query: "needle", includeThinking: false })
  assert.equal(result.matches.length, 0)
  assert.equal(result.partial, true)
})
