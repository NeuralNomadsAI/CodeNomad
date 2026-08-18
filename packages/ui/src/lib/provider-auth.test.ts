import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { FormFields } from "@opencode-ai/client"
import {
  getProviderAuthAnswer,
  getProviderAuthInitialAnswer,
  isProviderAuthFieldComplete,
} from "./provider-auth.ts"
import { isFormFieldVisible, isHttpFormUrl } from "./form-schema.ts"

const fields = [
  { key: "region", type: "string", required: true, default: "us", options: [{ label: "US", value: "us" }] },
  { key: "account", type: "string", required: true, when: [{ key: "region", op: "eq", value: "eu" }] },
  { key: "external", type: "external", url: "https://example.com" },
] satisfies FormFields

describe("native provider auth answers", () => {
  it("preserves defaults and omits inactive or external fields", () => {
    const answer = { ...getProviderAuthInitialAnswer(fields), account: "stale" }

    assert.equal(isFormFieldVisible(fields[1], answer), false)
    assert.deepEqual(getProviderAuthAnswer(fields, answer), { region: "us" })
  })

  it("requires only active required fields", () => {
    const answer = { region: "eu" }

    assert.equal(isFormFieldVisible(fields[1], answer), true)
    assert.equal(isProviderAuthFieldComplete(fields[1], answer), false)
    assert.equal(isProviderAuthFieldComplete(fields[1], { ...answer, account: "123" }), true)
  })

  it("accepts only explicit HTTP authorization URLs", () => {
    assert.equal(isHttpFormUrl("https://example.com/oauth"), true)
    assert.equal(isHttpFormUrl("http://localhost:3000/oauth"), true)
    assert.equal(isHttpFormUrl("javascript:alert(1)"), false)
    assert.equal(isHttpFormUrl("data:text/html,hello"), false)
    assert.equal(isHttpFormUrl("file:///tmp/token"), false)
    assert.equal(isHttpFormUrl("//example.com/oauth"), false)
  })

  it("rejects answers outside supported field constraints", () => {
    const constrained = [
      { key: "code", type: "string", required: true, minLength: 3, maxLength: 5, pattern: "[A-Z]+" },
      { key: "email", type: "string", format: "email" },
      { key: "count", type: "integer", minimum: 2, maximum: 4 },
      { key: "scopes", type: "multiselect", options: [{ label: "Read", value: "read" }, { label: "Write", value: "write" }], minItems: 1, maxItems: 2 },
    ] satisfies FormFields

    assert.equal(isProviderAuthFieldComplete(constrained[0], { code: "AB" }), false)
    assert.equal(isProviderAuthFieldComplete(constrained[0], { code: "ABCDEF" }), false)
    assert.equal(isProviderAuthFieldComplete(constrained[0], { code: "AbC" }), false)
    assert.equal(isProviderAuthFieldComplete(constrained[0], { code: "ABC" }), true)
    assert.equal(isProviderAuthFieldComplete(constrained[1], { email: "invalid" }), false)
    assert.equal(isProviderAuthFieldComplete(constrained[1], { email: "user@example.com" }), true)
    assert.equal(isProviderAuthFieldComplete(constrained[2], { count: 1 }), false)
    assert.equal(isProviderAuthFieldComplete(constrained[2], { count: 2.5 }), false)
    assert.equal(isProviderAuthFieldComplete(constrained[2], { count: 5 }), false)
    assert.equal(isProviderAuthFieldComplete(constrained[2], { count: 3 }), true)
    assert.equal(isProviderAuthFieldComplete(constrained[3], { scopes: [] }), false)
    assert.equal(isProviderAuthFieldComplete(constrained[3], { scopes: ["read", "write", "read"] }), false)
    assert.equal(isProviderAuthFieldComplete(constrained[3], { scopes: ["other"] }), false)
    assert.equal(isProviderAuthFieldComplete(constrained[3], { scopes: ["read"] }), true)
  })
})
