import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { LocationRef, OpenCodeClient, OpenCodeEvent } from "@opencode-ai/client"
import pino from "pino"

import { EventBus } from "../events/bus"
import {
  WorkspaceLaunchCancelledError,
  WorkspaceManager,
} from "./manager"
import type { OpenCodeServiceLifecycle, OpenCodeSharedServiceOptions } from "./opencode-service"

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
  afterValidation?: () => void
  validationCalls: Array<{ location: LocationRef; options?: OpenCodeSharedServiceOptions }> = []
  shutdownCalls = 0
  evictionCalls: Array<{ location: LocationRef; options?: OpenCodeSharedServiceOptions; signal?: AbortSignal }> = []

  async endpoint() {
    return { url: "http://127.0.0.1:4321", auth: { type: "basic" as const, username: "user", password: "pass" } }
  }

  async client() {
    return {} as OpenCodeClient
  }

  async headers() {
    return { authorization: "Basic token" }
  }

  async validateLocation(location: LocationRef, requestOptions?: { signal?: AbortSignal }, options?: OpenCodeSharedServiceOptions) {
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
    this.afterValidation?.()
    return {
      directory: location.directory,
      workspaceID: location.workspaceID ?? "location-1",
      project: { id: "project-1", directory: location.directory, canonical: location.directory },
    }
  }

  async evictLocation(location: LocationRef, requestOptions?: { signal?: AbortSignal }, options?: OpenCodeSharedServiceOptions) {
    this.evictionCalls.push({ location, options, signal: requestOptions?.signal })
  }

  async subscribe(): Promise<AsyncIterable<OpenCodeEvent>> {
    return { async *[Symbol.asyncIterator]() {} }
  }

  async shutdown() { this.shutdownCalls += 1 }
}

function createHarness(service = new ControlledSharedService(), overrides: Record<string, unknown> = {}) {
  const eventBus = new EventBus()
  const stopped: string[] = []
  eventBus.on("workspace.stopped", (event) => stopped.push(event.workspaceId))
  const manager = new WorkspaceManager({
    rootDir: process.cwd(),
    settings: { getOwner: () => ({ environmentVariables: {} }) } as never,
    binaryResolver: { resolveDefault: () => ({ path: process.execPath, label: "OpenCode V2" }) } as never,
    eventBus,
    logger: pino({ level: "silent" }),
    sharedService: service,
    ...overrides,
  })
  return { manager, service, stopped }
}

