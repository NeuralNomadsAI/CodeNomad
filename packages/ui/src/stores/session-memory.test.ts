import assert from "node:assert/strict"
import test from "node:test"
import { createRoot, createSignal } from "solid-js"
import {
  getPromptDisplayOverride,
  resetPromptDisplayOverrideStateForTests,
  setPromptDisplayOverride,
} from "./message-prompt-display.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { MAX_HOT_SESSION_MESSAGE_BYTES } from "../lib/session-memory-budget.ts"
import { evictResidentSessionMessages, getVisibleSessionMemoryIds, runSessionMemorySweep, setVisibleSessionMemory } from "./session-memory.ts"
import { setSessions } from "./session-state.ts"
import { useSessionCache } from "../components/instance/shell/useSessionCache.ts"

function addMessage(instanceId: string, sessionId: string, status: "complete" | "streaming" = "complete", text = sessionId.repeat(100)) {
  messageStoreBus.getOrCreate(instanceId).upsertMessage({
    id: `${sessionId}-message`,
    sessionId,
    role: "assistant",
    status,
    parts: [{ id: `${sessionId}-part`, type: "text", text }] as any,
  })
}

const settleMeasurements = () => new Promise((resolve) => setTimeout(resolve, 75))

test("mounted cached views stay protected until they unmount", async () => {
  const instanceId = "memory-six-session-cache"
  const sessionIds = Array.from({ length: 6 }, (_, index) => `session-${index + 1}`)
  const [activeSessionId, setActiveSessionId] = createSignal<string | null>(sessionIds[0]!)
  const [visible, setVisible] = createSignal(true)
  let dispose!: () => void
  try {
    sessionIds.forEach((sessionId) => addMessage(instanceId, sessionId))
    const cache = createRoot((rootDispose) => {
      dispose = rootDispose
      return useSessionCache({
        instanceId: () => instanceId,
        instanceSessions: () => new Map(sessionIds.map((sessionId) => [sessionId, {}])),
        activeSessionId,
        visible,
      })
    })
    for (const sessionId of sessionIds.slice(1)) setActiveSessionId(sessionId)
    await Promise.resolve()

    assert.deepEqual(cache.cachedSessionIds(), sessionIds.slice(1).reverse())
    assert.deepEqual(getVisibleSessionMemoryIds(instanceId), sessionIds.slice(1))
    assert.equal(evictResidentSessionMessages(instanceId, sessionIds[1]!), false)
    assert.equal(evictResidentSessionMessages(instanceId, sessionIds[0]!), true)

    setVisible(false)
    await Promise.resolve()
    assert.deepEqual(cache.cachedSessionIds(), [])
    assert.deepEqual(getVisibleSessionMemoryIds(instanceId), [])
    await settleMeasurements()
    assert.deepEqual(
      runSessionMemorySweep(0).map((key) => key.split("\u0000")[1]),
      sessionIds.slice(1),
    )
  } finally {
    dispose?.()
    messageStoreBus.unregisterInstance(instanceId)
  }
})

test("resident eviction purges prompt-display overrides from memory and persistence", () => {
  const instanceId = "memory-prompt-display", sessionId = "session", messageId = `${sessionId}-message`
  const entries = new Map<string, string>()
  const originalWindow = (globalThis as any).window
  ;(globalThis as any).window = { localStorage: {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
  } }
  resetPromptDisplayOverrideStateForTests()
  try {
    addMessage(instanceId, sessionId)
    setPromptDisplayOverride(instanceId, sessionId, messageId, { segments: [{ kind: "pasted", length: 100 }] })

    assert.equal(evictResidentSessionMessages(instanceId, sessionId), true)
    assert.equal(getPromptDisplayOverride(instanceId, sessionId, messageId), undefined)
    assert.deepEqual(JSON.parse(entries.get("codenomad:prompt-display:v3") ?? "{}"), {})

    resetPromptDisplayOverrideStateForTests()
    assert.equal(getPromptDisplayOverride(instanceId, sessionId, messageId), undefined)
  } finally {
    messageStoreBus.unregisterInstance(instanceId)
    resetPromptDisplayOverrideStateForTests()
    if (originalWindow === undefined) delete (globalThis as any).window
    else (globalThis as any).window = originalWindow
  }
})

