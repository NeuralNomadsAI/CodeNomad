import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { getFormRequestAutoOpenId } from "./form-request-auto-open.ts"

describe("form request auto-open", () => {
  it("opens each new form once without changing permission or question behavior", () => {
    assert.equal(getFormRequestAutoOpenId({ kind: "form", id: "form-1" }, null), "form-1")
    assert.equal(getFormRequestAutoOpenId({ kind: "form", id: "form-1" }, "form-1"), null)
    assert.equal(getFormRequestAutoOpenId({ kind: "form", id: "form-2" }, "form-1"), "form-2")
    assert.equal(getFormRequestAutoOpenId({ kind: "permission", id: "permission-1" }, null), null)
    assert.equal(getFormRequestAutoOpenId({ kind: "question", id: "question-1" }, null), null)
  })
})
