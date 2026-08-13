import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { SessionTranscriptMeasurementQueue } from "./session-transcript-measurement.ts"

const deferred = () => {
  let resolve!: (value: number) => void
  const promise = new Promise<number>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("session transcript measurement queue", () => {
  it("starts measurement on the original deadline despite repeated mutations", (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] })
    const measurements: AbortSignal[] = []
    const queue = new SessionTranscriptMeasurementQueue({
      delayMs: 100,
      measure: (_instanceId, _sessionId, signal) => {
        measurements.push(signal)
        return new Promise<number>(() => {})
      },
      account: () => {},
      onError: () => {},
    })

    queue.schedule("instance", "session")
    for (let elapsed = 10; elapsed < 100; elapsed += 10) {
      context.mock.timers.tick(10)
      queue.schedule("instance", "session")
    }
    context.mock.timers.tick(10)

    assert.equal(measurements.length, 1)
    assert.equal(measurements[0]?.aborted, false)
  })

  it("discards a dirty result and accounts the follow-up measurement", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] })
    const measurements = [deferred(), deferred()]
    const accounted: number[] = []
    const signals: AbortSignal[] = []
    let measurementIndex = 0
    const queue = new SessionTranscriptMeasurementQueue({
      delayMs: 100,
      measure: (_instanceId, _sessionId, signal) => {
        signals.push(signal)
        return measurements[measurementIndex++]!.promise
      },
      account: (_instanceId, _sessionId, bytes) => accounted.push(bytes),
      onError: () => {},
    })

    queue.schedule("instance", "session")
    context.mock.timers.tick(100)
    queue.schedule("instance", "session")
    assert.equal(signals[0]?.aborted, true)
    measurements[0].resolve(10)
    await Promise.resolve()
    assert.deepEqual(accounted, [])

    context.mock.timers.tick(100)
    measurements[1].resolve(20)
    await Promise.resolve()
    assert.deepEqual(accounted, [20])
  })

  it("accounts terminal measurement failures conservatively", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] })
    const accounted: number[] = []
    const errors: unknown[] = []
    const queue = new SessionTranscriptMeasurementQueue({
      delayMs: 100,
      measure: async () => { throw new Error("measurement failed") },
      account: (_instanceId, _sessionId, bytes) => accounted.push(bytes),
      onError: (_instanceId, _sessionId, error) => errors.push(error),
    })

    queue.schedule("instance", "session")
    context.mock.timers.tick(100)
    await Promise.resolve()

    assert.deepEqual(accounted, [Number.POSITIVE_INFINITY])
    assert.equal(errors.length, 1)
  })

  it("replaces a known estimate with conservative accounting after a later failure", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] })
    const accounted: number[] = []
    let attempt = 0
    const queue = new SessionTranscriptMeasurementQueue({
      delayMs: 100,
      measure: async () => {
        attempt += 1
        if (attempt === 1) return 10
        throw new Error("measurement failed")
      },
      account: (_instanceId, _sessionId, bytes) => accounted.push(bytes),
      onError: () => {},
    })

    queue.schedule("instance", "session")
    context.mock.timers.tick(100)
    await Promise.resolve()
    queue.schedule("instance", "session")
    context.mock.timers.tick(100)
    await Promise.resolve()

    assert.deepEqual(accounted, [10, Number.POSITIVE_INFINITY])
  })

  it("accounts conservatively even when error reporting fails", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] })
    const accounted: number[] = []
    const queue = new SessionTranscriptMeasurementQueue({
      delayMs: 100,
      measure: async () => { throw new Error("measurement failed") },
      account: (_instanceId, _sessionId, bytes) => accounted.push(bytes),
      onError: () => { throw new Error("logger failed") },
    })

    queue.schedule("instance", "session")
    context.mock.timers.tick(100)
    await Promise.resolve()

    assert.deepEqual(accounted, [Number.POSITIVE_INFINITY])
  })
})
