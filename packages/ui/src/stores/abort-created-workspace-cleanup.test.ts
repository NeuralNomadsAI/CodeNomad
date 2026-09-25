import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { AbortCreatedWorkspaceCleanup } from "./abort-created-workspace-cleanup.ts"

interface TestWorkspace { id: string; status: "starting" | "ready"; requestId?: string; reused?: boolean }
const workspace = (id: string, requestId?: string): TestWorkspace => ({ id, status: "ready", requestId })
async function flushPromises() { await Promise.resolve(); await Promise.resolve() }

function createHarness(options: { failures?: number; pending?: boolean; retryDelay?: number } = {}) {
  let discardCalls = 0
  let finishDiscard: (() => void) | undefined
  const discarded: TestWorkspace[] = []
  const waits: Array<{ delayMs: number; resolve: () => void }> = []
  const restored: TestWorkspace[] = []
  const cleanup = new AbortCreatedWorkspaceCleanup<TestWorkspace>({
    discardWorkspace: async (item) => {
      discardCalls += 1
      discarded.push(item)
      if (options.pending) await new Promise<void>((resolve) => { finishDiscard = resolve })
      if (discardCalls <= (options.failures ?? 0)) throw new Error("server unavailable")
    },
    restoreWorkspace: (value) => restored.push(value),
    retryDelaysMs: options.retryDelay === undefined ? [] : [options.retryDelay],
    wait: (delayMs) => new Promise<void>((resolve) => waits.push({ delayMs, resolve })),
  })
  return {
    cleanup, discarded, restored, waits,
    get discardCalls() { return discardCalls },
    finishDiscard: () => finishDiscard?.(),
  }
}

describe("abort-created workspace cleanup", () => {
  it("late creation cancellation cannot leak a restore-created workspace", async () => {
    const item = workspace("late creation", "restore-request")
    const harness = createHarness()
    harness.cleanup.beginRequest(item.requestId!)
    assert.equal(harness.cleanup.trackPendingRequest(item), true)
    await harness.cleanup.discardTracked(item.id, { retainTombstone: true })
    harness.cleanup.finishRequest(item.requestId!)

    assert.equal(harness.discardCalls, 1)
    assert.equal(harness.discarded[0]?.requestId, "restore-request")
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), true)
  })

  it("does not tombstone a reused workspace after request cancellation", async () => {
    const item = { ...workspace("shared workspace", "restore-request"), reused: true }
    const harness = createHarness()
    harness.cleanup.beginRequest(item.requestId!)
    harness.cleanup.quarantineRequest(item.requestId!)
    assert.equal(harness.cleanup.trackPendingRequest(item), true)
    await flushPromises()

    assert.equal(harness.discardCalls, 1)
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), false)
  })

  it("adopts an event-before-abort workspace into one bounded cleanup", async () => {
    const item = workspace("event-before-abort", "restore-request")
    const harness = createHarness({ failures: 1, retryDelay: 25 })
    harness.cleanup.beginRequest(item.requestId!)
    assert.equal(harness.cleanup.trackPendingRequest(item), true)

    const cleanup = harness.cleanup.quarantineRequest(item.requestId!)
    const duplicate = harness.cleanup.quarantineRequest(item.requestId!)
    await flushPromises()
    assert.equal(harness.discardCalls, 1)
    harness.waits[0]?.resolve()
    await Promise.all([cleanup, duplicate])
    assert.equal(harness.discardCalls, 2)
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), true)
  })

  it("restores the newest descriptor after bounded cancellation failures", async () => {
    const starting = { ...workspace("progressed", "request"), status: "starting" as const }
    const ready = { ...starting, status: "ready" as const }
    const harness = createHarness({ failures: 2, retryDelay: 50 })
    harness.cleanup.track(starting)
    const completion = harness.cleanup.discardTracked(starting.id)
    await flushPromises()
    harness.cleanup.track(ready)
    harness.waits[0]?.resolve()
    await completion

    assert.equal(harness.discarded[1]?.status, "ready")
    assert.deepEqual(harness.restored, [ready])
  })

  it("quarantines created and started events after explicit close", async () => {
    const item = { ...workspace("slow-restore", "restore-request"), status: "starting" as const }
    const harness = createHarness({ pending: true })
    harness.cleanup.beginRequest("restore-request")
    assert.equal(harness.cleanup.trackPendingRequest(item), true)
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), false)

    const deletion = harness.cleanup.discardTracked(item.id, { retainTombstone: true })
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), true)
    harness.finishDiscard()
    await deletion
    harness.cleanup.finishRequest("restore-request")
    harness.cleanup.track(item)
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), true)
  })

  it("transfers cleanup ownership only after release succeeds", async () => {
    const item = workspace("released-during-cancel", "restore-request")
    const harness = createHarness()
    harness.cleanup.track(item)
    let finishRelease!: () => void
    const release = harness.cleanup.releaseAfter(item.id, () => new Promise<void>((resolve) => { finishRelease = resolve }))
    await harness.cleanup.discardTracked(item.id, { retainTombstone: true })
    finishRelease()
    assert.equal((await release)?.id, item.id)
    assert.equal(harness.cleanup.owns(item.id), false)
    assert.equal(harness.discardCalls, 0)

    const failed = workspace("failed-release", "restore-request")
    harness.cleanup.track(failed)
    await assert.rejects(harness.cleanup.releaseAfter(failed.id, () => Promise.reject(new Error("release failed"))))
    assert.equal(harness.cleanup.owns(failed.id), true)
  })
})
