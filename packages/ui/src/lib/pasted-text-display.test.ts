import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { getPastedTextLineCount } from "./pasted-text-display"

describe("getPastedTextLineCount", () => {
  it("counts single-line pasted text", () => {
    assert.equal(getPastedTextLineCount("alpha"), 1)
  })

  it("counts multi-line pasted text", () => {
    assert.equal(getPastedTextLineCount("alpha\nbeta\ngamma"), 3)
  })
})
