import assert from "node:assert/strict"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
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
  WorkspaceDeletionBlockedError,
  WorkspaceLaunchCancelledError,
  WorkspaceLaunchTimeoutError,
  WorkspaceManager,
  WorkspacePathOwnedError,
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
  launchEnvironment?: Record<string, string>

  launch: WorkspaceRuntime["launch"] = (options) => {
    this.launchEnvironment = options.environment
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
  stubReadiness?: boolean
  shutdownTimeoutMs?: number
  launchTimeoutMs?: number
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void
  workspaceLeaseDir?: string
} = {}) {
  const { stubReadiness = true, ...managerOptions } = options
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
    ...managerOptions,
  })
  if (stubReadiness) {
    ;(manager as any).waitForWorkspaceReadiness = ({ signal }: { signal?: AbortSignal }) => Promise.race([
      readiness.promise,
      new Promise<never>((_resolve, reject) => {
        const cancel = () => reject(signal?.reason)
        signal?.addEventListener("abort", cancel, { once: true })
        if (signal?.aborted) cancel()
      }),
    ])
  }
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
  it("blocks deletion after startup reserves an unpublished or retained error workspace", async () => {
    const harness = createHarness()
    const creation = harness.manager.create(process.cwd())
    const workspaceId = await harness.runtime.launchCalled.promise

    assert.equal(harness.manager.list().length, 0)
    await harness.manager.withWorkspacePathLease(process.cwd(), async (active) => {
      assert.equal(active, true)
    })
    const record = (harness.manager as any).workspaces.get(workspaceId)
    record.status = "error"
    await harness.manager.withWorkspacePathLease(process.cwd(), async (active) => {
      assert.equal(active, true)
    })
    record.status = "starting"
    await harness.manager.delete(workspaceId)
    await assert.rejects(creation, WorkspaceLaunchCancelledError)
  })

  it("waits for a delete-first path lease before reserving startup", async () => {
    const harness = createHarness()
    const leaseEntered = deferred<void>()
    const releaseLease = deferred<void>()
    const deletion = harness.manager.withWorkspacePathLease(process.cwd(), async (active) => {
      assert.equal(active, false)
      leaseEntered.resolve()
      await releaseLease.promise
    })
    await leaseEntered.promise

    const creation = harness.manager.create(process.cwd())
    let launchStarted = false
    void harness.runtime.launchCalled.promise.then(() => { launchStarted = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(launchStarted, false)

    releaseLease.resolve()
    await deletion
    const workspaceId = await harness.runtime.launchCalled.promise
    assert.equal(launchStarted, true)
    await harness.manager.delete(workspaceId)
    await assert.rejects(creation, WorkspaceLaunchCancelledError)
  })

  it("does not run startup after its queued path lease wait times out", async () => {
    const harness = createHarness({ launchTimeoutMs: 25 })
    const leaseEntered = deferred<void>()
    const releaseLease = deferred<void>()
    const deletion = harness.manager.withWorkspacePathLease(process.cwd(), async () => {
      leaseEntered.resolve()
      await releaseLease.promise
    })
    await leaseEntered.promise

    await assert.rejects(harness.manager.create(process.cwd()), WorkspaceLaunchTimeoutError)
    releaseLease.resolve()
    await deletion
    await new Promise<void>((resolve) => setImmediate(resolve))

    assert.equal((harness.manager as any).workspaces.size, 0)
    assert.equal(harness.runtime.active.size, 0)
  })

  it("guards restore cancellation before aborting or deleting its workspace", async () => {
    const harness = createHarness()
    const creation = harness.manager.create(process.cwd(), undefined, { requestId: "restore-request" })
    const workspaceId = await harness.runtime.launchCalled.promise
    harness.runtime.resolveLaunch()
    harness.readiness.resolve(undefined)
    await creation
    let guardedWorkspaceId: string | undefined
    harness.manager.setDeletionGuard(async (workspace) => {
      guardedWorkspaceId = workspace.id
      throw new WorkspaceDeletionBlockedError(workspace.id)
    })

    await assert.rejects(harness.manager.cancelCreationRequest("restore-request"), WorkspaceDeletionBlockedError)
    assert.equal(guardedWorkspaceId, workspaceId)
    assert.equal(harness.manager.get(workspaceId)?.status, "ready")
    assert.equal(harness.runtime.stopCalls, 0)

    harness.manager.setDeletionGuard(async (_workspace, operation) => operation())
    await harness.manager.cancelCreationRequest("restore-request")
    assert.equal(harness.manager.get(workspaceId), undefined)
  })

  it("does not reuse a ready workspace while guarded deletion is pending", async () => {
    const harness = createHarness()
    const workspaceId = await createReady(harness)
    const guardEntered = deferred<void>()
    const finishGuard = deferred<void>()
    harness.manager.setDeletionGuard(async (workspace) => {
      guardEntered.resolve()
      await finishGuard.promise
      throw new WorkspaceDeletionBlockedError(workspace.id)
    })

    const deletion = harness.manager.delete(workspaceId)
    await guardEntered.promise
    await assert.rejects(harness.manager.create(process.cwd()), /deletion is pending/)
    assert.equal((harness.manager as any).workspaces.size, 1)
    assert.equal(harness.runtime.active.size, 1)
    finishGuard.resolve()
    await assert.rejects(deletion, WorkspaceDeletionBlockedError)
    assert.equal(harness.manager.get(workspaceId)?.status, "ready")

    const reused = await harness.manager.create(process.cwd())
    assert.equal(reused.created, false)
    assert.equal(reused.workspace.id, workspaceId)
  })

  it("does not reuse a pending workspace while its guarded deletion is pending", async () => {
    const harness = createHarness()
    const firstCreation = harness.manager.create(process.cwd())
    const workspaceId = await harness.runtime.launchCalled.promise
    const guardEntered = deferred<void>()
    const finishGuard = deferred<void>()
    harness.manager.setDeletionGuard(async (_workspace, operation) => {
      guardEntered.resolve()
      await finishGuard.promise
      return operation()
    })

    const deletion = harness.manager.delete(workspaceId)
    await guardEntered.promise
    await assert.rejects(harness.manager.create(process.cwd()), /deletion is pending/)
    assert.equal((harness.manager as any).workspaces.size, 1)
    assert.equal(harness.runtime.active.size, 1)
    finishGuard.resolve()
    await assert.rejects(firstCreation, WorkspaceLaunchCancelledError)
    await deletion
  })

  for (const status of ["stopped", "error"] as const) {
    it(`does not reuse a ${status} lineage record`, async () => {
      const harness = createHarness()
      const first = await (async () => {
        const creation = harness.manager.create(process.cwd(), undefined, { lineageId: "terminal-lineage" })
        harness.runtime.resolveLaunch()
        harness.readiness.resolve(undefined)
        return creation
      })()
      ;(harness.manager.get(first.workspace.id) as { status: string }).status = status

      const second = await harness.manager.create(process.cwd(), undefined, { lineageId: "terminal-lineage" })

      assert.equal(second.created, true)
      assert.notEqual(second.workspace.id, first.workspace.id)
    })
  }

  it("uses a distinct generated capability for plugin callbacks", async () => {
    const harness = createHarness()
    ;(harness.manager as any).options.settings = {
      getOwner: () => ({ environmentVariables: { OPENCODE_SERVER_PASSWORD: "shared-opencode-secret" } }),
    }
    const workspaceId = await createReady(harness)
    const callbackToken = harness.runtime.launchEnvironment?.CODENOMAD_CALLBACK_TOKEN

    assert.ok(callbackToken)
    assert.notEqual(callbackToken, "shared-opencode-secret")
    assert.equal(harness.manager.getPluginCallbackAuthorizationHeader(workspaceId), `Bearer ${callbackToken}`)
    assert.equal(
      harness.manager.getInstanceAuthorizationHeader(workspaceId),
      `Basic ${Buffer.from("codenomad:shared-opencode-secret").toString("base64")}`,
    )
  })

  it("rejects a healthy workspace whose OpenCode configuration is invalid", async () => {
    const originalFetch = globalThis.fetch
    const requests: string[] = []
    const configError = JSON.stringify({
      name: "ConfigInvalidError",
      data: {
        path: "C:\\Users\\dev\\.config\\opencode\\agents\\invalid.md",
        issues: [{ path: ["tools", "bash"], message: 'Expected boolean, got "ask"' }],
      },
    })
    globalThis.fetch = (async (input: URL | RequestInfo) => {
      const url = String(input)
      requests.push(url)
      if (url.includes("/global/health")) {
        return new Response(JSON.stringify({ healthy: true, version: "1.18.5" }), {
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(configError, { status: 400, headers: { "Content-Type": "application/json" } })
    }) as typeof fetch

    try {
      const harness = createHarness({ stubReadiness: false })
      ;(harness.manager as any).waitForPortAvailability = async () => undefined
      const creation = harness.manager.create(process.cwd())
      const workspaceId = await harness.runtime.launchCalled.promise
      harness.runtime.resolveLaunch()

      await assert.rejects(creation, (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, configError)
        return true
      })
      assert.deepEqual(requests.map((url) => new URL(url).pathname), ["/global/health", "/config"])
      assert.equal(new URL(requests[1]).search, "")
      assert.equal(harness.runtime.active.has(workspaceId), false)
      assert.deepEqual(harness.started, [])
      assert.deepEqual(harness.manager.list(), [])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

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
    await assert.rejects(harness.manager.create(process.cwd()), /cleanup is incomplete/)

    await harness.manager.delete(workspaceId)
    assert.equal(harness.runtime.active.has(workspaceId), false)
    assert.equal(harness.manager.get(workspaceId), undefined)
  })

  it("blocks deletion and relaunch while stopped workspace cleanup is incomplete", async () => {
    const harness = createHarness()
    const workspaceId = await createReady(harness)
    harness.runtime.active.delete(workspaceId)
    harness.runtime.onExit?.({ workspaceId, code: 0, signal: null, requested: false })
    harness.runtime.failStops = 2

    await assert.rejects(harness.manager.delete(workspaceId), /controlled stop failure/)
    assert.equal(harness.manager.get(workspaceId)?.status, "stopped")
    await harness.manager.withWorkspacePathLease(process.cwd(), async (active) => {
      assert.equal(active, true)
    })
    await assert.rejects(harness.manager.create(process.cwd()), /cleanup is incomplete/)

    await harness.manager.delete(workspaceId)
    assert.equal(harness.manager.get(workspaceId), undefined)
  })

  it("exposes unpublished failed cleanup for safe deletion retry", async () => {
    const harness = createHarness()
    harness.runtime.failStops = 1
    const creation = harness.manager.create(process.cwd())
    const workspaceId = await harness.runtime.launchCalled.promise
    harness.runtime.launchResult.reject(new Error("controlled launch failure"))

    await assert.rejects(creation, /controlled stop failure/)
    assert.equal(harness.manager.list()[0]?.id, workspaceId)
    assert.equal(harness.manager.get(workspaceId)?.status, "error")
    await harness.manager.withWorkspacePathLease(process.cwd(), async (active) => {
      assert.equal(active, true)
    })
    await assert.rejects(harness.manager.create(process.cwd()), /cleanup is incomplete/)

    await harness.manager.delete(workspaceId)
    assert.equal(harness.manager.get(workspaceId), undefined)
    assert.equal(harness.runtime.active.has(workspaceId), false)
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

  it("gives release and cancellation one terminal winner", async () => {
    const cancelled = createHarness()
    const cancelledCreation = cancelled.manager.create(process.cwd(), undefined, { requestId: "cancel-wins" })
    const cancelledId = await cancelled.runtime.launchCalled.promise
    cancelled.runtime.resolveLaunch()
    cancelled.readiness.resolve(undefined)
    await cancelledCreation
    const stopStarted = deferred<void>()
    const finishStop = deferred<void>()
    const originalStop = cancelled.runtime.stop
    cancelled.runtime.stop = async (workspaceId) => {
      stopStarted.resolve()
      await finishStop.promise
      await originalStop(workspaceId)
    }

    const cancellation = cancelled.manager.cancelCreationRequest("cancel-wins")
    await stopStarted.promise
    assert.equal(cancelled.manager.releaseCreationRequest(cancelledId, "cancel-wins"), false)
    assert.equal(cancelled.manager.get(cancelledId)?.id, cancelledId)
    finishStop.resolve()
    await cancellation
    assert.equal(cancelled.manager.get(cancelledId), undefined)

    const released = createHarness()
    const releasedCreation = released.manager.create(process.cwd(), undefined, { requestId: "release-wins" })
    const releasedId = await released.runtime.launchCalled.promise
    released.runtime.resolveLaunch()
    released.readiness.resolve(undefined)
    await releasedCreation

    assert.equal(released.manager.releaseCreationRequest(releasedId, "release-wins"), true)
    await released.manager.cancelCreationRequest("release-wins")
    assert.equal(released.manager.releaseCreationRequest(releasedId, "release-wins"), true)
    assert.equal(released.manager.get(releasedId)?.id, releasedId)
    assert.equal(released.runtime.active.has(releasedId), true)
  })

  it("retains unresolved pre-creation cancellation until its delayed create", async () => {
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
    await assert.rejects(
      harness.manager.create(process.cwd(), undefined, { requestId: "restore-reused" }),
      /was cancelled/,
    )
    assert.equal(harness.manager.releaseCreationRequest(workspaceId, "restore-reused"), false)
  })

  it("retains a request-owned workspace when ordinary reuse adopts it", async () => {
    const harness = createHarness()
    const scoped = harness.manager.create(process.cwd(), undefined, { requestId: "old-restore" })
    const workspaceId = await harness.runtime.launchCalled.promise
    harness.runtime.resolveLaunch()
    harness.readiness.resolve(undefined)
    await scoped

    const adopted = await harness.manager.create(process.cwd())
    assert.equal(adopted.workspace.id, workspaceId)
    await harness.manager.cancelCreationRequest("old-restore")
    assert.equal(harness.manager.get(workspaceId)?.id, workspaceId)
    assert.equal(harness.runtime.active.has(workspaceId), true)
  })

  it("fences canonical paths across managers while preserving local forceNew", async () => {
    const leaseDir = await mkdtemp(path.join(os.tmpdir(), "codenomad-workspace-leases-"))
    try {
      const first = createHarness({ workspaceLeaseDir: leaseDir })
      const second = createHarness({ workspaceLeaseDir: leaseDir })
      const creation = first.manager.create(process.cwd())
      const workspaceId = await first.runtime.launchCalled.promise

      await assert.rejects(second.manager.create(process.cwd()), WorkspacePathOwnedError)
      assert.equal(second.runtime.active.size, 0)
      await second.manager.withWorkspacePathLease(process.cwd(), async (active) => assert.equal(active, true))
      first.runtime.resolveLaunch()
      first.readiness.resolve(undefined)
      await creation

      const forced = await first.manager.create(process.cwd(), undefined, { forceNew: true })
      const forcedId = forced.workspace.id
      assert.notEqual(forcedId, workspaceId)

      await first.manager.delete(forcedId)
      first.runtime.failStops = 2
      await assert.rejects(first.manager.delete(workspaceId), /controlled stop failure/)
      await assert.rejects(second.manager.create(process.cwd()), WorkspacePathOwnedError)
      await first.manager.delete(workspaceId)
      const replacement = second.manager.create(process.cwd())
      second.runtime.resolveLaunch()
      second.readiness.resolve(undefined)
      await replacement
      await second.manager.shutdown()
    } finally {
      await rm(leaseDir, { recursive: true, force: true })
    }
  })

  it("fences and stops a workspace when its process lease is replaced", async () => {
    const leaseDir = await mkdtemp(path.join(os.tmpdir(), "codenomad-workspace-lease-loss-"))
    try {
      const harness = createHarness({ workspaceLeaseDir: leaseDir })
      const creation = harness.manager.create(process.cwd())
      const workspaceId = await harness.runtime.launchCalled.promise
      harness.runtime.resolveLaunch()
      harness.readiness.resolve(undefined)
      await creation
      const registry = (harness.manager as any).processLeases
      const [key, held] = [...registry.held.entries()][0]
      await rename(path.join(held.directory, "owner"), path.join(held.directory, "retired.test-owner"))
      await mkdir(path.join(held.directory, "owner"))
      await writeFile(path.join(held.directory, "owner", "owner.json"), JSON.stringify({
        version: 1, managerToken: "successor", leaseToken: "successor-lease", pid: 999,
        hostname: os.hostname(), workspacePath: process.cwd(),
      }), "utf8")

      await registry.heartbeat(key, held.owner)
      for (let attempt = 0; attempt < 100 && harness.manager.get(workspaceId); attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
      }
      assert.equal(harness.manager.getInstancePort(workspaceId), undefined)
      assert.equal(harness.runtime.active.has(workspaceId), false)
      assert.equal(harness.manager.get(workspaceId), undefined)
    } finally {
      await rm(leaseDir, { recursive: true, force: true })
    }
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
