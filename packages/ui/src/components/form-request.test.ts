import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  formatFormStringInputValue,
  getFormFieldDefaultValue,
  getFormStringInputType,
  normalizeFormStringValue,
} from "./form-request.tsx"

describe("form request protocol mapping", () => {
  it("treats a required boolean as present even when false", () => {
    assert.equal(getFormFieldDefaultValue({ key: "enabled", type: "boolean", required: true }), false)
  })

  it("maps protocol URI fields to the HTML URL input type", () => {
    assert.equal(getFormStringInputType("uri"), "url")
  })

  it("round-trips datetime-local values through RFC3339", () => {
    const local = "2026-08-14T12:34"
    const protocol = normalizeFormStringValue("date-time", local)
    assert.equal(protocol, new Date(local).toISOString())
    assert.equal(formatFormStringInputValue("date-time", protocol!), local)
    assert.equal(normalizeFormStringValue("date-time", "invalid"), undefined)
  })
})
