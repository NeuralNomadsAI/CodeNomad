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
  it("confirmed settlement during backoff prevents a further cancellation attempt", async () => {
    let attempts = 0, resume!: () => void
    const cleanup = new AbortCreatedWorkspaceCleanup<TestWorkspace>({
      requestKey: item => item.requestId,
      discardWorkspace: async () => {},
      restoreWorkspace: () => {},
      retryDelaysMs: [1],
      wait: () => new Promise<void>(resolve => { resume = resolve }),
    })
    const flight = cleanup.cancelRequest("request", async () => {
      attempts++
      throw new Error("lost cancel response")
    })
    assert.equal(cleanup.cancelRequest("request", async () => { attempts++ }), flight)
    await flushPromises()
    cleanup.settleRequest("request")
    resume()
    await flight
    await cleanup.cancelRequest("request", async () => { attempts++ })
    assert.equal(attempts, 1)
  })

  it("committed claims retire same-attachment work while passive observations cannot replace them", async () => {
    const old = { ...workspace("a~w", "old"), key: "old" }, next = { ...workspace("a~w", "next"), key: "next" }
    const discarded: string[] = [], restored: string[] = []
    let finish!: () => void
    const cleanup = new AbortCreatedWorkspaceCleanup<typeof old>({
      requestKey: w => w.key, isCurrent: () => true, retryDelaysMs: [],
      discardWorkspace: async w => { discarded.push(w.key); await new Promise<void>(resolve => { finish = resolve }); throw new Error("offline") },
      restoreWorkspace: w => { restored.push(w.key) },
    })
    cleanup.track(old)
    const cancelled = cleanup.discardCreated(old)
    cleanup.trackCommitted(next)
    cleanup.track(old)
    assert.equal(cleanup.get(next.id), next)
    assert.equal(cleanup.shouldIgnoreObservation(old.id, old.key), true)
    cleanup.trackCommitted(old)
    assert.equal(cleanup.get(next.id), next, "an obsolete commit preserves the current claim")
    assert.equal(cleanup.shouldIgnoreEvent(next.id, next.key), false)
    finish(); await cancelled
    assert.deepEqual(discarded, ["old"])
    assert.deepEqual(restored, [])
    assert.equal(cleanup.get(next.id), next)
    cleanup.trackCommitted({ ...next, requestId: undefined, key: "ordinary" })
    assert.equal(cleanup.get(next.id), undefined, "an ordinary replacement owns no creation claim")
    await cleanup.releaseAfter(old.id, async w => { assert.equal(w, old) }, old.key)
    assert.equal(cleanup.shouldIgnoreObservation(old.id, old.key), true)
    cleanup.track(old)
    assert.equal(cleanup.get(old.id), undefined)
    assert.equal(cleanup.isReleased(next.id, next.key), false)
  })
  it("settles a retired cleanup independently of the replacement claim with the same UI key", async () => {
    let owner = "old", finish!: () => void
    const old = { ...workspace("B~w", "r"), owner: "old" }
    const next = { ...old, owner: "new" }
    const discarded: string[] = [], restored: string[] = []
    const cleanup = new AbortCreatedWorkspaceCleanup<typeof old>({
      requestKey: value => `${value.owner}/${value.requestId}`,
      isCurrent: value => value.owner === owner,
      discardWorkspace: async value => {
        discarded.push(value.owner)
        await new Promise<void>(resolve => { finish = resolve })
        throw new Error("old proof revoked")
      },
      restoreWorkspace: value => { restored.push(value.owner) }, retryDelaysMs: [],
    })
    cleanup.track(old)
    const pending = cleanup.discardTracked(old.id)
    owner = "new"
    cleanup.track(next)
    assert.equal(cleanup.get(next.id), next)
    finish(); await pending
    assert.deepEqual(discarded, ["old"])
    assert.deepEqual(restored, [])
    assert.equal(cleanup.get(next.id), next)
    await cleanup.releaseAfter(next.id, async value => { assert.equal(value, next) })
    assert.equal(cleanup.isReleased(next.id, "new/r"), true)
  })

  it("late failed release restores only its retired marker, never a released replacement", async () => {
    let owner = "old", reject!: (error: Error) => void
    const old = { ...workspace("B~w", "r"), owner: "old" }, next = { ...old, owner: "new" }
    const cleanup = new AbortCreatedWorkspaceCleanup<typeof old>({
      requestKey: value => `${value.owner}/${value.requestId}`, isCurrent: value => value.owner === owner,
      discardWorkspace: async () => {}, restoreWorkspace: () => false, retryDelaysMs: [],
    })
    cleanup.track(old)
    const failed = assert.rejects(cleanup.releaseAfter(old.id, () => new Promise<void>((_resolve, no) => { reject = no })))
    owner = "new"
    cleanup.track(next)
    await cleanup.releaseAfter(next.id, async value => { assert.equal(value, next) })
    reject(new Error("old proof revoked")); await failed
    assert.equal(cleanup.isReleased(next.id, "new/r"), true)
    assert.equal(cleanup.isReleased(old.id, "old/r"), false)
    await cleanup.releaseAfter(old.id, async value => { assert.equal(value, old) }, "old/r")
    assert.equal(cleanup.isReleased(old.id, "old/r"), true)
    assert.equal(cleanup.isReleased(next.id, "new/r"), true)
  })
  it("retains unknown settlement when the original attachment cannot restore UI", async () => {
    const original = { ...workspace("B~w", "r"), owner: "original" }
    const discarded: typeof original[] = []
    const cleanup = new AbortCreatedWorkspaceCleanup<typeof original>({
      requestKey: value => `${value.owner}/${value.requestId}`,
      discardWorkspace: async value => { discarded.push(value); throw new Error("revoked authority") },
      restoreWorkspace: () => false,
      retryDelaysMs: [],
    })
    cleanup.track(original)
    cleanup.track({ ...original, owner: "replacement" })
    await cleanup.discardTracked(original.id)
    assert.equal(cleanup.get(original.id), original)
    assert.equal(cleanup.owns(original.id), true)
    assert.deepEqual(discarded, [original])
    await assert.rejects(cleanup.releaseAfter(original.id, async value => {
      assert.equal(value, original)
      throw new Error("still revoked")
    }))
    assert.equal(cleanup.get(original.id), original)
  })
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
    assert.equal(harness.cleanup.get(ready.id), ready, "UI restoration must retain the unsettled creation claim")
    await harness.cleanup.releaseAfter(ready.id, async value => { assert.equal(value, ready) })
    assert.equal(harness.cleanup.owns(ready.id), false)
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
