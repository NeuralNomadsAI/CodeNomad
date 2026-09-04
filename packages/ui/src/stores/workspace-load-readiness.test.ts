import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { waitForLatestWorkspaceLoadResult } from "./workspace-load-readiness.ts"

describe("workspace load readiness", () => {
  function createLoadTracker(initial: Promise<{ error?: unknown }>) {
    let latest = initial
    const listeners = new Set<() => void>()
    return {
      getLatest: () => latest,
      setLatest(next: Promise<{ error?: unknown }>) {
        latest = next
        listeners.forEach((listener) => listener())
      },
      waitForChange(current: Promise<{ error?: unknown }>, signal?: AbortSignal) {
        if (latest !== current) return Promise.resolve()
        return new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            listeners.delete(onChange)
            signal?.removeEventListener("abort", onAbort)
          }
          const onChange = () => { cleanup(); resolve() }
          const onAbort = () => { cleanup(); reject(signal?.reason) }
          listeners.add(onChange)
          signal?.addEventListener("abort", onAbort, { once: true })
        })
      },
    }
  }

  it("uses a newer successful reconnect instead of failing restore with the stale initial error", async () => {
    let resolveInitial!: (result: { error?: unknown }) => void
    const initial = new Promise<{ error?: unknown }>((resolve) => { resolveInitial = resolve })
    const reconnect = Promise.resolve({})
    const tracker = createLoadTracker(initial)

    const ready = waitForLatestWorkspaceLoadResult(initial, tracker.getLatest, tracker.waitForChange)
    tracker.setLatest(reconnect)
    resolveInitial({ error: new Error("cold start failed") })

    await ready
  })

  it("reports an error when the latest authoritative load fails", async () => {
    const error = new Error("workspace API unavailable")
    const failed = Promise.resolve({ error })
    const tracker = createLoadTracker(failed)

    await assert.rejects(waitForLatestWorkspaceLoadResult(failed, tracker.getLatest, tracker.waitForChange), error)
  })

  it("does not remain blocked on a stale hanging initial request", async () => {
    const initial = new Promise<{ error?: unknown }>(() => {})
    const reconnect = Promise.resolve({})
    const tracker = createLoadTracker(initial)
    const ready = waitForLatestWorkspaceLoadResult(initial, tracker.getLatest, tracker.waitForChange)

    tracker.setLatest(reconnect)

    await ready
  })

  it("stops waiting when restore is cancelled", async () => {
    const initial = new Promise<{ error?: unknown }>(() => {})
    const tracker = createLoadTracker(initial)
    const controller = new AbortController()
    const ready = waitForLatestWorkspaceLoadResult(
      initial, tracker.getLatest, tracker.waitForChange, controller.signal,
    )

    controller.abort(new Error("restore cancelled"))

    await assert.rejects(ready, /restore cancelled/)
  })
})
