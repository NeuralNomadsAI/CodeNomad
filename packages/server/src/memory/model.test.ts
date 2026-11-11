import assert from "node:assert/strict"
import { test } from "node:test"
import { MEMORY_LIMITS, MemoryError, validateMemoryContent, validateMemoryEntry } from "./model"

const content = { title: "Préférence", type: "preference", text: "Keep the text\n" }
const entry = { ...content, id: "entry-1", sessionId: "ses_fixture", createdAt: "2026-11-05T10:00:00Z", updatedAt: "2026-11-05T11:00:00Z" }
const code = (expected: string) => (error: unknown) => error instanceof MemoryError && error.code === expected

test("memory contracts preserve content, exact limits and Unicode code-point lengths", () => {
  assert.deepEqual(MEMORY_LIMITS, { global: 60, project: 200, title: 60, text: 2000, instructions: 8000 })
  assert.deepEqual(validateMemoryEntry(entry), entry)
  for (const type of ["fact", "preference", "reference"]) assert.equal(validateMemoryContent({ ...content, type }).type, type)
  assert.equal(validateMemoryContent({ ...content, title: "😀".repeat(60), text: "😀".repeat(2000) }).text.length, 4000)
  assert.throws(() => validateMemoryContent({ ...content, title: "😀".repeat(61) }), code("invalid"))
  assert.throws(() => validateMemoryContent({ ...content, text: "😀".repeat(2001) }), code("invalid"))
})

test("invalid headers and unsafe filenames fail explicitly, including storage reads", () => {
  for (const patch of [{ id: "../escape" }, { id: "CON" }, { title: "\nrole" }, { title: " " }, { type: "system" }, { sessionId: "" },
    { createdAt: "yesterday" }, { updatedAt: undefined }, { unknown: true }]) {
    assert.throws(() => validateMemoryEntry({ ...entry, ...patch }), code("invalid"))
    assert.throws(() => validateMemoryEntry({ ...entry, ...patch }, "malformed"), code("malformed"))
  }
  assert.throws(() => validateMemoryEntry(null, "malformed"), code("malformed"))
  assert.deepEqual(new MemoryError("full", "Merge entries", ["one"]).titles, ["one"])
})
