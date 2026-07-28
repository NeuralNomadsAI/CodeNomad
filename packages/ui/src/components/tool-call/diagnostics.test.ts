import assert from "node:assert/strict"
import test from "node:test"
import { selectSeverityBounded } from "./diagnostic-selection.ts"

test("diagnostic bounds retain errors that follow informational entries", () => {
  const diagnostics = [
      ...Array.from({ length: 100 }, (_, index) => ({ message: `info ${index}`, severity: 3 })),
      { message: "the error", severity: 1 },
    ]
  const entries = selectSeverityBounded(diagnostics, (entry) => entry.severity === 1 ? 0 : 2, 100)
  assert.equal(entries.length, 100)
  assert.equal(entries[0]?.message, "the error")
})
