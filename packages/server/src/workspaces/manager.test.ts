import assert from "node:assert/strict"
import { describe, it } from "node:test"
import pino from "pino"

import { EventBus } from "../events/bus"
import {
  WorkspaceWindowsTreeCleanupIncompleteError,
  type ProcessExitInfo,
  type WorkspaceRuntime,
} from "./runtime"
import {
  WorkspaceCleanupTimeoutError,
  WorkspaceLaunchCancelledError,
  WorkspaceLaunchTimeoutError,
  WorkspaceManager,
  WorkspaceShutdownError,
} from "./manager"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

class ControlledRuntime {
  readonly launchResult = deferred<Awaited<ReturnType<WorkspaceRuntime["launch"]>>>()
  readonly launchCalled = deferred<string>()
  readonly active = new Set<string>()
  stopCalls = 0
  failStops = 0
  onExit?: (info: ProcessExitInfo) => void

  launch: WorkspaceRuntime["launch"] = (options) => {
    this.active.add(options.workspaceId)
    this.onExit = options.onExit
    this.launchCalled.resolve(options.workspaceId)
    options.signal?.addEventListener("abort", () => this.launchResult.reject(options.signal?.reason), { once: true })
    return this.launchResult.promise
  }

  stop: WorkspaceRuntime["stop"] = async (workspaceId) => {
    this.stopCalls += 1
    if (this.failStops-- > 0) throw new Error("controlled stop failure")
    this.active.delete(workspaceId)
  }

  resolveLaunch(): void {
    this.launchResult.resolve({
      pid: 1234,
      port: 4321,
      exitPromise: new Promise<ProcessExitInfo>(() => undefined),
      getLastOutput: () => "",
    })
  }
}

function createHarness(options: {
  shutdownTimeoutMs?: number
  launchTimeoutMs?: number
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void
} = {}) {
  const eventBus = new EventBus()
  const runtime = new ControlledRuntime()
  const readiness = deferred<string | undefined>()
  const started: string[] = []
  const stopped: string[] = []
  eventBus.on("workspace.started", (event) => started.push(event.workspace.id))
  eventBus.on("workspace.stopped", (event) => stopped.push(event.workspaceId))
  const manager = new WorkspaceManager({
    rootDir: process.cwd(),
    settings: { getOwner: () => ({}) } as never,
    binaryResolver: { resolve: () => ({ path: "test-opencode", label: "test-opencode" }) } as never,
    eventBus,
    logger: pino({ level: "silent" }),
    getServerBaseUrl: () => "http://127.0.0.1:4000",
    runtime,
    ...options,
  })
  ;(manager as any).waitForWorkspaceReadiness = ({ signal }: { signal?: AbortSignal }) => Promise.race([
    readiness.promise,
    new Promise<never>((_resolve, reject) => {
      const cancel = () => reject(signal?.reason)
      signal?.addEventListener("abort", cancel, { once: true })
      if (signal?.aborted) cancel()
    }),
  ])
  return { manager, runtime, readiness, started, stopped }
}

async function createReady(harness: ReturnType<typeof createHarness>) {
  const creation = harness.manager.create(process.cwd())
  const workspaceId = await harness.runtime.launchCalled.promise
  harness.runtime.resolveLaunch()
  harness.readiness.resolve(undefined)
  await creation
  return workspaceId
}

