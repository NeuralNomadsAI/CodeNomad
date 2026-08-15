import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { shouldWaitForSavedSessionList } from "./app-session-restore-readiness.ts"

describe("app session restore readiness", () => {
  it("does not wait for a full workspace scan after direct saved-session hydration succeeds", () => {
    assert.equal(shouldWaitForSavedSessionList("parent", "child", new Set()), false)
  })

  it("waits for the authoritative list only when a saved selection is still unavailable", () => {
    assert.equal(shouldWaitForSavedSessionList("parent", "child", new Set(["child"])), true)
    assert.equal(shouldWaitForSavedSessionList(null, "info", new Set(["info"])), false)
  })
})