describe("workspace manager shared service lifecycle", () => {
  it("pins a bounded host CLI lifecycle with binary, platform, and startup environment identity", async () => {
    const service = new ControlledSharedService()
    let factoryCall: unknown[] | undefined
    const { manager } = createHarness(service, {
      settings: { getOwner: () => ({ environmentVariables: { PROVIDER_TOKEN: "secret" } }) },
      hostServiceLifecycleFactory: (spec: unknown, timeoutMs: unknown, environment: unknown) => {
        factoryCall = [spec, timeoutMs, environment]
        return { discover: async () => undefined, ensure: async () => ({ url: "http://127.0.0.1:4321" }) }
      },
    })
    await manager.create(process.cwd())
    assert.equal(service.validationCalls.length, 1)
    const options = service.validationCalls[0]?.options
    assert.equal(options?.kind, "lifecycle")
    assert.match(options?.identity ?? "", /^host:/)
    assert.equal(options?.identity.includes("secret"), false)
    assert.deepEqual(factoryCall?.[0], { kind: "host", binary: process.execPath, platform: process.platform })
    assert.equal(typeof factoryCall?.[1], "number")
    assert.deepEqual(factoryCall?.[2], { PROVIDER_TOKEN: "secret" })
  })

  it("omits legacy storage ownership variables, keeps the current CA, and warns once", async () => {
    const service = new ControlledSharedService()
    const environments: NodeJS.ProcessEnv[] = []
    const warnings: unknown[][] = []
    const previousCa = process.env.NODE_EXTRA_CA_CERTS
    process.env.NODE_EXTRA_CA_CERTS = "/current/ca.pem"
    const logger = {
      info() {}, debug() {}, error() {},
      warn(...args: unknown[]) { warnings.push(args) },
    }
    try {
      const { manager } = createHarness(service, {
        logger,
        settings: { getOwner: () => ({
          environmentVariables: {
            KEEP_ME: "yes",
            NODE_EXTRA_CA_CERTS: "/configured/ca.pem",
            OPENCODE_DB: "/legacy/db",
            XDG_STATE_HOME: "/legacy/state",
          },
        }) },
        hostServiceLifecycleFactory: (_spec: unknown, _timeoutMs: unknown, environment: NodeJS.ProcessEnv) => {
          environments.push(environment)
          return { discover: async () => undefined, ensure: async () => ({ url: "http://127.0.0.1:4321" }) }
        },
      })
      const first = await manager.create(process.cwd())
      await manager.delete(first.workspace.id)
      await manager.create(process.cwd())

      assert.deepEqual(environments, [
        { KEEP_ME: "yes", NODE_EXTRA_CA_CERTS: "/current/ca.pem" },
        { KEEP_ME: "yes", NODE_EXTRA_CA_CERTS: "/current/ca.pem" },
      ])
      assert.equal(warnings.length, 1)
      assert.deepEqual((warnings[0]?.[0] as { variables?: string[] }).variables, ["OPENCODE_DB", "XDG_STATE_HOME"])
    } finally {
      if (previousCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS
      else process.env.NODE_EXTRA_CA_CERTS = previousCa
    }
  })

  it("selects the WSL lifecycle and preserves bounded workspace path translation", async () => {
    const service = new ControlledSharedService()
    const lifecycle: OpenCodeServiceLifecycle = {
      discover: async () => undefined,
      ensure: async () => ({ url: "http://127.0.0.1:4321" }),
    }
    let factoryCall: unknown[] | undefined
    let translationCall: unknown[] | undefined
    const { manager } = createHarness(service, {
      platform: "win32",
      binaryResolver: {
        resolveDefault: () => ({ path: String.raw`\\wsl.localhost\Ubuntu\home\dev\opencode`, label: "OpenCode V2" }),
      },
      wslServiceLifecycleFactory: (spec: unknown, timeoutMs: unknown, environment: unknown) => {
        factoryCall = [spec, timeoutMs, environment]
        return lifecycle
      },
      wslServiceDirectoryResolver: (directory: unknown, distro: unknown, timeoutMs: unknown) => {
        translationCall = [directory, distro, timeoutMs]
        return "/mnt/d/workspace"
      },
    })

    await manager.create(process.cwd())

    assert.deepEqual(factoryCall?.[0], { kind: "wsl", distro: "Ubuntu", binary: "/home/dev/opencode" })
    assert.equal(typeof factoryCall?.[1], "number")
    assert.deepEqual(translationCall?.slice(0, 2), [process.cwd(), "Ubuntu"])
    assert.ok(Number(translationCall?.[2]) > 0)
    assert.equal(service.validationCalls[0]?.location.directory, "/mnt/d/workspace")
    assert.equal(service.validationCalls[0]?.options?.kind, "lifecycle")
    assert.match(
      service.validationCalls[0]?.options?.identity ?? "",
      /^wsl:ubuntu:\/home\/dev\/opencode:env:[a-f0-9]{64}$/,
    )
    assert.equal(
      service.validationCalls[0]?.options?.kind === "lifecycle"
        ? service.validationCalls[0].options.lifecycle
        : undefined,
      lifecycle,
    )
    const record = [...(manager as any).workspaces.values()][0]
    assert.equal(record.wslDistro, "Ubuntu")
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

  it("cancels validation and cleans its logical location", async () => {
    const harness = createHarness()
    harness.service.validationGate = deferred<void>()
    const creation = harness.manager.create(process.cwd())
    await harness.service.validationStarted.promise
    const record = [...(harness.manager as any).workspaces.values()][0]
    let deletion: Promise<unknown> | undefined
    harness.service.afterValidation = () => { deletion = harness.manager.delete(record.id) }
    harness.service.validationGate.resolve()

    await assert.rejects(creation, WorkspaceLaunchCancelledError)
    await deletion
    assert.deepEqual(harness.manager.list(), [])
    assert.equal(harness.service.evictionCalls.length, 1)
    assert.equal(harness.service.evictionCalls[0]?.location.workspaceID, "location-1")
    assert.equal(harness.service.evictionCalls[0]?.signal?.aborted, false)
  })

  it("evicts a ready location on explicit final deletion without stopping the daemon", async () => {
    const harness = createHarness()
    const created = await harness.manager.create(process.cwd())
    await harness.manager.delete(created.workspace.id)

    assert.equal(harness.service.evictionCalls.length, 1)
    assert.deepEqual(harness.service.evictionCalls[0]?.location, {
      directory: process.cwd(),
      workspaceID: "location-1",
    })
    assert.equal(harness.service.shutdownCalls, 0)
  })

  it("does not evict a reused workspace that remains owned", async () => {
    const harness = createHarness()
    const retained = await harness.manager.create(process.cwd())
    const reused = await harness.manager.create(process.cwd(), undefined, { requestId: "restore" })

    assert.equal(reused.workspace.id, retained.workspace.id)
    assert.equal(reused.created, false)
    await harness.manager.cancelCreationRequest("restore")
    assert.equal(harness.service.evictionCalls.length, 0)
    assert.equal(harness.manager.list().length, 1)
  })

  it("shuts down only the local adapter after deleting workspaces", async () => {
    const harness = createHarness()
    await harness.manager.create(process.cwd())

    await harness.manager.shutdown()

    assert.deepEqual(harness.manager.list(), [])
    assert.equal(harness.service.shutdownCalls, 1)
  })

})