test("resident message budget evicts globally across five workspaces while preserving visible and streaming sessions", async () => {
  const instanceIds = Array.from({ length: 5 }, (_, index) => `memory-workspace-${index}`)
  try {
    for (const instanceId of instanceIds) {
      addMessage(instanceId, "parent")
      addMessage(instanceId, "subagent")
    }
    addMessage(instanceIds[0], "streaming", "streaming")
    setVisibleSessionMemory(instanceIds[4], "parent", true)
    await settleMeasurements()

    const evicted = runSessionMemorySweep(0)

    assert.equal(evicted.length, 9)
    assert.deepEqual(messageStoreBus.getInstance(instanceIds[4])!.getSessionMessageIds("parent"), ["parent-message"])
    assert.deepEqual(messageStoreBus.getInstance(instanceIds[0])!.getSessionMessageIds("streaming"), ["streaming-message"])
    assert.deepEqual(messageStoreBus.getInstance(instanceIds[0])!.getSessionMessageIds("parent"), [])
    assert.deepEqual(messageStoreBus.getInstance(instanceIds[0])!.getSessionMessageIds("subagent"), [])
  } finally {
    setVisibleSessionMemory(instanceIds[4], "parent", false)
    for (const instanceId of instanceIds) messageStoreBus.unregisterInstance(instanceId)
  }
})

test("visible session leases keep a child resident until every visible owner releases it", async () => {
  const instanceId = "memory-visible-leases", sessionId = "child"
  try {
    addMessage(instanceId, sessionId)
    setVisibleSessionMemory(instanceId, sessionId, true)
    setVisibleSessionMemory(instanceId, sessionId, true)
    setVisibleSessionMemory(instanceId, sessionId, false)
    await settleMeasurements()

    assert.deepEqual(runSessionMemorySweep(0), [])
    setVisibleSessionMemory(instanceId, sessionId, false)
    assert.deepEqual(runSessionMemorySweep(0), [`${instanceId}\u0000${sessionId}`])
  } finally {
    setVisibleSessionMemory(instanceId, sessionId, false)
    messageStoreBus.unregisterInstance(instanceId)
  }
})

test("authoritative working status protects a resident session", async () => {
  const instanceId = "memory-working-status", sessionId = "session"
  try {
    addMessage(instanceId, sessionId)
    await settleMeasurements()
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, { id: sessionId, status: "working" } as any]])))
    assert.deepEqual(runSessionMemorySweep(0), [])

    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, { id: sessionId, status: "idle" } as any]])))
    assert.deepEqual(runSessionMemorySweep(0), [`${instanceId}\u0000${sessionId}`])
  } finally {
    setSessions((prev) => { const next = new Map(prev); next.delete(instanceId); return next })
    messageStoreBus.unregisterInstance(instanceId)
  }
})

test("memory sweeps never synchronously measure resident transcripts", async () => {
  const instanceId = "memory-visible-measurement", sessionId = "session", hiddenSessionId = "hidden"
  const store = messageStoreBus.getOrCreate(instanceId)
  const measure = store.getSessionApproximateByteSizeIncrementally
  try {
    addMessage(instanceId, sessionId)
    addMessage(instanceId, hiddenSessionId)
    setVisibleSessionMemory(instanceId, sessionId, true)
    ;(store as any).getSessionApproximateByteSizeIncrementally = () => { throw new Error("sweep started a measurement") }
    assert.deepEqual(runSessionMemorySweep(0), [])
    ;(store as any).getSessionApproximateByteSizeIncrementally = measure
    await settleMeasurements()
    assert.deepEqual(runSessionMemorySweep(0), [`${instanceId}\u0000${hiddenSessionId}`])
  } finally {
    ;(store as any).getSessionApproximateByteSizeIncrementally = measure
    setVisibleSessionMemory(instanceId, sessionId, false)
    messageStoreBus.unregisterInstance(instanceId)
  }
})

