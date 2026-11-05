import assert from "node:assert/strict"
import { test } from "node:test"
import { createCommandRegistry } from "./commands"

test("registry execution rechecks current disabled state without losing the command", () => {
  const registry = createCommandRegistry()
  let disabled = true, hidden = false, calls = 0
  registry.register({ id: "reader", label: "Reader", description: "Reader", disabled: () => disabled, hidden: () => hidden, action: () => { calls++ } })
  const retained = registry.get("reader")!
  registry.execute(retained.id)
  assert.equal(calls, 0)
  assert.equal(registry.getAll().length, 1)
  disabled = false
  registry.execute(retained.id)
  assert.equal(calls, 1)
  hidden = true
  registry.execute(retained.id)
  assert.equal(calls, 1)
  assert.deepEqual(registry.search("Reader"), [])
  assert.deepEqual(registry.search(""), [])
  hidden = false
  disabled = true
  registry.execute(retained.id)
  assert.equal(calls, 1)
})
