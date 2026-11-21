import assert from "node:assert/strict"
import test from "node:test"
import { DeveloperInspectionTargets } from "./developer-inspection-targets"

test("a delayed inspection cannot revoke the newer request from the same caller", () => {
  const targets = new DeveloperInspectionTargets()
  const identity = { endpoint: "http://127.0.0.1:10000", runId: "current", windowId: "window-B" }
  const newer = targets.begin("session", { source: "plugin", sequence: 2 })!
  assert.equal(targets.begin("session", { source: "plugin", sequence: 1 }), undefined)
  const pin = newer(identity)
  assert.ok(pin)
  assert.equal(targets.get("session", pin), identity)
})

test("repeated inspections in one session cannot evict another session's returned pin", () => {
  const targets = new DeveloperInspectionTargets()
  const identity = { endpoint: "http://127.0.0.1:10000", runId: "current", windowId: "window-A" }
  const pin = targets.begin("A")!(identity)
  for (let index = 0; index < 130; index++) targets.begin("B")!({ ...identity, windowId: "window-B" })
  assert.ok(pin)
  assert.equal(targets.get("A", pin), identity)
  assert.equal(targets.get("B", pin), undefined)
})
