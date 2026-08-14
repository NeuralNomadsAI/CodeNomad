import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { LocationRef, OpenCodeClient, OpenCodeEvent } from "@opencode-ai/client"
import pino from "pino"

import { EventBus } from "../events/bus"
import {
  WorkspaceLaunchCancelledError,
  WorkspaceManager,
  WorkspaceShutdownError,
} from "./manager"
import type { OpenCodeEnsureOptions } from "./opencode-service"
import path from "node:path"
import os from "node:os"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

class ControlledSharedService {
  readonly validationStarted = deferred<void>()
  validationGate?: ReturnType<typeof deferred<void>>
  validationCalls: Array<{ location: LocationRef; options?: OpenCodeEnsureOptions }> = []
  evictions: LocationRef[] = []
  failEvictions = 0
  shutdownGate?: ReturnType<typeof deferred<void>>

  async endpoint(options?: OpenCodeEnsureOptions) {
    this.assertCommand(options)
    return { url: "http://127.0.0.1:4321", auth: { type: "basic" as const, username: "user", password: "pass" } }
  }

  async client() {
    return {} as OpenCodeClient
  }

  async headers(options?: OpenCodeEnsureOptions) {
    this.assertCommand(options)
    return { authorization: "Basic token" }
  }

  async validateLocation(location: LocationRef, requestOptions?: { signal?: AbortSignal }, options?: OpenCodeEnsureOptions) {
    this.assertCommand(options)
    this.validationCalls.push({ location, options })
    this.validationStarted.resolve()
    if (this.validationGate) {
      await Promise.race([
        this.validationGate.promise,
        new Promise<never>((_resolve, reject) => {
          const cancel = () => reject(requestOptions?.signal?.reason)
          requestOptions?.signal?.addEventListener("abort", cancel, { once: true })
          if (requestOptions?.signal?.aborted) cancel()
        }),
      ])
    }
    return {
      directory: location.directory,
      workspaceID: location.workspaceID ?? "location-1",
      project: { id: "project-1", directory: location.directory, canonical: location.directory },
    }
  }

  async subscribe(): Promise<AsyncIterable<OpenCodeEvent>> {
    return { async *[Symbol.asyncIterator]() {} }
  }

  async evict(location: LocationRef) {
    if (this.failEvictions-- > 0) throw new Error("controlled eviction failure")
    this.evictions.push(location)
  }

  async shutdown() {
    await this.shutdownGate?.promise
  }

  private assertCommand(options?: OpenCodeEnsureOptions) {
    const stateRoot = path.join(os.homedir(), ".codenomad", "state", "opencode-v2")
    assert.equal(options?.file, path.join(stateRoot, "opencode", "service.json"))
    assert.equal(options?.version, "0.0.0-next-17353")
    assert.match(options?.contenderFile ?? "", new RegExp(`contenders-${process.pid}-.*\\.txt$`))
    assert.match(options?.leaseFile ?? "", new RegExp(`leases[/\\\\]process-${process.pid}-.*\\.json$`))
    assert.equal(options?.command?.[0], process.execPath)
    assert.equal(options?.command?.[1], "-e")
    assert.equal(options?.command?.[3], process.execPath)
    assert.equal(options?.command?.[4], JSON.stringify(["serve", "--service"]))
    assert.equal(options?.command?.[5], options?.contenderFile)
    assert.equal(options?.launcherRecordsPid, true)
    assert.equal(options?.environment?.XDG_STATE_HOME, stateRoot)
  }
}

function createHarness(service = new ControlledSharedService()) {
  const eventBus = new EventBus()
  const started: string[] = []
  const stopped: string[] = []
  eventBus.on("workspace.started", (event) => started.push(event.workspace.id))
  eventBus.on("workspace.stopped", (event) => stopped.push(event.workspaceId))
  const manager = new WorkspaceManager({
    rootDir: process.cwd(),
    settings: { getOwner: () => ({}) } as never,
    binaryResolver: { resolveDefault: () => ({ path: process.execPath, label: "OpenCode V2" }) } as never,
    eventBus,
    logger: pino({ level: "silent" }),
    getServerBaseUrl: () => "http://127.0.0.1:4000",
    sharedService: service,
  })
  return { manager, service, started, stopped }
}

