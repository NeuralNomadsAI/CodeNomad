import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { preferSessionMetadata, shouldReplaceSessionMetadata } from "./session-metadata-completeness.ts"

describe("session metadata hydration", () => {
  it("treats missing and empty list metadata as incomplete", () => {
    assert.equal(shouldReplaceSessionMetadata(undefined), true)
    assert.equal(shouldReplaceSessionMetadata({}), true)
  })

  it("preserves metadata and tags populated while detailed hydration is pending", () => {
    assert.equal(shouldReplaceSessionMetadata({ tags: ["live"] }), false)
    assert.equal(shouldReplaceSessionMetadata({ owner: "opencode" }), false)
    assert.deepEqual(preferSessionMetadata({}, { tags: ["hydrated"] }), { tags: ["hydrated"] })
    assert.deepEqual(preferSessionMetadata({ tags: ["fresh"] }, { tags: ["old"] }), { tags: ["fresh"] })
  })
})
