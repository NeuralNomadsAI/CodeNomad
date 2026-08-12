import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { FormFields } from "@opencode-ai/client"
import {
  getProviderAuthAnswer,
  getProviderAuthInitialAnswer,
  isProviderAuthFieldComplete,
  shouldShowProviderAuthField,
} from "./provider-auth.ts"

const fields = [
  { key: "region", type: "string", required: true, default: "us", options: [{ label: "US", value: "us" }] },
  { key: "account", type: "string", required: true, when: [{ key: "region", op: "eq", value: "eu" }] },
  { key: "external", type: "external", url: "https://example.com" },
] satisfies FormFields

describe("native provider auth answers", () => {
  it("preserves defaults and omits inactive or external fields", () => {
    const answer = { ...getProviderAuthInitialAnswer(fields), account: "stale" }

    assert.equal(shouldShowProviderAuthField(fields[1], answer), false)
    assert.deepEqual(getProviderAuthAnswer(fields, answer), { region: "us" })
  })

  it("requires only active required fields", () => {
    const answer = { region: "eu" }

    assert.equal(shouldShowProviderAuthField(fields[1], answer), true)
    assert.equal(isProviderAuthFieldComplete(fields[1], answer), false)
    assert.equal(isProviderAuthFieldComplete(fields[1], { ...answer, account: "123" }), true)
  })
})
