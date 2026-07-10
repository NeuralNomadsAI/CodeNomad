import assert from "node:assert/strict"
import { describe, it } from "node:test"
import pino from "pino"

import { EventBus } from "../events/bus"
import {
  WorkspaceRuntimeIdentityCaptureError,
  WorkspaceRuntimeLaunchCancelledError,
  WorkspaceWindowsTreeCleanupIncompleteError,
  type ProcessExitInfo,
  type WorkspaceRuntime,
} from "./runtime"
import {
  WorkspaceLaunchCancelledError,
  WorkspaceLaunchSettlementTimeoutError,
  WorkspaceManager,
  WorkspaceShutdownError,
  WorkspaceShutdownTimeoutError,
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
  readonly cancellation = deferred<WorkspaceRuntimeLaunchCancelledError>()
  readonly active = new Set<string>()
  readonly stopCalls: string[] = []
  launchCalls = 0
  failStops = 0

  launch: WorkspaceRuntime["launch"] = (options) => {
    this.launchCalls += 1
    this.active.add(options.workspaceId)
    this.launchCalled.resolve(options.workspaceId)
    return this.launchResult.promise
  }

  stop: WorkspaceRuntime["stop"] = async (workspaceId) => {
    this.stopCalls.push(workspaceId)
    this.cancellation.resolve(new WorkspaceRuntimeLaunchCancelledError(workspaceId))
    if (this.failStops > 0) {
      this.failStops -= 1
      throw new Error("controlled stop failure")
    }
    this.active.delete(workspaceId)
  }

  resolveLaunch(workspaceId: string): void {
    this.launchResult.resolve({
      pid: 1234,
      port: 4321,
      exitPromise: new Promise<ProcessExitInfo>(() => undefined),
      cancellationPromise: this.cancellation.promise,
      getLastOutput: () => "",
    })
  }
}

function createHarness(managerOptions: {
  shutdownTimeoutMs?: number
  launchSettlementTimeoutMs?: number
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void
} = {}) {
  const eventBus = new EventBus()
  const runtime = new ControlledRuntime()
  const readiness = deferred<string | undefined>()
  const started: string[] = []
  let createdId = ""
  eventBus.on("workspace.created", (event) => {
    createdId = event.workspace.id
  })
  eventBus.on("workspace.started", (event) => started.push(event.workspace.id))

  const manager = new WorkspaceManager({
    rootDir: process.cwd(),
    settings: { getOwner: () => ({}) } as never,
    binaryResolver: {
      resolve: () => ({ path: "test-opencode", label: "test-opencode" }),
    } as never,
    eventBus,
    logger: pino({ level: "silent" }),
    getServerBaseUrl: () => "http://127.0.0.1:4000",
    runtime,
    ...managerOptions,
  })
  ;(manager as unknown as {
    waitForWorkspaceReadiness: () => Promise<string | undefined>
  }).waitForWorkspaceReadiness = () => readiness.promise

  return { manager, runtime, readiness, started, eventBus, getCreatedId: () => createdId }
}

