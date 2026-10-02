import assert from "node:assert/strict"
import { test } from "node:test"
import type { FormInfo } from "@opencode/client"
import { isWebSearchProviderForm } from "./websearch-form"

test("specializes only recognized native consent forms", () => {
  const form = { id: "f", sessionID: "s", title: "Web Search", metadata: { kind: "websearch.provider" }, fields: [
    { key: "choice", type: "string", required: true, custom: false,
      options: ["allow", "choose", "disable"].map(value => ({ value, label: value })) },
  ] } as FormInfo
  assert.equal(isWebSearchProviderForm(form), true)
  assert.equal(isWebSearchProviderForm({ ...form, metadata: {} }), false)
  assert.equal(isWebSearchProviderForm({ ...form, fields: [...form.fields, form.fields[0]] }), false)
  assert.equal(isWebSearchProviderForm({ ...form, fields: [{ ...form.fields[0], custom: true } as any] }), false)
})
