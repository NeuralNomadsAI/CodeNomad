import assert from "node:assert/strict"
import test from "node:test"

import { clearSettledForms, hasSettledForm, markFormSettled, pruneSettledForms } from "./form-settlements"

test("keeps settled forms suppressed until a later authoritative list proves absence", () => {
  const instanceId = "forms"
  markFormSettled(instanceId, "form", 10)
  pruneSettledForms(instanceId, new Set(["form"]), 20)
  assert.equal(hasSettledForm(instanceId, "form"), true)
  pruneSettledForms(instanceId, new Set(), 20)
  assert.equal(hasSettledForm(instanceId, "form"), false)
  clearSettledForms(instanceId)
})
