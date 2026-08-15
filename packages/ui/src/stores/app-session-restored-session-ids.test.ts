import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { getRestoredSessionIds } from "./app-session-restored-session-ids.ts"

describe("restored session ids", () => {
  it("deduplicates real session ids and excludes synthetic views from direct hydration", () => {
    assert.deepEqual(getRestoredSessionIds([
      ["session-1", "__no_session_draft__"],
      ["session-1", "session-2", "info"],
      ["session-2"],
    ]), ["session-1", "session-2"])
  })
})
