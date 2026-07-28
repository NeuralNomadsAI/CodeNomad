import assert from "node:assert/strict"
import test from "node:test"
import { acceptInstanceStreamId } from "./sse-manager.ts"

test("instance stream ids reject events from a replaced runtime", () => {
  const streams = new Map<string, string>()
  assert.equal(acceptInstanceStreamId(streams, "instance", "old"), true)
  assert.equal(acceptInstanceStreamId(streams, "instance", "new"), false)
  assert.equal(acceptInstanceStreamId(streams, "instance", "new", true), true)
  assert.equal(acceptInstanceStreamId(streams, "instance", "old"), false)
})
