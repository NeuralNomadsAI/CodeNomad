import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  formatFormStringInputValue,
  getFormFieldDefaultValue,
  getFormStringInputType,
  normalizeFormStringValue,
  shouldRenderFormOptionsInline,
} from "./form-request.tsx"
import { isFormFieldVisible, isHttpFormUrl } from "../lib/form-schema.ts"

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

  it("applies protocol visibility semantics to unanswered and multiselect values", () => {
    const equalField = { type: "string", key: "detail", when: [{ key: "choices", op: "eq", value: "one" }] } as any
    const notEqualField = { type: "string", key: "detail", when: [{ key: "choices", op: "neq", value: "one" }] } as any

    assert.equal(isFormFieldVisible(equalField, {}), false)
    assert.equal(isFormFieldVisible(notEqualField, {}), false)
    assert.equal(isFormFieldVisible(equalField, { choices: ["one", "two"] }), true)
    assert.equal(isFormFieldVisible(notEqualField, { choices: ["one", "two"] }), false)
    assert.equal(isFormFieldVisible(notEqualField, { choices: ["two"] }), true)
  })

  it("allows only explicit HTTP external links", () => {
    assert.equal(isHttpFormUrl("https://example.com/form"), true)
    assert.equal(isHttpFormUrl("javascript:alert(1)"), false)
    assert.equal(isHttpFormUrl("file:///tmp/form"), false)
  })

  it("uses visible choices for short option lists and menus for long lists", () => {
    assert.equal(shouldRenderFormOptionsInline([{ value: "one" }, { value: "two" }]), true)
    assert.equal(shouldRenderFormOptionsInline(Array.from({ length: 5 })), false)
    assert.equal(shouldRenderFormOptionsInline([]), false)
  })
})