describe("workspace manager shared service lifecycle", () => {
  it("creates a ready logical location without a workspace process", async () => {
    const { manager, service, started } = createHarness()
    const { workspace, created } = await manager.create(process.cwd())

    assert.equal(created, true)
    assert.equal(workspace.status, "ready")
    assert.equal(workspace.pid, undefined)
    assert.equal(workspace.port, undefined)
    assert.equal(manager.getInstanceAuthorizationHeader(workspace.id), "Basic token")
    assert.deepEqual(service.validationCalls.map(({ location }) => location), [{ directory: process.cwd() }])
    assert.deepEqual(started, [workspace.id])
  })

  it("shares one in-flight logical location creation", async () => {
    const harness = createHarness()
    harness.service.validationGate = deferred<void>()
    const first = harness.manager.create(process.cwd())
    await harness.service.validationStarted.promise
    const second = harness.manager.create(process.cwd())
    harness.service.validationGate.resolve()

    const [leader, follower] = await Promise.all([first, second])
    assert.equal(leader.workspace.id, follower.workspace.id)
    assert.equal(Number(leader.created) + Number(follower.created), 1)
    assert.equal(harness.service.validationCalls.length, 1)
  })

  it("evicts only after the last logical owner of a location is deleted", async () => {
    const harness = createHarness()
    const first = await harness.manager.create(process.cwd())
    const forced = await harness.manager.create(process.cwd(), undefined, { forceNew: true })

    await harness.manager.delete(forced.workspace.id)
    assert.deepEqual(harness.service.evictions, [])
    assert.equal(harness.manager.get(first.workspace.id)?.status, "ready")

    await harness.manager.delete(first.workspace.id)
    assert.deepEqual(harness.service.evictions, [{ directory: process.cwd(), workspaceID: "location-1" }])
    assert.deepEqual(harness.stopped, [forced.workspace.id, first.workspace.id])
  })

  it("evicts a location once when duplicate owners are deleted concurrently", async () => {
    const harness = createHarness()
    const first = await harness.manager.create(process.cwd())
    const forced = await harness.manager.create(process.cwd(), undefined, { forceNew: true })

    await Promise.all([
      harness.manager.delete(first.workspace.id),
      harness.manager.delete(forced.workspace.id),
    ])

    assert.equal(harness.service.evictions.length, 1)
    assert.deepEqual(harness.manager.list(), [])
  })

  it("cancels validation and cleans its logical location", async () => {
    const harness = createHarness()
    harness.service.validationGate = deferred<void>()
    const creation = harness.manager.create(process.cwd())
    await harness.service.validationStarted.promise
    const record = [...(harness.manager as any).workspaces.values()][0]
    const deletion = harness.manager.delete(record.id)

    await assert.rejects(creation, WorkspaceLaunchCancelledError)
    await deletion
    assert.deepEqual(harness.manager.list(), [])
    assert.deepEqual(harness.service.evictions, [{ directory: process.cwd() }])
  })

  it("keeps a failed eviction retryable and reports shutdown failures", async () => {
    const harness = createHarness()
    const { workspace } = await harness.manager.create(process.cwd())
    harness.service.failEvictions = 1

    await assert.rejects(harness.manager.shutdown(), (error: unknown) => {
      assert.ok(error instanceof WorkspaceShutdownError)
      assert.match(String(error.errors[0]), /controlled eviction failure/)
      return true
    })
    assert.equal(harness.manager.get(workspace.id)?.status, "ready")

    await harness.manager.delete(workspace.id)
    assert.equal(harness.manager.get(workspace.id), undefined)
  })

  it("bounds a stalled shared service shutdown", async () => {
    const service = new ControlledSharedService()
    service.shutdownGate = deferred<void>()
    const { manager } = createHarness(service)
    ;(manager as any).options.shutdownTimeoutMs = 10

    await assert.rejects(manager.shutdown(), (error: unknown) => {
      assert.ok(error instanceof WorkspaceShutdownError)
      assert.match(String(error.errors[0]), /did not finish within/)
      return true
    })
  })
})