test("protected memory still contributes to the global eviction budget", async () => {
  const instanceId = "memory-protected-budget", visibleSessionId = "visible", hiddenSessionId = "hidden"
  try {
    addMessage(instanceId, visibleSessionId)
    addMessage(instanceId, hiddenSessionId)
    const store = messageStoreBus.getOrCreate(instanceId)
    const byteLimit = Math.max(
      await store.getSessionApproximateByteSizeIncrementally(visibleSessionId),
      await store.getSessionApproximateByteSizeIncrementally(hiddenSessionId),
    )
    setVisibleSessionMemory(instanceId, visibleSessionId, true)
    await settleMeasurements()

    assert.deepEqual(runSessionMemorySweep(byteLimit), [`${instanceId}\u0000${hiddenSessionId}`])
    assert.deepEqual(store.getSessionMessageIds(visibleSessionId), [`${visibleSessionId}-message`])
  } finally {
    setVisibleSessionMemory(instanceId, visibleSessionId, false)
    messageStoreBus.unregisterInstance(instanceId)
  }
})

test("deferred measurement refreshes a protected session after it grows", async () => {
  const instanceId = "memory-protected-refresh", visibleSessionId = "visible", hiddenSessionId = "hidden"
  const originalRequestIdleCallback = (globalThis as any).requestIdleCallback
  const originalCancelIdleCallback = (globalThis as any).cancelIdleCallback
  const callbacks: Array<() => void> = []
  ;(globalThis as any).requestIdleCallback = (callback: () => void) => { callbacks.push(callback); return callbacks.length }
  ;(globalThis as any).cancelIdleCallback = () => undefined
  try {
    addMessage(instanceId, visibleSessionId)
    setVisibleSessionMemory(instanceId, visibleSessionId, true)
    callbacks.shift()?.()
    await new Promise<void>((resolve) => setImmediate(resolve))
    addMessage(instanceId, hiddenSessionId)
    callbacks.shift()?.()
    await new Promise<void>((resolve) => setImmediate(resolve))

    const store = messageStoreBus.getOrCreate(instanceId)
    const initialLimit = await store.getSessionApproximateByteSizeIncrementally(visibleSessionId) +
      await store.getSessionApproximateByteSizeIncrementally(hiddenSessionId)
    assert.deepEqual(runSessionMemorySweep(initialLimit), [])

    addMessage(instanceId, visibleSessionId, "complete", "x".repeat(100_000))
    callbacks.shift()?.()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(runSessionMemorySweep(initialLimit), [`${instanceId}\u0000${hiddenSessionId}`])
  } finally {
    ;(globalThis as any).requestIdleCallback = originalRequestIdleCallback
    ;(globalThis as any).cancelIdleCallback = originalCancelIdleCallback
    setVisibleSessionMemory(instanceId, visibleSessionId, false)
    messageStoreBus.unregisterInstance(instanceId)
  }
})

test("a hidden session remains evictable from its previous measurement while remeasurement is pending", async () => {
  const instanceId = "memory-pending-remeasurement", sessionId = "hidden"
  const originalRequestIdleCallback = (globalThis as any).requestIdleCallback
  const originalCancelIdleCallback = (globalThis as any).cancelIdleCallback
  try {
    addMessage(instanceId, sessionId, "complete", "x".repeat(100_000))
    await settleMeasurements()

    let pendingMeasurement: (() => void) | undefined
    ;(globalThis as any).requestIdleCallback = (callback: () => void) => { pendingMeasurement = callback; return 1 }
    ;(globalThis as any).cancelIdleCallback = () => { pendingMeasurement = undefined }
    addMessage(instanceId, sessionId, "complete", "new content")

    assert.equal(typeof pendingMeasurement, "function")
    assert.deepEqual(runSessionMemorySweep(0), [`${instanceId}\u0000${sessionId}`])
  } finally {
    ;(globalThis as any).requestIdleCallback = originalRequestIdleCallback
    ;(globalThis as any).cancelIdleCallback = originalCancelIdleCallback
    messageStoreBus.unregisterInstance(instanceId)
  }
})

