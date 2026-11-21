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

test("starting another inspection retires the prior restart admission before CDP reads", () => {
  const targets = new DeveloperInspectionTargets()
  const original = { endpoint: "http://127.0.0.1:10000", runId: "current", windowId: "window-A" }
  const pin = targets.begin("session")!(original)
  assert.equal(targets.isCurrent("session", original), true)
  targets.begin("session")
  assert.equal(targets.get("session", pin), original)
  assert.equal(targets.isCurrent("session", original), false)
})

test("evicting a newer inspection cannot reopen a superseded restart", () => {
  const targets = new DeveloperInspectionTargets()
  const identity = { endpoint: "http://127.0.0.1:10000", runId: "current", windowId: "window-B" }
  assert.equal(targets.canReconnect("session", "restart-A"), true)
  const pin = targets.begin("session")!(identity)
  assert.equal(targets.canReconnect("session", "restart-A"), false)
  for (let index = 0; index < 128; index++) targets.begin(`other-${index}`)!(identity)
  assert.equal(targets.get("session", pin), undefined)
  assert.equal(targets.canReconnect("session", "restart-A"), false)
  assert.equal(targets.begin("session", undefined, "restart-A"), undefined)
})
