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
  it("cancels hidden reads and releases their authority before an immediate return", async () => {
    const [active, setActive] = createSignal(true)
    const requests: AbortSignal[] = [], invalidations: number[] = [], errors: unknown[] = []
    const gate = deferred()
    let dispose = () => {}
    createRoot(done => {
      dispose = done
      useActiveSessionMessageLoad({ isActive: active, instanceId: () => 'inst', session: () => ({ id: 'a' }),
        waitForHydration: async () => {}, onError: error => errors.push(error),
        loadMessages: (_instance, _session, options) => {
          const index = requests.length
          requests.push(options!.signal!)
          options!.registerInvalidation!(() => invalidations.push(index))
          return gate.promise.then(() => options!.signal!.throwIfAborted())
        },
      })
    })
    try {
      await tick()
      setActive(false)
      assert.equal(requests[0].aborted, true)
      assert.deepEqual(invalidations, [0])
      setActive(true)
      await tick()
      assert.equal(requests.length, 2)
      assert.equal(requests[1].aborted, false)
      gate.resolve()
      await tick()
      setActive(false)
      assert.deepEqual(invalidations, [0], 'completed snapshots keep their loaded flag')
      assert.deepEqual(errors, [], 'intentional cancellation is not a load failure')
    } finally { gate.resolve(); dispose() }
  })

  it("does not revive the first hydration callback after an away-and-back cycle", async () => {
    const [active, setActive] = createSignal(true)
    const gate = deferred(), loads: string[] = []
    let dispose = () => {}
    createRoot(done => {
      dispose = done
      useActiveSessionMessageLoad({ isActive: active, instanceId: () => 'inst', session: () => ({ id: 'a' }),
        waitForHydration: () => gate.promise, loadMessages: (_instance, session) => { loads.push(session) } })
    })
    try {
      await tick()
      setActive(false)
      setActive(true)
      gate.resolve()
      await tick()
      assert.deepEqual(loads, ['a'])
    } finally { dispose() }
  })

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