test("hidden growth crossing the budget remains evictable while remeasurement is pending", async () => {
  const instanceId = "memory-growth-crosses-budget", sessionId = "hidden"
  const originalRequestIdleCallback = (globalThis as any).requestIdleCallback
  const originalCancelIdleCallback = (globalThis as any).cancelIdleCallback
  let pendingMeasurement: (() => void) | undefined
  try {
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, { id: sessionId, status: "idle" } as any]])))
    addMessage(instanceId, sessionId, "complete", "small")
    await settleMeasurements()

    ;(globalThis as any).requestIdleCallback = (callback: () => void) => { pendingMeasurement = callback; return 1 }
    ;(globalThis as any).cancelIdleCallback = () => { pendingMeasurement = undefined }
    addMessage(instanceId, sessionId, "complete", "x".repeat(Math.ceil(MAX_HOT_SESSION_MESSAGE_BYTES / 6) + 1_000))

    const store = messageStoreBus.getOrCreate(instanceId)
    assert.ok(await store.getSessionApproximateByteSizeIncrementally(sessionId) > MAX_HOT_SESSION_MESSAGE_BYTES)
    assert.equal(typeof pendingMeasurement, "function")
    assert.deepEqual(runSessionMemorySweep(), [`${instanceId}\u0000${sessionId}`])
    assert.deepEqual(store.getSessionMessageIds(sessionId), [])
  } finally {
    ;(globalThis as any).requestIdleCallback = originalRequestIdleCallback
    ;(globalThis as any).cancelIdleCallback = originalCancelIdleCallback
    setSessions((prev) => { const next = new Map(prev); next.delete(instanceId); return next })
    messageStoreBus.unregisterInstance(instanceId)
  }
})

test("superseded protected measurements abort and cannot publish stale bytes", async () => {
  const instanceId = "memory-measurement-generation", visibleSessionId = "visible", hiddenSessionId = "hidden"
  const originalRequestIdleCallback = (globalThis as any).requestIdleCallback
  const originalCancelIdleCallback = (globalThis as any).cancelIdleCallback
  const callbacks = new Map<number, () => void>()
  let nextHandle = 0
  ;(globalThis as any).requestIdleCallback = (callback: () => void) => {
    const handle = ++nextHandle
    callbacks.set(handle, callback)
    return handle
  }
  ;(globalThis as any).cancelIdleCallback = (handle: number) => callbacks.delete(handle)
  const runNext = () => {
    const entry = callbacks.entries().next().value as [number, () => void] | undefined
    assert.ok(entry)
    callbacks.delete(entry[0])
    entry[1]()
  }
  try {
    addMessage(instanceId, visibleSessionId)
    setVisibleSessionMemory(instanceId, visibleSessionId, true)
    runNext()
    await new Promise<void>((resolve) => setImmediate(resolve))
    addMessage(instanceId, hiddenSessionId)
    runNext()
    await new Promise<void>((resolve) => setImmediate(resolve))

    const store = messageStoreBus.getOrCreate(instanceId)
    const originalMeasure = store.getSessionApproximateByteSizeIncrementally
    let firstSignal: AbortSignal | undefined
    let resolveStale!: (bytes: number) => void
    let calls = 0
    ;(store as any).getSessionApproximateByteSizeIncrementally = (_sessionId: string, signal?: AbortSignal) => {
      calls += 1
      if (calls === 1) {
        firstSignal = signal
        return new Promise<number>((resolve) => { resolveStale = resolve })
      }
      return Promise.resolve(1)
    }

    addMessage(instanceId, visibleSessionId)
    runNext()
    addMessage(instanceId, visibleSessionId)
    assert.equal(firstSignal?.aborted, true)
    runNext()
    await new Promise<void>((resolve) => setImmediate(resolve))
    resolveStale(1_000_000)
    await new Promise<void>((resolve) => setImmediate(resolve))

    const limit = await originalMeasure.call(store, hiddenSessionId) + 1
    assert.deepEqual(runSessionMemorySweep(limit), [])
    ;(store as any).getSessionApproximateByteSizeIncrementally = originalMeasure
  } finally {
    ;(globalThis as any).requestIdleCallback = originalRequestIdleCallback
    ;(globalThis as any).cancelIdleCallback = originalCancelIdleCallback
    setVisibleSessionMemory(instanceId, visibleSessionId, false)
    messageStoreBus.unregisterInstance(instanceId)
  }
})

