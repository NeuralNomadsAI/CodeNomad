import assert from "node:assert/strict"
import test from "node:test"

import { SessionTranscriptMeasurementQueue } from "./session-transcript-measurement.ts"
import { isSessionTranscriptProtected, SessionTranscriptLru, selectTranscriptEvictions, type TranscriptLruEntry } from "./session-transcript-lru.ts"

const entry = (sessionId: string, bytes: number, lastUsed: number): TranscriptLruEntry => ({
  instanceId: "instance", sessionId, bytes, lastUsed,
})

test("measures, accounts, touches, and enforces transcript LRU order", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const evicted: string[] = []
  const lru = new SessionTranscriptLru({
    byteBudget: 12,
    isProtected: () => false,
    evict: (_instanceId, sessionId) => evicted.push(sessionId),
  })
  const queue = new SessionTranscriptMeasurementQueue({
    delayMs: 1,
    measure: async () => 6,
    account: (instanceId, sessionId, bytes) => lru.account(instanceId, sessionId, bytes),
    onError: () => {},
  })

  for (const sessionId of ["old", "new"]) {
    lru.touch("instance", sessionId)
    queue.schedule("instance", sessionId)
    context.mock.timers.tick(1)
    await Promise.resolve()
  }
  lru.touch("instance", "old")
  queue.schedule("instance", "latest")
  context.mock.timers.tick(1)
  await Promise.resolve()
  lru.enforce()

  assert.deepEqual(evicted, ["new"])
})

test("protects active and live transcripts despite temporary budget overage", () => {
  const entries = [entry("visible", 4, 1), entry("live", 4, 2), entry("inactive", 4, 3)]
  assert.deepEqual(selectTranscriptEvictions(entries, 1, ({ sessionId }) => isSessionTranscriptProtected(
    sessionId === "visible" ? { visible: true } : sessionId === "live" ? { liveMessages: true } : {},
  )).map(({ sessionId }) => sessionId), ["inactive"])
})