describe("workspace manager launch cancellation", () => {
  it("keeps a launched workspace unpublished until runtime identity launch succeeds", async () => {
    const harness = createHarness()
    let deletion: Promise<unknown> | undefined
    harness.eventBus.on("workspace.created", (event) => {
      deletion = harness.manager.delete(event.workspace.id)
    })

    const creation = harness.manager.create(process.cwd())
    const workspaceId = await harness.runtime.launchCalled.promise
    assert.equal(harness.getCreatedId(), "")
    assert.deepEqual(harness.manager.list(), [])
    assert.equal(harness.manager.getInstancePort(workspaceId), undefined)
    assert.equal(harness.manager.getInstanceAuthorizationHeader(workspaceId), undefined)

    harness.runtime.resolveLaunch(workspaceId)
    await assert.rejects(creation, WorkspaceLaunchCancelledError)
    await deletion

    assert.equal(harness.runtime.launchCalls, 1)
    assert.equal(harness.runtime.active.size, 0)
    assert.deepEqual(harness.started, [])
    assert.deepEqual(harness.manager.list(), [])
  })

  it("stops a late launch and shares cleanup across concurrent deletes", async () => {
    const harness = createHarness()
    const creation = harness.manager.create(process.cwd())
    const workspaceId = await harness.runtime.launchCalled.promise

    const firstDelete = harness.manager.delete(workspaceId)
    const secondDelete = harness.manager.delete(workspaceId)
    assert.strictEqual(firstDelete, secondDelete)
    assert.equal(harness.manager.get(workspaceId), undefined)

    harness.runtime.resolveLaunch(workspaceId)

    await assert.rejects(creation, WorkspaceLaunchCancelledError)
    await Promise.all([firstDelete, secondDelete])

    assert.equal(harness.runtime.active.has(workspaceId), false)
    assert.deepEqual(harness.started, [])
    assert.equal(harness.manager.get(workspaceId), undefined)
    assert.deepEqual(harness.manager.list(), [])
  })

  it("does not publish or retain a workspace when mandatory identity launch fails", async () => {
    const events: string[] = []
    const eventBus = new EventBus()
    eventBus.on("workspace.created", () => events.push("created"))
    eventBus.on("workspace.started", () => events.push("started"))
    eventBus.on("workspace.error", () => events.push("error"))
    const runtime = {
      launch: ((options: { workspaceId: string }) => Promise.reject(
        new WorkspaceRuntimeIdentityCaptureError(options.workspaceId, "probe unavailable"),
      )) as WorkspaceRuntime["launch"],
      stop: (() => Promise.resolve()) as WorkspaceRuntime["stop"],
    }
    const manager = new WorkspaceManager({
      rootDir: process.cwd(),
      settings: { getOwner: () => ({}) } as never,
      binaryResolver: { resolve: () => ({ path: "test-opencode", label: "test-opencode" }) } as never,
      eventBus,
      logger: pino({ level: "silent" }),
      getServerBaseUrl: () => "http://127.0.0.1:4000",
      runtime,
    })

    await assert.rejects(manager.create(process.cwd()), WorkspaceRuntimeIdentityCaptureError)
    assert.deepEqual(events, [])
    assert.deepEqual(manager.list(), [])
  })

  it("retains an unpublished cleanup record when identity-failure cleanup cannot be proven", async () => {
    let workspaceId = ""
    let stopAttempts = 0
    const runtime = {
      launch: ((options: { workspaceId: string }) => {
        workspaceId = options.workspaceId
        return Promise.reject(new WorkspaceRuntimeIdentityCaptureError(options.workspaceId, "probe unavailable"))
      }) as WorkspaceRuntime["launch"],
      stop: (async () => {
        stopAttempts += 1
        if (stopAttempts === 1) throw new Error("cleanup proof unavailable")
      }) as WorkspaceRuntime["stop"],
    }
    const manager = new WorkspaceManager({
      rootDir: process.cwd(),
      settings: { getOwner: () => ({}) } as never,
      binaryResolver: { resolve: () => ({ path: "test-opencode", label: "test-opencode" }) } as never,
      eventBus: new EventBus(),
      logger: pino({ level: "silent" }),
      getServerBaseUrl: () => "http://127.0.0.1:4000",
      runtime,
    })

    await assert.rejects(manager.create(process.cwd()), /cleanup proof unavailable/)
    assert.deepEqual(manager.list(), [])
    assert.equal(manager.get(workspaceId), undefined)

    await manager.delete(workspaceId)
    assert.equal(stopAttempts, 3)
  })

  it("actively cancels pending readiness without publishing workspace.started", async () => {
    const harness = createHarness()
    const creation = harness.manager.create(process.cwd())
    const workspaceId = await harness.runtime.launchCalled.promise
    harness.runtime.resolveLaunch(workspaceId)
    await new Promise<void>((resolve) => setImmediate(resolve))

    const deletion = harness.manager.delete(workspaceId)

    await assert.rejects(creation, WorkspaceLaunchCancelledError)
    await deletion
    assert.equal(harness.runtime.active.has(workspaceId), false)
    assert.deepEqual(harness.started, [])
    assert.equal(harness.manager.get(workspaceId), undefined)
  })

  it("cancels and cleans a starting child during shutdown", async () => {
    const harness = createHarness()
    const creation = harness.manager.create(process.cwd())
    const workspaceId = await harness.runtime.launchCalled.promise

    const shutdown = harness.manager.shutdown()
    harness.runtime.resolveLaunch(workspaceId)

    await assert.rejects(creation, WorkspaceLaunchCancelledError)
    await shutdown
    assert.equal(harness.runtime.active.size, 0)
    assert.deepEqual(harness.started, [])
    assert.deepEqual(harness.manager.list(), [])
  })

  it("still starts and deletes an ordinary ready workspace", async () => {
    const harness = createHarness()
    const creation = harness.manager.create(process.cwd(), "ordinary")
    const workspaceId = await harness.runtime.launchCalled.promise
    harness.runtime.resolveLaunch(workspaceId)
    harness.readiness.resolve("2.0.0")

    const workspace = await creation
    assert.equal(workspace.id, harness.getCreatedId())
    assert.equal(workspace.status, "ready")
    assert.equal(workspace.binaryVersion, "2.0.0")
    assert.deepEqual(harness.started, [workspaceId])
    assert.equal(harness.runtime.active.has(workspaceId), true)

    await harness.manager.delete(workspaceId)
    assert.equal(harness.runtime.active.has(workspaceId), false)
    assert.equal(harness.manager.get(workspaceId), undefined)
  })

  it("retains a cancelled record after failed cleanup and allows delete retry", async () => {
    const harness = createHarness()
    const creation = harness.manager.create(process.cwd())
    const workspaceId = await harness.runtime.launchCalled.promise
    harness.runtime.resolveLaunch(workspaceId)
    harness.readiness.resolve(undefined)
    await creation

    harness.runtime.failStops = 1
    const firstDelete = harness.manager.delete(workspaceId)
    const concurrentDelete = harness.manager.delete(workspaceId)
    assert.strictEqual(firstDelete, concurrentDelete)
    const failedDeletes = await Promise.allSettled([firstDelete, concurrentDelete])
    assert.equal(failedDeletes[0].status, "rejected")
    assert.equal(failedDeletes[1].status, "rejected")
    if (failedDeletes[0].status === "rejected" && failedDeletes[1].status === "rejected") {
      assert.strictEqual(failedDeletes[0].reason, failedDeletes[1].reason)
      assert.match(String(failedDeletes[0].reason), /controlled stop failure/)
    }
    assert.equal(harness.manager.get(workspaceId)?.status, "ready")
    assert.equal(harness.runtime.active.has(workspaceId), true)

    const retryDelete = harness.manager.delete(workspaceId)
    assert.notStrictEqual(retryDelete, firstDelete)
    await retryDelete
    assert.equal(harness.runtime.active.has(workspaceId), false)
    assert.equal(harness.manager.get(workspaceId), undefined)
  })

  it("rejects shutdown at its deadline instead of waiting forever", async () => {
    let fireDeadline: (() => void) | undefined
    const timer = {} as ReturnType<typeof setTimeout>
    const harness = createHarness({
      shutdownTimeoutMs: 25,
      setTimeout: (callback: () => void) => {
        fireDeadline = callback
        return timer
      },
      clearTimeout: () => undefined,
    })
    const creation = harness.manager.create(process.cwd())
    const workspaceId = await harness.runtime.launchCalled.promise
    harness.runtime.resolveLaunch(workspaceId)
    harness.readiness.resolve(undefined)
    await creation
    harness.runtime.stop = () => new Promise<void>(() => undefined)

    const shutdown = harness.manager.shutdown()
    assert.ok(fireDeadline)
    fireDeadline()

    await assert.rejects(shutdown, WorkspaceShutdownTimeoutError)
    assert.equal(harness.manager.get(workspaceId)?.status, "ready")
  })

  it("rejects failed shutdown cleanup and allows a later delete retry", async () => {
    const harness = createHarness()
    const creation = harness.manager.create(process.cwd())
    const workspaceId = await harness.runtime.launchCalled.promise
    harness.runtime.resolveLaunch(workspaceId)
    harness.readiness.resolve(undefined)
    await creation
    harness.runtime.failStops = 1

    await assert.rejects(harness.manager.shutdown(), WorkspaceShutdownError)
    assert.equal(harness.manager.get(workspaceId)?.status, "ready")
    assert.equal(harness.runtime.active.has(workspaceId), true)

    await harness.manager.delete(workspaceId)
    assert.equal(harness.manager.get(workspaceId), undefined)
    assert.equal(harness.runtime.active.has(workspaceId), false)
  })

  it("reports incomplete Windows tree cleanup during shutdown", async () => {
    const harness = createHarness()
    const creation = harness.manager.create(process.cwd())
    const workspaceId = await harness.runtime.launchCalled.promise
    harness.runtime.resolveLaunch(workspaceId)
    harness.readiness.resolve(undefined)
    await creation
    harness.runtime.stop = async () => {
      throw new WorkspaceWindowsTreeCleanupIncompleteError(workspaceId, 4242, ["taskkill /T failed: unavailable"])
    }

    await assert.rejects(harness.manager.shutdown(), (error: unknown) => {
      assert.ok(error instanceof WorkspaceShutdownError)
      assert.ok(error.errors[0] instanceof WorkspaceWindowsTreeCleanupIncompleteError)
      return true
    })
    assert.equal(harness.manager.get(workspaceId)?.status, "ready")
    assert.equal(harness.runtime.active.has(workspaceId), true)
  })

  it("bounds cleanup when a runtime does not settle its cancelled launch", async () => {
    let fireDeadline: (() => void) | undefined
    const timer = {} as ReturnType<typeof setTimeout>
    const harness = createHarness({
      launchSettlementTimeoutMs: 25,
      setTimeout: (callback: () => void) => {
        fireDeadline = callback
        return timer
      },
      clearTimeout: () => undefined,
    })
    const deletion = (harness.manager as unknown as {
      withLaunchSettlementTimeout: (workspaceId: string, completion: Promise<void>) => Promise<void>
    }).withLaunchSettlementTimeout("workspace-1", new Promise<void>(() => undefined))
    assert.ok(fireDeadline)
    fireDeadline()

    await assert.rejects(deletion, WorkspaceLaunchSettlementTimeoutError)
  })
})
