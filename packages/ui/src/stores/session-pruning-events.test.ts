import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { handlePruningEvent } from "./session-pruning-events"
import { advanceMessageLoadEpoch, isCurrentMessageLoad, setSessions } from "./session-state"
import type { Session } from "../types/session"

const event = { type: "rpc.codenomad.session-pruning.pruned", data: { sessionID: "s", messageID: "m", revision: "a".repeat(64) } }
afterEach(() => setSessions(new Map()))

test("RPC invalidation reaches each logical instance without removing a session", () => {
  setSessions(new Map(["a", "b"].map(id => [id, new Map([["s", { id: "s", instanceId: id } as Session]])])))
  const first = advanceMessageLoadEpoch("a", "s")
  const second = advanceMessageLoadEpoch("b", "s")
  assert.equal(handlePruningEvent("a", event), true)
  assert.equal(isCurrentMessageLoad("a", "s", first), false)
  assert.equal(isCurrentMessageLoad("b", "s", second), true)
  handlePruningEvent("b", event)
  assert.equal(isCurrentMessageLoad("b", "s", second), false)
})

test("ignores unknown RPCs, malformed payloads and sessions outside this instance", () => {
  setSessions(new Map([["a", new Map([["s", { id: "s", instanceId: "a" } as Session]])]]))
  const epoch = advanceMessageLoadEpoch("a", "s")
  assert.equal(handlePruningEvent("a", { ...event, type: "rpc.other.pruned" }), false)
  assert.equal(handlePruningEvent("a", { ...event, data: {} }), true)
  handlePruningEvent("b", event)
  assert.equal(isCurrentMessageLoad("a", "s", epoch), true)
})
