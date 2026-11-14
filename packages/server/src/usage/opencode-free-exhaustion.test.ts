import assert from "node:assert/strict"
import test from "node:test"
import type { ServiceConnection } from "../workspaces/opencode-service"
import { createOpenCodeFreeExhaustion } from "./opencode-free-exhaustion"

const midnight = Date.UTC(2026, 10, 6)
const connection = () => ({}) as ServiceConnection
const start = (created: number, model = "big-pickle", message = "m", session = "s", providerID = "opencode") => ({
  type: "session.step.started", created, data: { sessionID: session, assistantMessageID: message, model: { providerID, id: model } },
})
const fail = (created: number, message = "m", session = "s", type = "provider.quota") => ({
  type: "session.step.failed", created, data: { sessionID: session, assistantMessageID: message, error: { type } },
})

test("exhaustion expires exactly at next UTC midnight; duplicates and old failures never extend it", () => {
  const state = createOpenCodeFreeExhaustion(), c = connection()
  state.observe(c, start(midnight - 3), midnight - 1)
  state.observe(c, fail(midnight - 2), midnight - 1)
  assert.equal(state.exhausted(c, midnight - 1), true)
  assert.equal(state.exhausted(c, midnight), false)
  state.observe(c, fail(midnight + 1), midnight + 1)
  assert.equal(state.exhausted(c, midnight + 1), false, "duplicate message cannot extend")
  state.observe(c, start(midnight - 4, "x-free", "late"), midnight + 1)
  state.observe(c, fail(midnight - 3, "late"), midnight + 1)
  assert.equal(state.exhausted(c, midnight + 1), false, "previous UTC day ended")
  state.observe(c, start(midnight, "x-free", "new"), midnight + 1)
  state.observe(c, fail(midnight + 1, "new"), midnight + 1)
  state.observe(c, fail(midnight - 2), midnight + 1)
  assert.equal(state.exhausted(c, midnight + 86_400_000 - 1), true)
  assert.equal(state.exhausted(c, midnight + 86_400_000), false)
  assert.equal(state.exhausted(c, midnight + 86_400_001), false)
})

test("capture is per connection/session/message and ignores the session's subsequent model", () => {
  const state = createOpenCodeFreeExhaustion(), a = connection(), b = connection()
  state.observe(a, start(midnight), midnight + 5)
  state.observe(a, { type: "session.model.selected", data: { model: { providerID: "opencode", id: "paid" } } }, midnight + 5)
  state.observe(a, fail(midnight + 1, "other"), midnight + 5)
  state.observe(b, fail(midnight + 1), midnight + 5)
  assert.equal(state.exhausted(a, midnight + 5), false)
  state.observe(a, fail(midnight + 1), midnight + 5)
  assert.equal(state.exhausted(a, midnight + 5), true)
  assert.equal(state.exhausted(b, midnight + 5), false)
  state.observe(b, start(midnight, "paid"), midnight + 5)
  state.observe(b, fail(midnight + 1), midnight + 5)
  assert.equal(state.exhausted(b, midnight + 5), false)
  state.observe(b, start(midnight, "x-free", "another", "another-session"), midnight + 5)
  state.observe(b, fail(midnight + 2, "another", "another-session"), midnight + 5)
  assert.equal(state.exhausted(b, midnight + 5), true)
  state.dispose()
  assert.equal(state.exhausted(a, midnight + 5), false)
})

test("paid/auth/network/execution-only/missing/ambiguous/malformed attribution never marks", () => {
  for (const variant of ["paid", "auth", "network", "execution", "missing", "ambiguous", "oversize", "foreign", "before-start", "future"]) {
    const state = createOpenCodeFreeExhaustion(), c = connection()
    if (variant !== "missing") state.observe(c, start(midnight, variant === "paid" ? "paid" : "big-pickle", "m", "s",
      variant === "foreign" ? "other" : "opencode"), midnight + 5)
    if (variant === "ambiguous") state.observe(c, start(midnight, "paid"), midnight + 5)
    const event = fail(variant === "before-start" ? midnight - 1 : variant === "future" ? midnight + 6 : midnight + 1,
      variant === "oversize" ? "m".repeat(513) : "m", "s", variant === "auth" ? "provider.auth" : variant === "network" ? "provider.network" : "provider.quota")
    if (variant === "execution") event.type = "session.execution.failed"
    state.observe(c, event, midnight + 5)
    assert.equal(state.exhausted(c, midnight + 5), false, variant)
  }
})

test("bounded step memo evicts old attribution conservatively", () => {
  const state = createOpenCodeFreeExhaustion(), c = connection()
  for (let i = 0; i <= 1024; i++) state.observe(c, start(midnight, "big-pickle", String(i)), midnight + 5)
  state.observe(c, fail(midnight + 1, "0"), midnight + 5)
  assert.equal(state.exhausted(c, midnight + 5), false)
  state.observe(c, fail(midnight + 1, "1024"), midnight + 5)
  assert.equal(state.exhausted(c, midnight + 5), true)
})
