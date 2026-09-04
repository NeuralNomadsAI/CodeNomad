import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createRoot, createSignal } from "solid-js"

import { useActiveSessionMessageLoad } from "./use-active-session-message-load.ts"

// Flush queued Solid effects plus the resolved-promise hydration/load chain.
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("useActiveSessionMessageLoad", () => {
  it("loads once on activation, ignores same-id session replacement, and reloads on id change or reactivation", async () => {
    const loads: Array<{ instanceId: string; sessionId: string }> = []
    const [session, setSession] = createSignal<{ id: string } | undefined>({ id: "a" })
    const [isActive, setIsActive] = createSignal(true)

    let dispose = () => {}
    createRoot((rootDispose) => {
      dispose = rootDispose
      useActiveSessionMessageLoad({
        isActive,
        instanceId: () => "inst",
        session,
        loadMessages: (instanceId, sessionId) => {
          loads.push({ instanceId, sessionId })
        },
        waitForHydration: () => Promise.resolve(),
      })
    })

    try {
      // 1. Initial active session triggers exactly one load.
      await tick()
      assert.deepEqual(loads, [{ instanceId: "inst", sessionId: "a" }])

      // 2. Replacing the session value with the SAME id (new object reference,
      //    as setSessions does on every metadata/status mutation) must NOT
      //    trigger another load — this is the regression the fix guards.
      setSession({ id: "a" })
      await tick()
      assert.equal(loads.length, 1, "same-id replacement must not reload")

      // A few more same-id replacements to simulate a refresh storm.
      setSession({ id: "a" })
      setSession({ id: "a" })
      await tick()
      assert.equal(loads.length, 1, "repeated same-id replacements must not reload")

      // 3a. A real session-id change triggers exactly one more load.
      setSession({ id: "b" })
      await tick()
      assert.deepEqual(loads, [
        { instanceId: "inst", sessionId: "a" },
        { instanceId: "inst", sessionId: "b" },
      ])

      // 3b. Deactivate then reactivate triggers exactly one more load.
      setIsActive(false)
      await tick()
      assert.equal(loads.length, 2, "deactivation must not load")
      setIsActive(true)
      await tick()
      assert.deepEqual(loads, [
        { instanceId: "inst", sessionId: "a" },
        { instanceId: "inst", sessionId: "b" },
        { instanceId: "inst", sessionId: "b" },
      ])
    } finally {
      dispose()
    }
  })

  it("does not load a session the user switched away from while metadata was hydrating", async () => {
    const loads: string[] = []
    const gate = deferred()
    const [session, setSession] = createSignal<{ id: string } | undefined>({ id: "a" })

    let dispose = () => {}
    createRoot((rootDispose) => {
      dispose = rootDispose
      useActiveSessionMessageLoad({
        isActive: () => true,
        instanceId: () => "inst",
        session,
        loadMessages: (_instanceId, sessionId) => {
          loads.push(sessionId)
        },
        waitForHydration: () => gate.promise,
      })
    })

    try {
      await tick()
      assert.deepEqual(loads, [], "load is gated behind hydration")

      // User switches to a different session before hydration resolves.
      setSession({ id: "b" })
      await tick()

      // Hydration for the original activation resolves now; its load must be
      // discarded because the active session id no longer matches.
      gate.resolve()
      await tick()
      await tick()

      // Only the current session ("b") should load, exactly once.
      assert.deepEqual(loads, ["b"])
    } finally {
      dispose()
    }
  })

})
