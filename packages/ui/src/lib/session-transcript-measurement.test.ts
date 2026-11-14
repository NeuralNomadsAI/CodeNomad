import assert from "node:assert/strict"
import test from "node:test"

import { SessionTranscriptMeasurementQueue } from "./session-transcript-measurement.ts"

test("reschedules the delayed measurement while pending, one walk after activity stops", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  let measured = 0
  const queue = new SessionTranscriptMeasurementQueue({
    delayMs: 100,
    measure: async () => {
      measured += 1
      return 10
    },
    account: () => {},
    onError: () => {},
  })

  queue.schedule("instance", "session")
  context.mock.timers.tick(80)
  // Activity continues (a burst of cache commits): the quiet delay restarts
  // instead of admitting a full retained-graph walk mid-burst.
  queue.schedule("instance", "session")
  context.mock.timers.tick(80)
  await Promise.resolve()
  assert.equal(measured, 0)
  context.mock.timers.tick(20)
  await Promise.resolve()
  assert.equal(measured, 1)
})

test("aborts an in-flight measurement when scheduled again", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const aborted: boolean[] = []
  let release: ((value: number) => void) | undefined
  const queue = new SessionTranscriptMeasurementQueue({
    delayMs: 1,
    measure: (_instanceId, _sessionId, signal) =>
      new Promise<number>((resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted.push(signal.aborted)
          reject(signal.reason)
        })
        release = resolve
      }),
    account: () => {},
    onError: () => {},
  })

  queue.schedule("instance", "session")
  context.mock.timers.tick(1)
  await Promise.resolve()
  // A new schedule while the walk is running aborts it and re-arms the delay.
  queue.schedule("instance", "session")
  assert.deepEqual(aborted, [true])
  release?.(6)
  context.mock.timers.tick(1)
  await Promise.resolve()
})
