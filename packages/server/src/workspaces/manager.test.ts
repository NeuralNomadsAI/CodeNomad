import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { describe, it } from "node:test"
import type { LocationRef, OpenCodeClient, OpenCodeEvent } from "@opencode-ai/client"
import pino from "pino"

import { EventBus } from "../events/bus"
import {
  WorkspaceLaunchCancelledError,
  WorkspaceManager,
  canonicalWorktreeIdentity,
  isWindowsHostPath,
} from "./manager"
import { startupEnvironmentHash } from "./host-opencode-service"
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
  ignoreValidationAbort = false
  afterValidation?: () => void
  headerFailures = 0
  validationCalls: Array<{ location: LocationRef; options?: OpenCodeSharedServiceOptions }> = []
  debugLocations: LocationRef[] = []
  shutdownCalls = 0
  shutdownGate?: ReturnType<typeof deferred<void>>
  shutdownTimeouts: number[] = []
  evictionCalls: Array<{ location: LocationRef; options?: OpenCodeSharedServiceOptions; signal?: AbortSignal }> = []
  evictionFailures = 0
  readonly evictionStarted = deferred<void>()
  evictionGate?: ReturnType<typeof deferred<void>>

  async endpoint() {
    return { url: "http://127.0.0.1:4321", auth: { type: "basic" as const, username: "user", password: "pass" } }
  }

  async client() {
    return { debug: { location: { list: async () => this.debugLocations } } } as OpenCodeClient
  }

  async headers() {
    if (this.headerFailures > 0) {
      this.headerFailures -= 1
      throw new Error("header lookup failed")
    }
    return { authorization: "Basic token" }
  }

  async validateLocation(location: LocationRef, requestOptions?: { signal?: AbortSignal }, options?: OpenCodeSharedServiceOptions) {
    this.validationCalls.push({ location, options })
    this.validationStarted.resolve()
    if (this.validationGate) {
      if (this.ignoreValidationAbort) await this.validationGate.promise
      else {
        await Promise.race([
          this.validationGate.promise,
          new Promise<never>((_resolve, reject) => {
            const cancel = () => reject(requestOptions?.signal?.reason)
            requestOptions?.signal?.addEventListener("abort", cancel, { once: true })
            if (requestOptions?.signal?.aborted) cancel()
          }),
        ])
      }
    }
    this.afterValidation?.()
    const directory = location.directory
    return {
      directory,
      workspaceID: location.workspaceID ?? "location-1",
      project: { id: "project-1", directory, canonical: directory },
    }
  }

  async evictLocation(location: LocationRef, requestOptions?: { signal?: AbortSignal }, options?: OpenCodeSharedServiceOptions) {
    this.evictionCalls.push({ location, options, signal: requestOptions?.signal })
    this.evictionStarted.resolve()
    await this.evictionGate?.promise
    if (this.evictionFailures > 0) {
      this.evictionFailures -= 1
      throw new Error("eviction failed")
    }
  }

  async subscribe(): Promise<AsyncIterable<OpenCodeEvent>> {
    return { async *[Symbol.asyncIterator]() {} }
  }

  async shutdown(options?: { timeoutMs?: number }) {
    this.shutdownCalls += 1
    if (options?.timeoutMs !== undefined) this.shutdownTimeouts.push(options.timeoutMs)
    await this.shutdownGate?.promise
  }
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
  return { manager, service, stopped, eventBus }
}

