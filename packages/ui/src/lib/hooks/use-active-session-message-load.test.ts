import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
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

  it("waits for a mounted child session to be registered, then loads it once", async () => {
    const loads: string[] = []
    const [session, setSession] = createSignal<{ id: string } | undefined>()
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
        waitForHydration: () => Promise.resolve(),
      })
    })

    try {
      await tick()
      assert.deepEqual(loads, [], "an unregistered child must not load")
      setSession({ id: "child" })
      await tick()
      assert.deepEqual(loads, ["child"], "registration must reactively trigger the load")
      setSession({ id: "child" })
      await tick()
      assert.deepEqual(loads, ["child"], "same-id session updates must not loop")
    } finally {
      dispose()
    }
  })

  it("reloads a still-mounted transcript after its loaded state is invalidated", async () => {
    const [loaded, setLoaded] = createSignal(false)
    let loads = 0
    let dispose = () => {}
    createRoot((rootDispose) => {
      dispose = rootDispose
      useActiveSessionMessageLoad({
        isActive: () => true,
        instanceId: () => "inst",
        session: () => ({ id: "child" }),
        shouldLoad: () => !loaded(),
        loadMessages: () => {
          loads += 1
          setLoaded(true)
        },
        waitForHydration: () => Promise.resolve(),
      })
    })

    try {
      await tick()
      assert.equal(loads, 1)
      setLoaded(false)
      await tick()
      assert.equal(loads, 2, "invalidation must reload without remounting")
    } finally {
      dispose()
    }
  })

  it("retains mounted child transcripts and releases them on cleanup", () => {
    const source = readFileSync(new URL("../../components/tool-call/renderers/task.tsx", import.meta.url), "utf8")
    assert.match(source, /setSessionTranscriptVisible\(instanceId, id, true\)/)
    assert.match(source, /onCleanup\(\(\) => setSessionTranscriptVisible\(instanceId, id, false\)\)/)
    assert.match(source, /sessions\(\)\.get\(instanceId\)\?\.get\(id\)/)
    assert.match(source, /shouldLoad: \(\) =>/)
    assert.match(source, /getSessionMessagesLoadError\(instanceId, id\)/)
    assert.match(source, /loadMessages\(instanceId, id, \{ force: true \}\)/)
    assert.match(source, /onRetry=\{retryChildSessionLoad\}/)
    assert.doesNotMatch(source, /requestedChildLoad/)
  })

  it("invalidates pending loads on session, workspace, visibility, and unmount changes", async () => {
    const invalidated: string[] = []
    const [instanceId, setInstanceId] = createSignal("one")
    const [session, setSession] = createSignal<{ id: string } | undefined>({ id: "a" })
    const [active, setActive] = createSignal(true)
    let dispose = () => {}
    createRoot((rootDispose) => {
      dispose = rootDispose
      useActiveSessionMessageLoad({
        isActive: active,
        instanceId,
        session,
        loadMessages: (workspace, sessionId, options) => {
          options?.registerInvalidation?.(() => invalidated.push(`${workspace}:${sessionId}`))
          return new Promise<void>(() => {})
        },
        waitForHydration: () => Promise.resolve(),
      })
    })

    await tick()
    setSession({ id: "b" })
    await tick()
    setInstanceId("two")
    await tick()
    setActive(false)
    await tick()
    setActive(true)
    await tick()
    dispose()

    assert.deepEqual(invalidated, ["one:a", "one:b", "two:b", "two:b"])
  })
})
