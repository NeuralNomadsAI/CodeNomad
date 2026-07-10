import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { AbortCreatedWorkspaceCleanup } from "./abort-created-workspace-cleanup.ts"

interface TestWorkspace {
  id: string
  status: "starting" | "ready"
  requestId?: string
}

function createManualWait() {
  const waits: Array<{ delayMs: number; resolve: () => void }> = []
  return {
    waits,
    wait: (delayMs: number) => new Promise<void>((resolve) => waits.push({ delayMs, resolve })),
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe("abort-created workspace cleanup", () => {
  it("retries when the first delete rejects and releases quarantine after a later success", async () => {
    const workspace: TestWorkspace = { id: "created", status: "ready" }
    const manualWait = createManualWait()
    let deleteCalls = 0
    const restored: TestWorkspace[] = []
    const cleanup = new AbortCreatedWorkspaceCleanup<TestWorkspace>({
      deleteWorkspace: async () => {
        deleteCalls += 1
        if (deleteCalls === 1) throw new Error("temporary network failure")
      },
      restoreWorkspace: (value) => restored.push(value),
      retryDelaysMs: [25],
      wait: manualWait.wait,
    })

    cleanup.track(workspace)
    const completion = cleanup.discardTracked(workspace.id)
    await flushPromises()

    assert.equal(deleteCalls, 1)
    assert.equal(cleanup.shouldIgnoreEvent(workspace.id), true)
    assert.deepEqual(manualWait.waits.map((entry) => entry.delayMs), [25])

    manualWait.waits[0]?.resolve()
    await completion

    assert.equal(deleteCalls, 2)
    assert.equal(cleanup.shouldIgnoreEvent(workspace.id), false)
    assert.equal(cleanup.owns(workspace.id), false)
    assert.deepEqual(restored, [])
  })

  it("ignores matching events only while delete cleanup is pending", async () => {
    const workspace: TestWorkspace = { id: "created", status: "ready" }
    const appliedEvents: string[] = []
    let finishDelete!: () => void
    const cleanup = new AbortCreatedWorkspaceCleanup<TestWorkspace>({
      deleteWorkspace: () => new Promise<void>((resolve) => {
        finishDelete = resolve
      }),
      restoreWorkspace: () => undefined,
    })

    const completion = cleanup.discardCreated(workspace)
    if (!cleanup.shouldIgnoreEvent(workspace.id)) appliedEvents.push("workspace.started while pending")
    assert.equal(cleanup.shouldIgnoreEvent(workspace.id), true)
    assert.equal(cleanup.shouldIgnoreEvent("pre-existing"), false)
    assert.equal(appliedEvents.length, 0)

    finishDelete()
    await completion

    if (!cleanup.shouldIgnoreEvent(workspace.id)) appliedEvents.push("workspace.started after cleanup")
    assert.equal(cleanup.shouldIgnoreEvent(workspace.id), false)
    assert.deepEqual(appliedEvents, ["workspace.started after cleanup"])
  })

  it("retains cancellation quarantine after delete and ignores delayed events and resolution", async () => {
    const workspace: TestWorkspace = { id: "cancelled-restore", status: "ready" }
    const appliedEvents: string[] = []
    const cleanup = new AbortCreatedWorkspaceCleanup<TestWorkspace>({
      deleteWorkspace: async () => undefined,
      restoreWorkspace: () => undefined,
    })

    cleanup.track(workspace)
    await cleanup.discardTracked(workspace.id, { retainTombstone: true })

    if (!cleanup.shouldIgnoreEvent(workspace.id)) appliedEvents.push("delayed workspace.created")
    if (!cleanup.shouldIgnoreEvent(workspace.id)) appliedEvents.push("delayed workspace.started")
    cleanup.track(workspace)
    if (!cleanup.shouldIgnoreEvent(workspace.id)) appliedEvents.push("late create resolution")

    assert.deepEqual(appliedEvents, [])
    assert.equal(cleanup.shouldIgnoreEvent(workspace.id), true)
    assert.equal(cleanup.owns(workspace.id), true)
  })

  it("clears a durable tombstone only for an explicit user-owned create correlation", async () => {
    const workspace: TestWorkspace = { id: "reused-id", status: "ready" }
    const cleanup = new AbortCreatedWorkspaceCleanup<TestWorkspace>({
      deleteWorkspace: async () => undefined,
      restoreWorkspace: () => undefined,
    })

    await cleanup.discardCreated(workspace, { retainTombstone: true })
    cleanup.track(workspace)
    assert.equal(cleanup.shouldIgnoreEvent(workspace.id), true)

    cleanup.release(workspace.id)
    assert.equal(cleanup.shouldIgnoreEvent(workspace.id), true)

    cleanup.releaseTombstoneForUserCreate(workspace.id)
    assert.equal(cleanup.shouldIgnoreEvent(workspace.id), false)
    assert.equal(cleanup.owns(workspace.id), false)

    cleanup.releaseTombstoneForUserCreate("ordinary-user-workspace")
    assert.equal(cleanup.shouldIgnoreEvent("ordinary-user-workspace"), false)
    assert.equal(cleanup.owns("ordinary-user-workspace"), false)
  })

  it("restores a running workspace and releases quarantine after bounded delete failures", async () => {
    const workspace: TestWorkspace = { id: "still-running", status: "ready" }
    const manualWait = createManualWait()
    const restored: TestWorkspace[] = []
    let deleteCalls = 0
    const cleanup = new AbortCreatedWorkspaceCleanup<TestWorkspace>({
      deleteWorkspace: async () => {
        deleteCalls += 1
        throw new Error("server unavailable")
      },
      restoreWorkspace: (value) => restored.push(value),
      retryDelaysMs: [50],
      wait: manualWait.wait,
    })

    const completion = cleanup.discardCreated(workspace)
    await flushPromises()
    assert.equal(cleanup.shouldIgnoreEvent(workspace.id), true)

    manualWait.waits[0]?.resolve()
    await completion

    assert.equal(deleteCalls, 2)
    assert.deepEqual(restored, [workspace])
    assert.equal(cleanup.shouldIgnoreEvent(workspace.id), false)
    assert.equal(cleanup.owns(workspace.id), false)
  })

  it("never deletes a workspace that was not tracked as restore-created", async () => {
    let deleteCalls = 0
    const cleanup = new AbortCreatedWorkspaceCleanup<TestWorkspace>({
      deleteWorkspace: async () => {
        deleteCalls += 1
      },
      restoreWorkspace: () => undefined,
    })

    await cleanup.discardTracked("pre-existing")
    cleanup.track({ id: "completed-restore", status: "ready" })
    cleanup.release("completed-restore")
    await cleanup.discardTracked("completed-restore")

    assert.equal(deleteCalls, 0)
  })

  it("correlates a created event before create resolves and quarantines explicit close", async () => {
    const workspace: TestWorkspace = {
      id: "slow-restore",
      status: "starting",
      requestId: "restore-request",
    }
    let finishDelete!: () => void
    let deleteCalls = 0
    const applied: string[] = []
    const cleanup = new AbortCreatedWorkspaceCleanup<TestWorkspace>({
      deleteWorkspace: () => {
        deleteCalls += 1
        return new Promise<void>((resolve) => {
          finishDelete = resolve
        })
      },
      restoreWorkspace: () => undefined,
    })

    cleanup.beginRequest("restore-request")
    assert.equal(cleanup.trackPendingRequest(workspace), true)
    if (!cleanup.shouldIgnoreEvent(workspace.id)) applied.push("workspace.created")

    const deletion = cleanup.discardTracked(workspace.id, { retainTombstone: true })
    if (!cleanup.shouldIgnoreEvent(workspace.id)) applied.push("workspace.started")
    if (!cleanup.shouldIgnoreEvent(workspace.id)) applied.push("create resolution")
    assert.equal(deleteCalls, 1)
    assert.deepEqual(applied, ["workspace.created"])

    finishDelete()
    await deletion
    cleanup.finishRequest("restore-request")

    if (!cleanup.shouldIgnoreEvent(workspace.id)) applied.push("late workspace.created")
    if (!cleanup.shouldIgnoreEvent(workspace.id)) applied.push("late workspace.started")
    cleanup.track(workspace)
    if (!cleanup.shouldIgnoreEvent(workspace.id)) applied.push("late create resolution")
    assert.deepEqual(applied, ["workspace.created"])
    assert.equal(cleanup.owns(workspace.id), true)
  })

  it("releases explicit-close quarantine only after bounded deletion failure reconciliation", async () => {
    const workspace: TestWorkspace = { id: "reconcile", status: "ready", requestId: "request" }
    const manualWait = createManualWait()
    const restored: TestWorkspace[] = []
    const cleanup = new AbortCreatedWorkspaceCleanup<TestWorkspace>({
      deleteWorkspace: async () => {
        throw new Error("server unavailable")
      },
      restoreWorkspace: (value) => restored.push(value),
      retryDelaysMs: [10],
      wait: manualWait.wait,
    })

    cleanup.beginRequest("request")
    cleanup.trackPendingRequest(workspace)
    const completion = cleanup.discardTracked(workspace.id, { retainTombstone: true })
    await flushPromises()
    assert.equal(cleanup.shouldIgnoreEvent(workspace.id), true)

    manualWait.waits[0]?.resolve()
    await completion
    assert.deepEqual(restored, [workspace])
    assert.equal(cleanup.shouldIgnoreEvent(workspace.id), false)
    assert.equal(cleanup.owns(workspace.id), false)
  })
})