describe("workspace manager lifecycle", () => {
  for (const boundary of ["launch", "readiness", "shutdown"] as const) {
    it(`cancels and cleans a workspace during ${boundary}`, async () => {
      const harness = createHarness()
      const creation = harness.manager.create(process.cwd())
      const workspaceId = await harness.runtime.launchCalled.promise
      let cleanup: Promise<unknown>
      if (boundary === "readiness") {
        harness.runtime.resolveLaunch()
        await new Promise<void>((resolve) => setImmediate(resolve))
        cleanup = harness.manager.delete(workspaceId)
      } else {
        cleanup = boundary === "shutdown" ? harness.manager.shutdown() : harness.manager.delete(workspaceId)
        harness.runtime.resolveLaunch()
      }

      await assert.rejects(creation, WorkspaceLaunchCancelledError)
      await cleanup
      assert.deepEqual([harness.runtime.active.size, harness.started, harness.manager.list(), harness.stopped],
        [0, [], [], boundary === "readiness" ? [workspaceId] : []])
    })
  }

  it("shares failed cleanup and allows a later delete retry", async () => {
    const harness = createHarness()
    const workspaceId = await createReady(harness)
    harness.runtime.failStops = 2

    const first = harness.manager.delete(workspaceId)
    const concurrent = harness.manager.delete(workspaceId)
    assert.strictEqual(first, concurrent)
    const failures = await Promise.allSettled([first, concurrent])
    assert.deepEqual(failures.map((result) => result.status), ["rejected", "rejected"])
    assert.equal(harness.runtime.active.has(workspaceId), true)

    await harness.manager.delete(workspaceId)
    assert.equal(harness.runtime.active.has(workspaceId), false)
    assert.equal(harness.manager.get(workspaceId), undefined)
  })

  it("retries cancellation deletion for an already-cancelled request", async () => {
    const harness = createHarness()
    const creation = harness.manager.create(process.cwd(), undefined, { requestId: "retry-cancel" })
    const workspaceId = await harness.runtime.launchCalled.promise
    harness.runtime.resolveLaunch()
    harness.readiness.resolve(undefined)
    await creation
    harness.runtime.failStops = 2

    await assert.rejects(harness.manager.cancelCreationRequest("retry-cancel"), /controlled stop failure/)
    assert.equal(harness.manager.get(workspaceId)?.id, workspaceId)
    assert.equal(harness.runtime.active.has(workspaceId), true)

    await harness.manager.cancelCreationRequest("retry-cancel")
    assert.equal(harness.manager.get(workspaceId), undefined)
    assert.equal(harness.runtime.active.has(workspaceId), false)
    assert.deepEqual(harness.stopped, [workspaceId])
  })

  it("retains more than 1024 unresolved pre-creation cancellations", async () => {
    const harness = createHarness()
    const requestIds = Array.from({ length: 1_025 }, (_, index) => `pending-cancel-${index}`)
    await Promise.all(requestIds.map((requestId) => harness.manager.cancelCreationRequest(requestId)))

    assert.equal((harness.manager as any).cancelledCreationRequests.size, requestIds.length)
    await assert.rejects(
      harness.manager.create(process.cwd(), undefined, { requestId: requestIds[0] }),
      /was cancelled/,
    )
    assert.equal((harness.manager as any).cancelledCreationRequests.has(requestIds[0]), false)
    assert.equal((harness.manager as any).cancelledCreationRequests.size, requestIds.length - 1)
  })

  it("returns scoped correlation while an ordinary shared launch remains retained", async () => {
    const harness = createHarness()
    const ordinary = harness.manager.create(process.cwd())
    const workspaceId = await harness.runtime.launchCalled.promise
    const scoped = harness.manager.create(process.cwd(), undefined, { requestId: "restore-shared" })
    harness.runtime.resolveLaunch()
    harness.readiness.resolve(undefined)

    const [ordinaryResult, scopedResult] = await Promise.all([ordinary, scoped])
    assert.equal(ordinaryResult.created, true)
    assert.equal(ordinaryResult.workspace.requestId, undefined)
    assert.equal(scopedResult.created, false)
    assert.equal(scopedResult.workspace.id, workspaceId)
    assert.equal(scopedResult.workspace.requestId, "restore-shared")

    assert.equal(harness.manager.releaseCreationRequest(workspaceId, "restore-shared"), true)
    assert.equal(harness.manager.get(workspaceId)?.id, workspaceId)
    assert.equal(harness.runtime.active.has(workspaceId), true)

    const reused = await harness.manager.create(process.cwd(), undefined, { requestId: "restore-reused" })
    assert.equal(reused.workspace.requestId, "restore-reused")
    await harness.manager.cancelCreationRequest("restore-reused")
    assert.equal(harness.manager.get(workspaceId)?.id, workspaceId)
    assert.equal(harness.runtime.active.has(workspaceId), true)
  })

  for (const boundary of ["runtime launch", "health readiness"] as const) {
    it(`applies one shared end-to-end deadline during ${boundary} and cleans up`, async () => {
      const deadlines: Array<() => void> = []
      const harness = createHarness({
        launchTimeoutMs: 25,
        setTimeout: ((callback: () => void) => {
          const timer = { active: true }
          deadlines.push(() => { if (timer.active) callback() })
          return timer as unknown as ReturnType<typeof setTimeout>
        }) as typeof setTimeout,
        clearTimeout: ((timer: { active: boolean }) => { timer.active = false }) as unknown as typeof clearTimeout,
      })
      const first = harness.manager.create(process.cwd(), undefined, { requestId: "deadline-one" })
      const workspaceId = await harness.runtime.launchCalled.promise
      const shared = harness.manager.create(process.cwd(), undefined, { requestId: "deadline-two" })
      while ([...(harness.manager as any).pendingWorkspaceCreations.values()][0]?.ownership.size !== 2) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      if (boundary === "health readiness") {
        harness.runtime.resolveLaunch()
        await new Promise<void>((resolve) => setImmediate(resolve))
      }

      for (const fire of deadlines) fire()
      const outcomes = await Promise.allSettled([first, shared])
      assert.deepEqual(outcomes.map((outcome) => outcome.status), ["rejected", "rejected"])
      assert.ok(outcomes.every((outcome) => outcome.status === "rejected" && outcome.reason instanceof WorkspaceLaunchTimeoutError))
      assert.strictEqual((outcomes[0] as PromiseRejectedResult).reason, (outcomes[1] as PromiseRejectedResult).reason)
      assert.equal(harness.runtime.active.has(workspaceId), false)
      assert.equal(harness.runtime.stopCalls >= 1, true)
      assert.deepEqual(harness.manager.list(), [])
    })
  }

  it("bounds shutdown instead of waiting forever", async () => {
    let fireDeadline!: () => void
    let cleared = 0
    const harness = createHarness({
      shutdownTimeoutMs: 25,
      setTimeout: ((callback: () => void) => {
        fireDeadline = callback
        return {} as ReturnType<typeof setTimeout>
      }) as typeof setTimeout,
      clearTimeout: () => { cleared += 1 },
    } as never)
    const workspaceId = await createReady(harness)
    cleared = 0
    harness.runtime.stop = () => new Promise<void>(() => undefined)

    const shutdown = harness.manager.shutdown()
    fireDeadline()
    await assert.rejects(shutdown, WorkspaceCleanupTimeoutError)
    assert.equal(harness.manager.get(workspaceId)?.status, "ready")
    assert.equal(cleared, 1)
  })

  it("publishes stopped exactly once for normal exit, readiness failure, and manager cleanup", async () => {
    const normal = createHarness()
    const normalId = await createReady(normal)
    normal.runtime.onExit?.({ workspaceId: normalId, code: 0, signal: null, requested: false })
    await normal.manager.delete(normalId)
    assert.deepEqual(normal.stopped, [normalId])

    const failed = createHarness()
    const failedCreation = failed.manager.create(process.cwd())
    const failedId = await failed.runtime.launchCalled.promise
    failed.runtime.resolveLaunch()
    failed.readiness.reject(new Error("not ready"))
    await assert.rejects(failedCreation, /not ready/)
    assert.deepEqual(failed.stopped, [failedId])

    const cleaned = createHarness()
    const cleanedId = await createReady(cleaned)
    await cleaned.manager.shutdown()
    assert.deepEqual(cleaned.stopped, [cleanedId])
  })

  for (const [name, failure] of [
    ["cleanup failures", new Error("stop failed")],
    ["incomplete Windows tree cleanup", new WorkspaceWindowsTreeCleanupIncompleteError("workspace", 4242, ["taskkill failed"])],
  ] as const) {
    it(`aggregates ${name} during shutdown`, async () => {
      const harness = createHarness()
      const workspaceId = await createReady(harness)
      harness.runtime.stop = async () => { throw failure }

      await assert.rejects(harness.manager.shutdown(), (error: unknown) => {
        assert.ok(error instanceof WorkspaceShutdownError)
        assert.strictEqual(error.errors[0], failure)
        return true
      })
      assert.equal(harness.manager.get(workspaceId)?.status, "ready")
      assert.equal(harness.runtime.active.has(workspaceId), true)
    })
  }
})