describe("workspace manager shared service lifecycle", () => {
  it("validates native workspace identity against an owned directory", async () => {
    const service = new ControlledSharedService()
    service.debugLocations = [
      { directory: process.cwd(), workspaceID: "worktree-location" },
      { directory: path.join(path.parse(process.cwd()).root, "__codenomad_foreign__"), workspaceID: "mismatch-location" },
    ]
    const { manager } = createHarness(service)
    const workspace = await manager.create(process.cwd())

    assert.equal(await manager.ownsLocation(workspace.workspace.id, { directory: process.cwd(), workspaceID: "location-1" }), true)
    assert.equal(await manager.ownsLocation(workspace.workspace.id, { directory: process.cwd(), workspaceID: "foreign" }), false)
    assert.equal(await manager.ownsLocation(workspace.workspace.id, { directory: process.cwd(), workspaceID: "mismatch-location" }), false)
    assert.equal(await manager.ownsLocationWorkspace(workspace.workspace.id, "worktree-location"), true)
  })

  it("distinguishes WSL service paths from Windows host paths", () => {
    assert.equal(isWindowsHostPath("/mnt/d/repo"), false)
    assert.equal(isWindowsHostPath("D:\\repo"), true)
    assert.equal(isWindowsHostPath("\\\\wsl.localhost\\Ubuntu\\repo"), true)
    assert.equal(isWindowsHostPath("//wsl.localhost/Ubuntu/repo"), true)
    assert.equal(canonicalWorktreeIdentity("D:\\Repo", "win32"), canonicalWorktreeIdentity("d:\\repo", "win32"))
    assert.notEqual(
      canonicalWorktreeIdentity("\\\\wsl.localhost\\Ubuntu\\repo\\Foo", "win32"),
      canonicalWorktreeIdentity("\\\\wsl.localhost\\Ubuntu\\repo\\foo", "win32"),
    )
    assert.equal(
      canonicalWorktreeIdentity("\\\\WSL.LOCALHOST\\ubuntu\\repo\\Foo", "win32"),
      canonicalWorktreeIdentity("\\\\wsl.localhost\\Ubuntu\\repo\\Foo", "win32"),
    )
    assert.equal(
      canonicalWorktreeIdentity("\\\\WSL$\\UBUNTU\\repo\\Foo", "win32"),
      canonicalWorktreeIdentity("\\\\wsl.localhost\\Ubuntu\\repo\\Foo", "win32"),
    )
    assert.notEqual(
      canonicalWorktreeIdentity("\\\\wsl$\\Ubuntu\\repo\\Foo", "win32"),
      canonicalWorktreeIdentity("\\\\wsl.localhost\\Ubuntu\\repo\\foo", "win32"),
    )
  })

  it("keeps WSL worktree reservation paths case-sensitive", { skip: process.platform !== "win32" }, async () => {
    const { manager } = createHarness(new ControlledSharedService(), { platform: "win32" })
    const releaseUpper = await manager.reserveWorktreeDeletion("\\\\wsl.localhost\\Ubuntu\\repo\\Foo")
    const releaseLower = await manager.reserveWorktreeDeletion("\\\\wsl.localhost\\Ubuntu\\repo\\foo")
    await assert.rejects(
      () => manager.reserveWorktreeDeletion("\\\\wsl.localhost\\Ubuntu\\repo\\Foo\\nested"),
      /already in progress/,
    )
    releaseLower()
    releaseUpper()
  })

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

  it("translates a case-insensitive Windows CA path before WSL identity and lifecycle construction", async () => {
    const previousCa = process.env.NODE_EXTRA_CA_CERTS
    delete process.env.NODE_EXTRA_CA_CERTS
    const caPath = String.raw`C:\certs\ca.pem`
    const environment = { node_extra_ca_certs: caPath, Node_Extra_CA_Certs: caPath }
    let lifecycleEnvironment: NodeJS.ProcessEnv | undefined
    let now = 1_000
    const translations: Array<{ directory: string; timeoutMs: number }> = []
    try {
      const { manager, service } = createHarness(new ControlledSharedService(), {
        platform: "win32",
        launchTimeoutMs: 100,
        now: () => now,
        settings: { getOwner: () => ({ environmentVariables: environment }) },
        binaryResolver: {
          resolveDefault: () => ({ path: String.raw`\\wsl.localhost\Ubuntu\home\dev\opencode`, label: "OpenCode V2" }),
        },
        wslServiceDirectoryResolver: (directory: string, _distro: string, timeoutMs: number) => {
          translations.push({ directory, timeoutMs })
          if (directory === caPath) {
            now += 40
            return "/mnt/c/certs/ca.pem"
          }
          return "/mnt/d/workspace"
        },
        wslServiceLifecycleFactory: (_spec: unknown, _timeoutMs: unknown, startupEnvironment: NodeJS.ProcessEnv) => {
          lifecycleEnvironment = startupEnvironment
          return { discover: async () => undefined, ensure: async () => ({ url: "http://127.0.0.1:4321" }) }
        },
      })

      await manager.create(process.cwd())

      const effectiveEnvironment = { NODE_EXTRA_CA_CERTS: "/mnt/c/certs/ca.pem" }
      assert.deepEqual(lifecycleEnvironment, effectiveEnvironment)
      assert.deepEqual(translations, [
        { directory: caPath, timeoutMs: 100 },
        { directory: process.cwd(), timeoutMs: 60 },
      ])
      assert.equal(
        service.validationCalls[0]?.options?.identity,
        `wsl:ubuntu:/home/dev/opencode:env:${startupEnvironmentHash(effectiveEnvironment, "linux")}`,
      )
    } finally {
      if (previousCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS
      else process.env.NODE_EXTRA_CA_CERTS = previousCa
    }
  })

  it("does not translate the WSL workspace after the shared path deadline expires", async () => {
    const previousCa = process.env.NODE_EXTRA_CA_CERTS
    delete process.env.NODE_EXTRA_CA_CERTS
    const caPath = String.raw`C:\certs\ca.pem`
    let now = 1_000
    const translations: Array<{ directory: string; timeoutMs: number }> = []
    try {
      const { manager, service } = createHarness(new ControlledSharedService(), {
        platform: "win32",
        launchTimeoutMs: 100,
        now: () => now,
        settings: { getOwner: () => ({ environmentVariables: { node_extra_ca_certs: caPath } }) },
        binaryResolver: {
          resolveDefault: () => ({ path: String.raw`\\wsl.localhost\Ubuntu\home\dev\opencode`, label: "OpenCode V2" }),
        },
        wslServiceDirectoryResolver: (directory: string, _distro: string, timeoutMs: number) => {
          translations.push({ directory, timeoutMs })
          now += 100
          return "/mnt/c/certs/ca.pem"
        },
      })

      await assert.rejects(
        manager.create(process.cwd()),
        /Unable to translate workspace location for WSL distro "Ubuntu"/,
      )
      assert.deepEqual(translations, [{ directory: caPath, timeoutMs: 100 }])
      assert.equal(service.validationCalls.length, 0)
    } finally {
      if (previousCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS
      else process.env.NODE_EXTRA_CA_CERTS = previousCa
    }
  })

  it("preserves POSIX WSL CA paths and reports Windows CA translation failures", async () => {
    const previousCa = process.env.NODE_EXTRA_CA_CERTS
    delete process.env.NODE_EXTRA_CA_CERTS
    try {
      let lifecycleEnvironment: NodeJS.ProcessEnv | undefined
      const common = {
        platform: "win32",
        binaryResolver: {
          resolveDefault: () => ({ path: String.raw`\\wsl.localhost\Ubuntu\home\dev\opencode`, label: "OpenCode V2" }),
        },
      }
      const preserved = createHarness(new ControlledSharedService(), {
        ...common,
        settings: { getOwner: () => ({ environmentVariables: { Node_Extra_CA_Certs: "/etc/ssl/custom.pem" } }) },
        wslServiceDirectoryResolver: () => "/mnt/d/workspace",
        wslServiceLifecycleFactory: (_spec: unknown, _timeoutMs: unknown, environment: NodeJS.ProcessEnv) => {
          lifecycleEnvironment = environment
          return { discover: async () => undefined, ensure: async () => ({ url: "http://127.0.0.1:4321" }) }
        },
      })
      await preserved.manager.create(process.cwd())
      assert.deepEqual(lifecycleEnvironment, { NODE_EXTRA_CA_CERTS: "/etc/ssl/custom.pem" })

      const failed = createHarness(new ControlledSharedService(), {
        ...common,
        settings: { getOwner: () => ({ environmentVariables: { NODE_EXTRA_CA_CERTS: String.raw`C:\missing\ca.pem` } }) },
        wslServiceDirectoryResolver: () => null,
      })
      await assert.rejects(
        failed.manager.create(process.cwd()),
        /Unable to translate NODE_EXTRA_CA_CERTS for WSL distro "Ubuntu": C:\\missing\\ca\.pem/,
      )
      assert.equal(failed.service.validationCalls.length, 0)
    } finally {
      if (previousCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS
      else process.env.NODE_EXTRA_CA_CERTS = previousCa
    }
  })
  it("creates separate workspaces for concurrent and sequential creates of the same path", async () => {
    const harness = createHarness()
    harness.service.validationGate = deferred<void>()
    const first = harness.manager.create(process.cwd(), undefined, { requestId: "first-request" })
    await harness.service.validationStarted.promise
    const second = harness.manager.create(process.cwd(), undefined, { requestId: "second-request" })
    while (harness.service.validationCalls.length < 2) await new Promise((resolve) => setImmediate(resolve))
    harness.service.validationGate.resolve()

    const [left, right] = await Promise.all([first, second])
    const third = await harness.manager.create(process.cwd(), undefined, { requestId: "third-request" })
    assert.equal(new Set([left.workspace.id, right.workspace.id, third.workspace.id]).size, 3)
    assert.equal(left.created && right.created && third.created, true)
    assert.equal(left.workspace.requestId, "first-request")
    assert.equal(right.workspace.requestId, "second-request")
    assert.equal(third.workspace.requestId, "third-request")
    assert.equal(harness.service.validationCalls.length, 3)
  })

  it("cancels only the matching in-flight duplicate creation", async () => {
    const harness = createHarness()
    harness.service.validationGate = deferred<void>()
    const first = harness.manager.create(process.cwd(), undefined, { requestId: "first-request" })
    const firstFailure = assert.rejects(first, WorkspaceLaunchCancelledError)
    await harness.service.validationStarted.promise
    const second = harness.manager.create(process.cwd(), undefined, { requestId: "second-request" })
    while (harness.service.validationCalls.length < 2) await new Promise((resolve) => setImmediate(resolve))
    const cancellation = harness.manager.cancelCreationRequest("first-request")
    harness.service.validationGate.resolve()

    await firstFailure
    const created = await second
    await cancellation
    assert.equal(created.created, true)
    assert.equal(created.workspace.requestId, "second-request")
    assert.deepEqual(harness.manager.list().map(({ id }) => id), [created.workspace.id])
    assert.equal(harness.service.evictionCalls.length, 0)
  })

  it("keeps a released duplicate when another creation request is cancelled", async () => {
    const harness = createHarness()
    const retained = await harness.manager.create(process.cwd(), undefined, { requestId: "retained-request" })
    const cancelled = await harness.manager.create(process.cwd(), undefined, { requestId: "cancelled-request" })
    assert.equal(harness.manager.releaseCreationRequest(retained.workspace.id, "retained-request"), true)
    await harness.manager.cancelCreationRequest("cancelled-request")

    assert.deepEqual(harness.manager.list().map(({ id }) => id), [retained.workspace.id])
    assert.equal(harness.manager.get(cancelled.workspace.id), undefined)
    assert.equal(harness.service.evictionCalls.length, 0)
  })

  it("rejects a duplicate request id while pending and while its claim survives", async () => {
    const harness = createHarness()
    harness.service.validationGate = deferred<void>()
    const owner = harness.manager.create(process.cwd(), undefined, { requestId: "duplicate-request" })
    await harness.service.validationStarted.promise

    await assert.rejects(
      harness.manager.create(path.join(process.cwd(), "other-path"), undefined, { requestId: "duplicate-request" }),
      /already in use/,
    )
    harness.service.validationGate.resolve()
    const created = await owner
    await assert.rejects(
      harness.manager.create(path.join(process.cwd(), "other-path"), undefined, { requestId: "duplicate-request" }),
      /already in use/,
    )

    assert.equal((harness.manager as any).pendingCreationRequests.size, 0)
    assert.equal((harness.manager as any).cancelledCreationRequests.size, 0)
    assert.equal(harness.manager.get(created.workspace.id)?.id, created.workspace.id)
  })

  it("bounds concurrent duplicate workspace creations", async () => {
    const harness = createHarness()
    harness.service.validationGate = deferred<void>()
    const creations = Array.from({ length: 32 }, () => harness.manager.create(process.cwd()))
    while (harness.service.validationCalls.length < 32) await new Promise((resolve) => setImmediate(resolve))

    await assert.rejects(harness.manager.create(process.cwd()), /Too many workspace creations/)
    harness.service.validationGate.resolve()
    const created = await Promise.all(creations)
    assert.equal(new Set(created.map(({ workspace }) => workspace.id)).size, 32)
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
    assert.equal(harness.service.evictionCalls[0]?.signal, undefined)
  })

  it("refuses deletion while another workspace occupies the worktree", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "codenomad-worktree-owner-"))
    const worktree = path.join(temp, "worktree")
    const nested = path.join(worktree, "apps", "web")
    await mkdir(nested, { recursive: true })
    const harness = createHarness()
    try {
      const { workspace } = await harness.manager.create(nested)
      await assert.rejects(() => harness.manager.reserveWorktreeDeletion(worktree), /open as another workspace/)
      await harness.manager.delete(workspace.id)
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
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

  it("evicts a shared location only after its last workspace is deleted", async () => {
    const harness = createHarness()
    const first = await harness.manager.create(process.cwd())
    const second = await harness.manager.create(process.cwd())

    assert.notEqual(first.workspace.id, second.workspace.id)
    await harness.manager.delete(first.workspace.id)
    assert.equal(harness.service.evictionCalls.length, 0)
    assert.equal(harness.manager.list().length, 1)
    await harness.manager.delete(second.workspace.id)
    assert.equal(harness.service.evictionCalls.length, 1)
    assert.equal(harness.manager.list().length, 0)
  })

  it("keeps native locations distinct when only their workspace id matches", async () => {
    const harness = createHarness()
    const first = await harness.manager.create(path.join(process.cwd(), "location-a"))
    const second = await harness.manager.create(path.join(process.cwd(), "location-b"))

    await harness.manager.delete(first.workspace.id)
    assert.deepEqual(harness.service.evictionCalls.map(({ location }) => location.directory), [
      path.join(process.cwd(), "location-a"),
    ])
    assert.equal(harness.manager.get(second.workspace.id)?.id, second.workspace.id)
    await harness.manager.delete(second.workspace.id)
    assert.equal(harness.service.evictionCalls.length, 2)
  })

  it("finishes a blocked final eviction before validating a new owner", async () => {
    const harness = createHarness()
    const first = await harness.manager.create(process.cwd())
    harness.service.evictionGate = deferred<void>()
    const deletion = harness.manager.delete(first.workspace.id)
    await harness.service.evictionStarted.promise

    const creation = harness.manager.create(process.cwd())
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(harness.service.validationCalls.length, 1)

    harness.service.evictionGate.resolve()
    await deletion
    const second = await creation
    assert.equal(harness.service.evictionCalls.length, 1)
    assert.deepEqual(harness.manager.list().map(({ id }) => id), [second.workspace.id])
  })

  it("keeps a timed-out eviction between the old and new owner", async () => {
    const harness = createHarness(new ControlledSharedService(), { launchSettlementTimeoutMs: 20 })
    const first = await harness.manager.create(process.cwd())
    harness.service.evictionGate = deferred<void>()
    const deletion = assert.rejects(harness.manager.delete(first.workspace.id), /cleanup did not finish/)
    await harness.service.evictionStarted.promise
    await deletion

    const creation = harness.manager.create(process.cwd())
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(harness.service.validationCalls.length, 1)

    harness.service.evictionGate.resolve()
    const second = await creation
    assert.equal(harness.service.evictionCalls.length, 1)
    assert.deepEqual(harness.manager.list().map(({ id }) => id), [second.workspace.id])
  })

  it("evicts once when duplicate workspaces are deleted concurrently", async () => {
    const harness = createHarness()
    const first = await harness.manager.create(process.cwd())
    const second = await harness.manager.create(process.cwd())
    harness.service.evictionGate = deferred<void>()

    const deletions = Promise.all([
      harness.manager.delete(first.workspace.id),
      harness.manager.delete(second.workspace.id),
    ])
    await harness.service.evictionStarted.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(harness.service.evictionCalls.length, 1)

    harness.service.evictionGate.resolve()
    await deletions
    assert.equal(harness.service.evictionCalls.length, 1)
    assert.deepEqual(harness.manager.list(), [])
  })

  it("retries cleanup after an eviction failure", async () => {
    const harness = createHarness()
    const created = await harness.manager.create(process.cwd())
    harness.service.evictionFailures = 1

    await assert.rejects(harness.manager.delete(created.workspace.id), /eviction failed/)
    await harness.manager.delete(created.workspace.id)

    assert.equal(harness.service.evictionCalls.length, 2)
    assert.deepEqual(harness.manager.list(), [])
  })

  it("does not launch an eviction queued before shutdown", async () => {
    const harness = createHarness()
    const first = await harness.manager.create(process.cwd())
    harness.service.validationGate = deferred<void>()
    const creation = harness.manager.create(process.cwd())
    const creationFailure = assert.rejects(creation, WorkspaceLaunchCancelledError)
    while (harness.service.validationCalls.length < 2) await new Promise((resolve) => setImmediate(resolve))

    const deletion = harness.manager.delete(first.workspace.id)
    while ((harness.manager as any).pendingLocationEvictions < 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    await harness.manager.shutdown()
    await creationFailure
    await deletion

    assert.equal(harness.service.evictionCalls.length, 0)
    assert.equal(harness.service.shutdownCalls, 1)
  })

  it("bounds deletion while an aborted creation ignores cancellation", async () => {
    const harness = createHarness(new ControlledSharedService(), { launchSettlementTimeoutMs: 20 })
    harness.service.validationGate = deferred<void>()
    harness.service.ignoreValidationAbort = true
    const creation = harness.manager.create(process.cwd())
    const creationFailure = assert.rejects(creation, WorkspaceLaunchCancelledError)
    await harness.service.validationStarted.promise
    const record = [...(harness.manager as any).workspaces.values()][0]
    const startedAt = Date.now()

    await assert.rejects(harness.manager.delete(record.id), /cleanup did not finish/)
    assert.ok(Date.now() - startedAt < 1000)

    harness.service.validationGate.resolve()
    await creationFailure
    while ((harness.manager as any).workspaces.size) await new Promise((resolve) => setImmediate(resolve))
  })

  it("does not let a timed-out validation mutate canonical location or authorization", async () => {
    const service = new ControlledSharedService()
    service.validationGate = deferred<void>()
    service.ignoreValidationAbort = true
    const validationFinished = deferred<void>()
    service.afterValidation = validationFinished.resolve
    const harness = createHarness(service, { launchTimeoutMs: 20 })
    const creation = harness.manager.create(process.cwd())
    await service.validationStarted.promise
    const record = [...(harness.manager as any).workspaces.values()][0]

    await assert.rejects(creation, /did not finish launching/)
    service.validationGate.resolve()
    await validationFinished.promise
    while ((harness.manager as any).workspaces.size) await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(record.location, { directory: process.cwd() })
    assert.equal(record[Object.getOwnPropertySymbols(record)[0]].locationOwned, false)
    assert.equal((harness.manager as any).serviceAuthorization, undefined)
  })

  it("tracks validation until it settles when the header request fails first", async () => {
    const harness = createHarness()
    const ready = await harness.manager.create(process.cwd())
    harness.service.validationGate = deferred<void>()
    harness.service.headerFailures = 1
    const creation = harness.manager.create(process.cwd())
    const creationFailure = assert.rejects(creation, /header lookup failed/)
    while (harness.service.validationCalls.length < 2) await new Promise((resolve) => setImmediate(resolve))

    const deletion = harness.manager.delete(ready.workspace.id)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(harness.service.evictionCalls.length, 0)

    harness.service.validationGate.resolve()
    await creationFailure
    await deletion
    assert.equal(harness.service.evictionCalls.length, 1)
  })

  it("evicts an isolated validated location when header lookup fails", async () => {
    const harness = createHarness()
    harness.service.headerFailures = 1

    await assert.rejects(harness.manager.create(process.cwd()), /header lookup failed/)

    assert.deepEqual(harness.service.evictionCalls.map(({ location }) => location), [{
      directory: process.cwd(),
      workspaceID: "location-1",
    }])
    assert.equal((harness.manager as any).workspaces.size, 0)
  })

  it("drops an unpublished owner when header lookup and eviction both fail", async () => {
    const harness = createHarness()
    harness.service.headerFailures = 1
    harness.service.evictionFailures = 1

    await assert.rejects(harness.manager.create(process.cwd()), /header lookup failed/)
    assert.equal((harness.manager as any).workspaces.size, 0)

    const replacement = await harness.manager.create(process.cwd())
    await harness.manager.delete(replacement.workspace.id)
    assert.equal(harness.service.evictionCalls.length, 2)
  })

  it("shuts down local workspaces without evicting their OpenCode locations", async () => {
    const harness = createHarness()
    await harness.manager.create(process.cwd())

    await harness.manager.shutdown()

    assert.deepEqual(harness.manager.list(), [])
    assert.equal(harness.service.evictionCalls.length, 0)
    assert.equal(harness.service.shutdownCalls, 1)
    assert.deepEqual(harness.stopped.length, 1)
  })

  it("cancels and removes an in-flight creation without evicting its location", async () => {
    const harness = createHarness()
    harness.service.validationGate = deferred<void>()
    const creation = harness.manager.create(process.cwd())
    await harness.service.validationStarted.promise

    await harness.manager.shutdown()
    await assert.rejects(creation, WorkspaceLaunchCancelledError)

    assert.deepEqual(harness.manager.list(), [])
    assert.equal((harness.manager as any).workspaces.size, 0)
    assert.equal(harness.service.evictionCalls.length, 0)
    assert.equal(harness.service.shutdownCalls, 1)
  })

  it("waits for the underlying launch to settle before completing shutdown", async () => {
    const harness = createHarness()
    harness.service.validationGate = deferred<void>()
    harness.service.ignoreValidationAbort = true
    const lifecycleEvents: string[] = []
    harness.eventBus.on("workspace.created", () => lifecycleEvents.push("created"))
    harness.eventBus.on("workspace.started", () => lifecycleEvents.push("started"))
    const creation = harness.manager.create(process.cwd())
    const creationFailure = assert.rejects(creation, WorkspaceLaunchCancelledError)
    await harness.service.validationStarted.promise
    const record = [...(harness.manager as any).workspaces.values()][0]
    let shutdownSettled = false

    const shutdown = harness.manager.shutdown().then(() => { shutdownSettled = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(shutdownSettled, false)
    harness.service.validationGate.resolve()
    await shutdown
    await creationFailure

    assert.deepEqual(record.location, { directory: process.cwd() })
    assert.equal(record[Object.getOwnPropertySymbols(record)[0]].locationOwned, false)
    assert.deepEqual(lifecycleEvents, [])
    assert.equal(harness.service.evictionCalls.length, 0)
    assert.equal((harness.manager as any).workspaces.size, 0)
  })

  it("prevents a launch completing after bounded shutdown from mutating its removed record", async () => {
    const service = new ControlledSharedService()
    service.validationGate = deferred<void>()
    service.ignoreValidationAbort = true
    const validationFinished = deferred<void>()
    service.afterValidation = validationFinished.resolve
    const harness = createHarness(service, { shutdownTimeoutMs: 20 })
    const lifecycleEvents: string[] = []
    harness.eventBus.on("workspace.created", () => lifecycleEvents.push("created"))
    harness.eventBus.on("workspace.started", () => lifecycleEvents.push("started"))
    const creation = harness.manager.create(process.cwd())
    const creationFailure = assert.rejects(creation, WorkspaceLaunchCancelledError)
    await service.validationStarted.promise
    const record = [...(harness.manager as any).workspaces.values()][0]

    await assert.rejects(harness.manager.shutdown(), /Failed to stop 1 workspace during shutdown/)
    assert.equal((harness.manager as any).workspaces.size, 0)
    service.validationGate.resolve()
    await validationFinished.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    await creationFailure

    assert.deepEqual(record.location, { directory: process.cwd() })
    assert.equal(record[Object.getOwnPropertySymbols(record)[0]].locationOwned, false)
    assert.deepEqual(lifecycleEvents, [])
    assert.equal(service.evictionCalls.length, 0)
  })

  it("bounds local adapter shutdown after removing workspace records", async () => {
    const service = new ControlledSharedService()
    service.shutdownGate = deferred<void>()
    const { manager } = createHarness(service, { shutdownTimeoutMs: 20 })
    await manager.create(process.cwd())
    const startedAt = Date.now()

    await assert.rejects(manager.shutdown(), /Failed to stop 1 workspace during shutdown/)

    assert.ok(Date.now() - startedAt < 1000)
    assert.deepEqual(manager.list(), [])
    assert.equal(service.evictionCalls.length, 0)
    assert.equal(service.shutdownCalls, 1)
    assert.ok((service.shutdownTimeouts[0] ?? 0) > 0)
  })

  it("waits for raw eviction cleanup after a deletion timeout", async () => {
    const harness = createHarness(new ControlledSharedService(), {
      launchSettlementTimeoutMs: 20,
      shutdownTimeoutMs: 500,
    })
    const created = await harness.manager.create(process.cwd())
    harness.service.evictionGate = deferred<void>()
    await assert.rejects(harness.manager.delete(created.workspace.id), /cleanup did not finish/)

    let shutdownSettled = false
    const shutdown = harness.manager.shutdown().then(() => { shutdownSettled = true })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(shutdownSettled, false)

    harness.service.evictionGate.resolve()
    await shutdown
    assert.equal(harness.service.evictionCalls.length, 1)
    assert.equal(harness.service.shutdownCalls, 1)
  })

})