test("instance teardown aborts an in-flight protected measurement", async () => {
  const instanceId = "memory-measurement-teardown", sessionId = "session"
  const originalRequestIdleCallback = (globalThis as any).requestIdleCallback
  const originalCancelIdleCallback = (globalThis as any).cancelIdleCallback
  let callback: (() => void) | undefined
  ;(globalThis as any).requestIdleCallback = (next: () => void) => { callback = next; return 1 }
  ;(globalThis as any).cancelIdleCallback = () => undefined
  try {
    addMessage(instanceId, sessionId)
    const store = messageStoreBus.getOrCreate(instanceId)
    let signal: AbortSignal | undefined
    ;(store as any).getSessionApproximateByteSizeIncrementally = (_sessionId: string, nextSignal?: AbortSignal) => {
      signal = nextSignal
      return new Promise<number>(() => undefined)
    }
    callback?.()
    messageStoreBus.unregisterInstance(instanceId)
    assert.equal(signal?.aborted, true)
  } finally {
    ;(globalThis as any).requestIdleCallback = originalRequestIdleCallback
    ;(globalThis as any).cancelIdleCallback = originalCancelIdleCallback
    messageStoreBus.unregisterInstance(instanceId)
  }
})

test("idle metadata cannot evict a normalized streaming message", async () => {
  const instanceId = "memory-idle-streaming", sessionId = "session"
  try {
    addMessage(instanceId, sessionId, "streaming")
    await settleMeasurements()
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, { id: sessionId, status: "idle" } as any]])))
    assert.deepEqual(runSessionMemorySweep(0), [])

    addMessage(instanceId, sessionId, "complete")
    await settleMeasurements()
    assert.deepEqual(runSessionMemorySweep(0), [`${instanceId}\u0000${sessionId}`])
  } finally {
    setSessions((prev) => { const next = new Map(prev); next.delete(instanceId); return next })
    messageStoreBus.unregisterInstance(instanceId)
  }
})

test("interruption-only sessions contribute protected bytes to the global budget", async () => {
  const instanceId = "memory-pending-only", pendingSessionId = "pending", hiddenSessionId = "hidden"
  try {
    addMessage(instanceId, hiddenSessionId)
    const store = messageStoreBus.getOrCreate(instanceId)
    store.upsertQuestion({
      request: {
        id: "large-question",
        sessionID: pendingSessionId,
        questions: [{ header: "Confirm", question: "q".repeat(100_000), options: [] }],
      } as any,
      enqueuedAt: 1,
    })
    await new Promise((resolve) => setTimeout(resolve, 75))

    const limit = await store.getSessionApproximateByteSizeIncrementally(pendingSessionId)
    assert.ok(store.getResidentSessionIds().includes(pendingSessionId))
    assert.deepEqual(runSessionMemorySweep(limit), [`${instanceId}\u0000${hiddenSessionId}`])
  } finally {
    messageStoreBus.unregisterInstance(instanceId)
  }
})
