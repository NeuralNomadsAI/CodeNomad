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
    assert.deepEqual(harness.restored, [])
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), true)
  })

  it("does not tombstone a reused workspace after request cancellation", async () => {
    const item = { ...workspace("shared workspace", "restore-request"), reused: true }, harness = createHarness()
    harness.cleanup.beginRequest(item.requestId!)
    harness.cleanup.quarantineRequest(item.requestId!)
    assert.equal(harness.cleanup.trackPendingRequest(item), true)
    await flushPromises()
    assert.equal(harness.discardCalls, 1)
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), false)
  })

  it("forgets only the matching request for a shared workspace", () => {
    const leader = workspace("shared", "leader"), harness = createHarness()
    harness.cleanup.track(leader)
    harness.cleanup.forgetRequest(leader.id, "follower")
    assert.equal(harness.cleanup.get(leader.id)?.requestId, "leader")
    harness.cleanup.forgetRequest(leader.id, "leader")
    assert.equal(harness.cleanup.get(leader.id), undefined)
  })

  it("keeps a workspace user-owned when release succeeds during cancellation", async () => {
    const item = workspace("released-during-cancel", "restore-request"), harness = createHarness()
    harness.cleanup.track(item)
    let finishRelease!: () => void
    const release = harness.cleanup.releaseAfter(item.id, () => new Promise<void>((resolve) => { finishRelease = resolve }))
    await harness.cleanup.discardTracked(item.id, { retainTombstone: true })
    finishRelease()
    const released = await release
    harness.cleanup.track(item)
    await harness.cleanup.discardTracked(item.id, { retainTombstone: true })
    assert.equal(released?.id, item.id)
    assert.equal(harness.cleanup.owns(item.id), false)
    assert.equal(harness.discardCalls, 0)
  })

  it("restores cleanup ownership when server release fails", async () => {
    const item = workspace("failed-release", "restore-request"), harness = createHarness()
    harness.cleanup.track(item)
    await assert.rejects(harness.cleanup.releaseAfter(item.id, () => Promise.reject(new Error("release failed"))))
    assert.equal(harness.cleanup.owns(item.id), true)
    await harness.cleanup.discardTracked(item.id)
    assert.equal(harness.discardCalls, 1)
  })

  it("retries rejected cancellation and releases quarantine after success", async () => {
    const item = workspace("created"), harness = createHarness({ failures: 1, retryDelay: 25 })
    harness.cleanup.track(item)
    const completion = harness.cleanup.discardTracked(item.id)
    await flushPromises()
    assert.equal(harness.discardCalls, 1)
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), true)
    assert.deepEqual(harness.waits.map(({ delayMs }) => delayMs), [25])
    harness.waits[0]?.resolve(); await completion
    assert.equal(harness.discardCalls, 2)
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), false)
    assert.equal(harness.cleanup.owns(item.id), false)
    assert.deepEqual(harness.restored, [])
  })

  it("ignores matching events only while cancellation is pending", async () => {
    const item = workspace("created"), harness = createHarness({ pending: true })
    const completion = harness.cleanup.discardCreated(item)
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), true)
    assert.equal(harness.cleanup.shouldIgnoreEvent("pre-existing"), false)
    harness.finishDiscard(); await completion
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), false)
  })

  it("retains cancellation quarantine across delayed events and create resolution", async () => {
    const item = workspace("cancelled-restore"), harness = createHarness()
    harness.cleanup.track(item)
    await harness.cleanup.discardTracked(item.id, { retainTombstone: true })
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), true, "delayed created/started events stay quarantined")
    harness.cleanup.track(item)
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), true, "late create resolution stays quarantined")
    assert.equal(harness.cleanup.owns(item.id), true)
  })

  it("keeps failed cancellation correlation quarantined until late creation is reconciled", async () => {
    const item = workspace("late-after-failed-cancel", "failed-request"), harness = createHarness({ pending: true })
    harness.cleanup.beginRequest("failed-request"); harness.cleanup.quarantineRequest("failed-request")
    assert.equal(harness.cleanup.trackPendingRequest(item), true)
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), true, "late workspace.created is never admitted")
    harness.finishDiscard(); await flushPromises()
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), true, "reconciled creation retains its tombstone")
  })

  it("adopts an event-before-abort workspace into one bounded cleanup", async () => {
    const item = workspace("event-before-abort", "restore-request")
    const harness = createHarness({ failures: 1, retryDelay: 25 })
    harness.cleanup.beginRequest(item.requestId!)
    assert.equal(harness.cleanup.trackPendingRequest(item), true)

    const cleanup = harness.cleanup.quarantineRequest(item.requestId!)
    const duplicate = harness.cleanup.quarantineRequest(item.requestId!)
    await flushPromises()
    assert.equal(harness.discardCalls, 1, "quarantine does not start a parallel cancellation")
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), true)
    assert.deepEqual(harness.waits.map(({ delayMs }) => delayMs), [25])

    harness.waits[0]?.resolve()
    await Promise.all([cleanup, duplicate])
    assert.equal(harness.discardCalls, 2, "the failed delete is retried once")
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), true)
  })

  it("clears a durable tombstone only for explicit user-owned create correlation", async () => {
    const item = workspace("reused-id"), harness = createHarness()
    await harness.cleanup.discardCreated(item, { retainTombstone: true })
    harness.cleanup.track(item); harness.cleanup.release(item.id)
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), true, "ordinary track/release cannot clear tombstone")
    harness.cleanup.releaseTombstoneForUserCreate(item.id)
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), false)
    assert.equal(harness.cleanup.owns(item.id), false)
    harness.cleanup.releaseTombstoneForUserCreate("ordinary-user-workspace")
    assert.equal(harness.cleanup.owns("ordinary-user-workspace"), false)
  })

  it("restores a running workspace after bounded cancellation failures", async () => {
    const item = workspace("still-running"), harness = createHarness({ failures: 2, retryDelay: 50 })
    const completion = harness.cleanup.discardCreated(item)
    await flushPromises()
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), true)
    harness.waits[0]?.resolve(); await completion
    assert.equal(harness.discardCalls, 2)
    assert.deepEqual(harness.restored, [item])
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), false)
    assert.equal(harness.cleanup.owns(item.id), false)
  })

  it("restores the newest correlated descriptor after cancellation failures", async () => {
    const starting = { ...workspace("progressed", "request"), status: "starting" as const }
    const ready = { ...starting, status: "ready" as const }
    const harness = createHarness({ failures: 2, retryDelay: 50 })
    harness.cleanup.track(starting)
    const completion = harness.cleanup.discardTracked(starting.id)
    await flushPromises()
    harness.cleanup.track(ready)
    harness.waits[0]?.resolve(); await completion
    assert.equal(harness.discarded[1]?.status, "ready")
    assert.deepEqual(harness.restored, [ready])
  })

  it("never discards untracked or released workspaces", async () => {
    const harness = createHarness()
    await harness.cleanup.discardTracked("pre-existing")
    harness.cleanup.track(workspace("completed-restore")); harness.cleanup.release("completed-restore")
    harness.cleanup.track(workspace("completed-restore"))
    await harness.cleanup.discardTracked("completed-restore")
    assert.equal(harness.discardCalls, 0)
  })

  it("transfers a tracked workspace to user ownership before cleanup", async () => {
    const item = workspace("selected-during-restore", "restore-request"), harness = createHarness()
    harness.cleanup.track(item)
    assert.equal(harness.cleanup.release(item.id), item)
    await harness.cleanup.discardTracked(item.id, { retainTombstone: true })
    assert.equal(harness.cleanup.owns(item.id), false)
    assert.equal(harness.discardCalls, 0)
  })

  it("does not start a lazy release after explicit close owns cancellation", async () => {
    const item = workspace("closed-before-release", "restore-request")
    const harness = createHarness({ pending: true })
    harness.cleanup.track(item)
    const deletion = harness.cleanup.discardTracked(item.id, { retainTombstone: true })
    let releaseCalls = 0

    const released = await harness.cleanup.releaseAfter(item.id, async () => { releaseCalls += 1 })

    assert.equal(released, undefined)
    assert.equal(releaseCalls, 0)
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), true)
    harness.finishDiscard()
    await deletion
  })

  it("correlates created before resolution and quarantines explicit-close races", async () => {
    const item = { ...workspace("slow-restore", "restore-request"), status: "starting" as const }
    const harness = createHarness({ pending: true })
    harness.cleanup.beginRequest("restore-request")
    assert.equal(harness.cleanup.trackPendingRequest(item), true)
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), false, "initial correlated created event is accepted")
    const deletion = harness.cleanup.discardTracked(item.id, { retainTombstone: true })
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), true, "started event and create resolution are quarantined")
    assert.equal(harness.discardCalls, 1)
    harness.finishDiscard(); await deletion; harness.cleanup.finishRequest("restore-request")
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), true, "late created/started events stay quarantined")
    harness.cleanup.track(item)
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), true, "late create resolution stays quarantined")
    assert.equal(harness.cleanup.owns(item.id), true)
  })

  it("releases explicit-close quarantine after failed deletion reconciliation", async () => {
    const item = workspace("reconcile", "request"), harness = createHarness({ failures: 2, retryDelay: 10 })
    harness.cleanup.beginRequest("request"); assert.equal(harness.cleanup.trackPendingRequest(item), true)
    const completion = harness.cleanup.discardTracked(item.id, { retainTombstone: true })
    await flushPromises()
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), true)
    harness.waits[0]?.resolve(); await completion
    assert.deepEqual(harness.restored, [item])
    assert.equal(harness.cleanup.shouldIgnoreEvent(item.id), false)
    assert.equal(harness.cleanup.owns(item.id), false)
  })
})
